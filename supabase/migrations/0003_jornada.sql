-- =====================================================================
-- GOFIO · 0003 · Módulo JORNADA: registro horario y desplazamientos
--  - Registro de solo-anotación: nadie (ni el propietario) puede editar ni borrar un fichaje.
--  - La hora la pone el SERVIDOR (no el móvil), así no se puede manipular.
--  - Cada fichaje se encadena con el anterior del mismo usuario (huella SHA-256).
--  - Los errores se corrigen con una CORRECCIÓN que revisa un responsable; el original se conserva.
--  - Conservación mínima legal: 4 años (art. 34.9 ET). No hay borrado.
-- =====================================================================

create type public.tipo_fichaje as enum
  ('ENTRADA', 'PAUSA', 'REANUDAR', 'SALIDA', 'DESPLAZAMIENTO_INICIO', 'DESPLAZAMIENTO_FIN', 'CAMBIO_CLIENTE');
-- cliente_id en ENTRADA / REANUDAR / CAMBIO_CLIENTE / DESPLAZAMIENTO_FIN = cliente para el que se trabaja desde ese momento.
-- cliente_id en DESPLAZAMIENTO_INICIO = destino del desplazamiento.

create table public.fichajes (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizaciones(id) on delete restrict,
  user_id           uuid not null references auth.users(id) on delete restrict,
  tipo              public.tipo_fichaje not null,
  momento           timestamptz not null default now(),   -- hora de registro (servidor)
  lat               double precision,
  lng               double precision,
  precision_m       real,
  cliente_id        uuid references public.clientes(id) on delete set null,  -- obra / destino
  nota              text,
  origen            text not null default 'APP' check (origen in ('APP', 'CORRECCION', 'RESPONSABLE')),
  -- Solo en correcciones:
  momento_declarado timestamptz,                          -- la hora que debió registrarse
  corrige_a         uuid references public.fichajes(id),
  motivo            text,
  estado            text check (estado in ('PENDIENTE', 'APROBADA', 'RECHAZADA')),
  revisado_por      uuid references auth.users(id),
  revisado_en       timestamptz,
  -- Integridad
  registrado_por    uuid not null default auth.uid() references auth.users(id),
  huella_anterior   text,
  huella            text not null,
  constraint correccion_completa check (
    origen = 'APP' or (momento_declarado is not null and motivo is not null and estado is not null))
);
create index on public.fichajes (org_id, user_id, momento);
create index on public.fichajes (org_id, momento);

-- Momento efectivo: el declarado en correcciones aprobadas, el real en el resto
create or replace function public.momento_efectivo(f public.fichajes) returns timestamptz
language sql immutable as $$ select coalesce(f.momento_declarado, f.momento) $$;

-- ---------- Inmutabilidad ----------
create or replace function public.fichajes_inmutables() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Los fichajes no se pueden borrar (registro legal). Usa una corrección.';
  end if;
  -- Solo se permite resolver una corrección pendiente
  if old.estado = 'PENDIENTE' and new.estado in ('APROBADA', 'RECHAZADA')
     and (to_jsonb(new) - 'estado' - 'revisado_por' - 'revisado_en') = (to_jsonb(old) - 'estado' - 'revisado_por' - 'revisado_en') then
    return new;
  end if;
  raise exception 'Los fichajes no se pueden modificar (registro legal). Usa una corrección.';
end $$;
create trigger fichajes_no_update before update or delete on public.fichajes
  for each row execute function public.fichajes_inmutables();

-- ---------- Estado actual de un usuario ----------
-- Devuelve 'FUERA' | 'TRABAJANDO' | 'PAUSA' y si hay un desplazamiento abierto
create or replace function public.estado_jornada(p_org uuid, p_user uuid default auth.uid())
returns table (estado text, desde timestamptz, desplazamiento_abierto boolean, desplazamiento_desde timestamptz, cliente_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare v_last fichajes; v_desp fichajes;
begin
  if p_user <> auth.uid() and not tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]) then
    raise exception 'Sin permiso';
  end if;
  select * into v_last from fichajes f
   where f.org_id = p_org and f.user_id = p_user and f.origen = 'APP'
     and f.tipo in ('ENTRADA','PAUSA','REANUDAR','SALIDA')
   order by f.momento desc limit 1;
  select * into v_desp from fichajes f
   where f.org_id = p_org and f.user_id = p_user and f.origen = 'APP'
     and f.tipo in ('DESPLAZAMIENTO_INICIO','DESPLAZAMIENTO_FIN')
   order by f.momento desc limit 1;
  estado := case when v_last.tipo is null or v_last.tipo = 'SALIDA' then 'FUERA'
                 when v_last.tipo = 'PAUSA' then 'PAUSA'
                 else 'TRABAJANDO' end;
  desde := v_last.momento;
  desplazamiento_abierto := coalesce(v_desp.tipo = 'DESPLAZAMIENTO_INICIO', false);
  desplazamiento_desde := case when desplazamiento_abierto then v_desp.momento end;
  cliente_id := case when desplazamiento_abierto then v_desp.cliente_id end;
  return next;
end $$;

-- ---------- Inserción interna con huella encadenada ----------
create or replace function public._insertar_fichaje(
  p_org uuid, p_user uuid, p_tipo tipo_fichaje, p_lat double precision, p_lng double precision, p_prec real,
  p_cliente uuid, p_nota text, p_origen text default 'APP', p_declarado timestamptz default null,
  p_corrige uuid default null, p_motivo text default null, p_estado text default null)
returns public.fichajes language plpgsql security definer set search_path = public, extensions as $$
declare v_prev text; v_row fichajes; v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('fichaje:' || p_org || ':' || p_user));
  select huella into v_prev from fichajes where org_id = p_org and user_id = p_user order by momento desc, id desc limit 1;
  insert into fichajes (org_id, user_id, tipo, momento, lat, lng, precision_m, cliente_id, nota, origen,
                        momento_declarado, corrige_a, motivo, estado, registrado_por, huella_anterior, huella)
  values (p_org, p_user, p_tipo, v_now, p_lat, p_lng, p_prec, p_cliente, p_nota, p_origen,
          p_declarado, p_corrige, p_motivo, p_estado, coalesce(auth.uid(), p_user), v_prev,
          encode(digest(concat_ws('|', coalesce(v_prev, ''), p_org, p_user, p_tipo,
                   to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                   coalesce(p_lat::text, ''), coalesce(p_lng::text, ''), coalesce(p_cliente::text, ''),
                   p_origen, coalesce(to_char(p_declarado at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')), 'sha256'), 'hex'))
  returning * into v_row;
  return v_row;
end $$;
revoke execute on function public._insertar_fichaje from public, anon, authenticated;

-- ---------- FICHAR (lo único que llama la app) ----------
-- Aplica la lógica de estados y abre/cierra lo necesario automáticamente:
--  · Iniciar desplazamiento estando FUERA => registra ENTRADA antes.
--  · SALIDA con desplazamiento abierto => lo cierra antes.
create or replace function public.fichar(
  p_org uuid, p_tipo public.tipo_fichaje,
  p_lat double precision default null, p_lng double precision default null, p_precision real default null,
  p_cliente uuid default null, p_nota text default null)
returns setof public.fichajes language plpgsql security definer set search_path = public as $$
declare e record; v_uid uuid := auth.uid();
begin
  if v_uid is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  if not modulo_activo(p_org, 'jornada') then raise exception 'El módulo de jornada no está activo' using hint = 'LIMITE_PLAN'; end if;
  select * into e from estado_jornada(p_org, v_uid);

  if p_tipo = 'ENTRADA' then
    if e.estado <> 'FUERA' then raise exception 'Ya tienes la jornada iniciada'; end if;
  elsif p_tipo = 'PAUSA' then
    if e.estado <> 'TRABAJANDO' then raise exception 'No estás trabajando ahora mismo'; end if;
  elsif p_tipo = 'REANUDAR' then
    if e.estado <> 'PAUSA' then raise exception 'No estás en pausa'; end if;
  elsif p_tipo = 'SALIDA' then
    if e.estado = 'FUERA' then raise exception 'No has iniciado la jornada'; end if;
    if e.desplazamiento_abierto then
      return next _insertar_fichaje(p_org, v_uid, 'DESPLAZAMIENTO_FIN', p_lat, p_lng, p_precision, e.cliente_id, 'Cerrado al finalizar la jornada');
    end if;
  elsif p_tipo = 'DESPLAZAMIENTO_INICIO' then
    if e.desplazamiento_abierto then raise exception 'Ya hay un desplazamiento en curso'; end if;
    if e.estado = 'FUERA' then
      return next _insertar_fichaje(p_org, v_uid, 'ENTRADA', p_lat, p_lng, p_precision, null, 'Inicio al salir de desplazamiento');
    elsif e.estado = 'PAUSA' then
      return next _insertar_fichaje(p_org, v_uid, 'REANUDAR', p_lat, p_lng, p_precision, null, null);
    end if;
  elsif p_tipo = 'DESPLAZAMIENTO_FIN' then
    if not e.desplazamiento_abierto then raise exception 'No hay ningún desplazamiento en curso'; end if;
    p_cliente := coalesce(p_cliente, e.cliente_id);
  elsif p_tipo = 'CAMBIO_CLIENTE' then
    if e.estado <> 'TRABAJANDO' then raise exception 'Inicia la jornada antes de elegir cliente'; end if;
    if p_cliente is null then raise exception 'Elige un cliente'; end if;
  end if;

  return next _insertar_fichaje(p_org, v_uid, p_tipo, p_lat, p_lng, p_precision, p_cliente, p_nota);
end $$;

-- ---------- Correcciones ----------
-- El empleado pide corregir (olvidó fichar, hora equivocada...). Queda PENDIENTE.
create or replace function public.solicitar_correccion(
  p_org uuid, p_tipo public.tipo_fichaje, p_momento timestamptz, p_motivo text, p_corrige uuid default null)
returns public.fichajes language plpgsql security definer set search_path = public as $$
begin
  if not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indica el motivo de la corrección'; end if;
  if p_momento > now() then raise exception 'No se puede registrar una hora futura'; end if;
  return _insertar_fichaje(p_org, auth.uid(), p_tipo, null, null, null, null, null,
                           'CORRECCION', p_momento, p_corrige, p_motivo, 'PENDIENTE');
end $$;

create or replace function public.revisar_correccion(p_id uuid, p_aprobar boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v fichajes;
begin
  select * into v from fichajes where id = p_id;
  if not found or not tiene_rol(v.org_id, array['propietario','admin','responsable']::rol_miembro[]) then raise exception 'Sin permiso'; end if;
  if v.user_id = auth.uid() and not tiene_rol(v.org_id, array['propietario']::rol_miembro[]) then
    raise exception 'No puedes aprobar tus propias correcciones';
  end if;
  update fichajes set estado = case when p_aprobar then 'APROBADA' else 'RECHAZADA' end,
                      revisado_por = auth.uid(), revisado_en = now()
   where id = p_id and estado = 'PENDIENTE';
end $$;

-- Un responsable registra un fichaje en nombre de un empleado (queda marcado y aprobado)
create or replace function public.fichaje_por_responsable(
  p_org uuid, p_user uuid, p_tipo public.tipo_fichaje, p_momento timestamptz, p_motivo text)
returns public.fichajes language plpgsql security definer set search_path = public as $$
begin
  if not tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]) then raise exception 'Sin permiso'; end if;
  if not exists (select 1 from miembros where org_id = p_org and user_id = p_user) then raise exception 'Usuario no pertenece a la empresa'; end if;
  return _insertar_fichaje(p_org, p_user, p_tipo, null, null, null, null, null,
                           'RESPONSABLE', p_momento, null, p_motivo, 'APROBADA');
end $$;

-- ---------- Resumen diario (para pantalla, informes e Inspección) ----------
-- Usa los fichajes de la app + correcciones APROBADAS, ordenados por momento efectivo.
create or replace function public.resumen_jornada(p_org uuid, p_desde date, p_hasta date, p_user uuid default null)
returns table (user_id uuid, nombre text, dia date, primera_entrada timestamptz, ultima_salida timestamptz,
               minutos_trabajo int, minutos_pausa int, minutos_desplazamiento int, km_linea_recta numeric,
               abierta boolean, correcciones int)
language plpgsql stable security definer set search_path = public as $$
declare
  r record; cur_user uuid; cur_dia date; st text; t_ini timestamptz; p_ini timestamptz; d_ini timestamptz;
  d_lat double precision; d_lng double precision; tz text;
begin
  if not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  select coalesce(config->>'zona_horaria', 'Atlantic/Canary') into tz from organizaciones where id = p_org;
  if (p_user is null or p_user <> auth.uid()) and not tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]) then
    p_user := auth.uid();   -- un empleado solo ve lo suyo
  end if;
  for r in
    select f.*, coalesce(f.momento_declarado, f.momento) as m,
           (coalesce(f.momento_declarado, f.momento) at time zone tz)::date as d
    from fichajes f
    where f.org_id = p_org and (p_user is null or f.user_id = p_user)
      and (f.origen = 'APP' or f.estado = 'APROBADA')
      and (coalesce(f.momento_declarado, f.momento) at time zone tz)::date between p_desde and p_hasta
    order by f.user_id, coalesce(f.momento_declarado, f.momento), f.momento
  loop
    if cur_user is distinct from r.user_id or cur_dia is distinct from r.d then
      if cur_user is not null then
        abierta := st in ('TRABAJANDO','PAUSA'); return next;
      end if;
      cur_user := r.user_id; cur_dia := r.d; st := 'FUERA'; t_ini := null; p_ini := null; d_ini := null;
      user_id := r.user_id; dia := r.d; primera_entrada := null; ultima_salida := null;
      minutos_trabajo := 0; minutos_pausa := 0; minutos_desplazamiento := 0; km_linea_recta := 0; correcciones := 0;
      select m.nombre into nombre from miembros m where m.org_id = p_org and m.user_id = r.user_id;
    end if;
    if r.origen <> 'APP' then correcciones := correcciones + 1; end if;
    case r.tipo
      when 'ENTRADA' then
        if st = 'FUERA' then st := 'TRABAJANDO'; t_ini := r.m; primera_entrada := coalesce(primera_entrada, r.m); end if;
      when 'PAUSA' then
        if st = 'TRABAJANDO' then minutos_trabajo := minutos_trabajo + extract(epoch from r.m - t_ini)::int / 60; st := 'PAUSA'; p_ini := r.m; end if;
      when 'REANUDAR' then
        if st = 'PAUSA' then minutos_pausa := minutos_pausa + extract(epoch from r.m - p_ini)::int / 60; st := 'TRABAJANDO'; t_ini := r.m; end if;
      when 'SALIDA' then
        if st = 'TRABAJANDO' then minutos_trabajo := minutos_trabajo + extract(epoch from r.m - t_ini)::int / 60;
        elsif st = 'PAUSA' then minutos_pausa := minutos_pausa + extract(epoch from r.m - p_ini)::int / 60; end if;
        st := 'FUERA'; ultima_salida := r.m;
      when 'CAMBIO_CLIENTE' then null;
      when 'DESPLAZAMIENTO_INICIO' then d_ini := r.m; d_lat := r.lat; d_lng := r.lng;
      when 'DESPLAZAMIENTO_FIN' then
        if d_ini is not null then
          minutos_desplazamiento := minutos_desplazamiento + extract(epoch from r.m - d_ini)::int / 60;
          if d_lat is not null and r.lat is not null then
            km_linea_recta := km_linea_recta + round((6371 * 2 * asin(sqrt(
              power(sin(radians(r.lat - d_lat) / 2), 2) +
              cos(radians(d_lat)) * cos(radians(r.lat)) * power(sin(radians(r.lng - d_lng) / 2), 2))))::numeric, 2);
          end if;
          d_ini := null;
        end if;
    end case;
  end loop;
  if cur_user is not null then
    -- Jornada todavía abierta hoy: cuenta hasta ahora
    if st = 'TRABAJANDO' and cur_dia = (now() at time zone tz)::date then
      minutos_trabajo := minutos_trabajo + extract(epoch from now() - t_ini)::int / 60;
    end if;
    abierta := st in ('TRABAJANDO','PAUSA'); return next;
  end if;
end $$;


-- ---------- Tramos de la jornada (base para informes y para FACTURAR horas por cliente) ----------
-- Convierte los fichajes en tramos continuos: TRABAJO (por cliente), PAUSA y DESPLAZAMIENTO (hacia un cliente).
-- Los desplazamientos van dentro del tiempo de trabajo; se listan aparte para poder facturarlos.
create or replace function public.tramos_jornada(p_org uuid, p_desde date, p_hasta date, p_user uuid default null)
returns table (user_id uuid, dia date, tipo text, cliente_id uuid, inicio timestamptz, fin timestamptz, minutos int, km numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  r record; cur_user uuid; cur_dia date; st text; seg_ini timestamptz; seg_cli uuid; cli uuid;
  d_ini timestamptz; d_cli uuid; d_lat double precision; d_lng double precision; tz text;
begin
  if not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  if (p_user is null or p_user <> auth.uid()) and not tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]) then
    p_user := auth.uid();
  end if;
  select coalesce(config->>'zona_horaria', 'Atlantic/Canary') into tz from organizaciones where id = p_org;
  for r in
    select f.*, coalesce(f.momento_declarado, f.momento) as m,
           (coalesce(f.momento_declarado, f.momento) at time zone tz)::date as d
    from fichajes f
    where f.org_id = p_org and (p_user is null or f.user_id = p_user)
      and (f.origen = 'APP' or f.estado = 'APROBADA')
      and (coalesce(f.momento_declarado, f.momento) at time zone tz)::date between p_desde and p_hasta
    order by f.user_id, coalesce(f.momento_declarado, f.momento), f.momento
  loop
    if cur_user is distinct from r.user_id or cur_dia is distinct from r.d then
      cur_user := r.user_id; cur_dia := r.d; st := 'FUERA'; seg_ini := null; cli := null; d_ini := null;
    end if;
    user_id := r.user_id; dia := r.d; km := null;
    -- cerrar el tramo abierto si el evento lo corta
    if seg_ini is not null and r.tipo in ('PAUSA','REANUDAR','SALIDA','CAMBIO_CLIENTE','ENTRADA')
       or (seg_ini is not null and r.tipo = 'DESPLAZAMIENTO_FIN' and r.cliente_id is distinct from seg_cli) then
      tipo := case when st = 'PAUSA' then 'PAUSA' else 'TRABAJO' end; cliente_id := seg_cli;
      inicio := seg_ini; fin := r.m; minutos := extract(epoch from r.m - seg_ini)::int / 60;
      if minutos > 0 then return next; end if;
      seg_ini := null;
    end if;
    case r.tipo
      when 'ENTRADA'  then st := 'TRABAJANDO'; cli := r.cliente_id; seg_ini := r.m; seg_cli := cli;
      when 'PAUSA'    then st := 'PAUSA'; seg_ini := r.m; seg_cli := null;
      when 'REANUDAR' then st := 'TRABAJANDO'; cli := coalesce(r.cliente_id, cli); seg_ini := r.m; seg_cli := cli;
      when 'CAMBIO_CLIENTE' then cli := r.cliente_id; seg_ini := r.m; seg_cli := cli;
      when 'SALIDA'   then st := 'FUERA';
      when 'DESPLAZAMIENTO_INICIO' then d_ini := r.m; d_cli := r.cliente_id; d_lat := r.lat; d_lng := r.lng;
      when 'DESPLAZAMIENTO_FIN' then
        if d_ini is not null then
          tipo := 'DESPLAZAMIENTO'; cliente_id := coalesce(r.cliente_id, d_cli); inicio := d_ini; fin := r.m;
          minutos := extract(epoch from r.m - d_ini)::int / 60;
          km := case when d_lat is not null and r.lat is not null then round((6371 * 2 * asin(sqrt(
                  power(sin(radians(r.lat - d_lat) / 2), 2) +
                  cos(radians(d_lat)) * cos(radians(r.lat)) * power(sin(radians(r.lng - d_lng) / 2), 2))))::numeric, 2) end;
          return next;
          d_ini := null;
        end if;
        if st = 'TRABAJANDO' and coalesce(r.cliente_id, d_cli) is distinct from seg_cli then
          cli := coalesce(r.cliente_id, d_cli); seg_ini := r.m; seg_cli := cli;
        end if;
    end case;
  end loop;
  -- tramo abierto de hoy: hasta ahora
  if seg_ini is not null and st = 'TRABAJANDO' and cur_dia = (now() at time zone tz)::date then
    tipo := 'TRABAJO'; cliente_id := seg_cli; inicio := seg_ini; fin := null; km := null;
    minutos := extract(epoch from now() - seg_ini)::int / 60; return next;
  end if;
end $$;

-- ---------- RLS ----------
alter table public.fichajes enable row level security;
-- Cada uno ve los suyos; responsables/admin/propietario ven los de toda la empresa.
create policy fichajes_sel on public.fichajes for select using (
  public.es_miembro(org_id) and (user_id = auth.uid()
    or public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])));
-- Sin políticas de insert/update/delete: solo a través de las funciones de arriba.
