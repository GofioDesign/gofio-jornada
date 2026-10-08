-- =====================================================================
-- GOFIO · 0016 · PROYECTOS
--  - Un proyecto puede ser PROPIO (de la empresa) o AJENO (de un tercero) y tener cliente o no.
--  - Las horas se imputan a un proyecto igual que a un cliente: con ENTRADA o CAMBIO_CLIENTE
--    (también a posteriori con asignar_cliente). Si el proyecto tiene cliente, las horas
--    van también a ese cliente, así se facturan como hasta ahora.
--  - Un proyecto con horas no se borra (el registro horario no se modifica): se cierra.
-- =====================================================================

create table public.proyectos (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizaciones(id) on delete cascade,
  nombre         text not null check (trim(nombre) <> ''),
  tipo           text not null default 'PROPIO' check (tipo in ('PROPIO', 'AJENO')),
  cliente_id     uuid references public.clientes(id) on delete restrict,
  notas          text,
  activo         boolean not null default true,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index on public.proyectos (org_id, nombre);
create trigger proyectos_upd before update on public.proyectos for each row execute function public.tocar_actualizado();

-- El cliente de un proyecto tiene que ser de la misma empresa
create or replace function public.proyectos_cliente_misma_org() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.cliente_id is not null and not exists (select 1 from clientes where id = new.cliente_id and org_id = new.org_id) then
    raise exception 'El cliente no es de esta empresa';
  end if;
  return new;
end $$;
create trigger proyectos_cliente before insert or update on public.proyectos
  for each row execute function public.proyectos_cliente_misma_org();
revoke execute on function public.proyectos_cliente_misma_org() from public, anon;

-- Igual que los clientes: los ve cualquier miembro; los crean/editan propietario, admin y responsable.
alter table public.proyectos enable row level security;
create policy proyectos_sel on public.proyectos for select using (public.es_miembro(org_id));
create policy proyectos_ins on public.proyectos for insert with check (public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[]));
create policy proyectos_upd on public.proyectos for update using (public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[]))
  with check (public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[]));
create policy proyectos_del on public.proyectos for delete using (public.puede_gestionar(org_id));

-- ---------- Proyecto en los fichajes ----------
alter table public.fichajes add column proyecto_id uuid references public.proyectos(id) on delete restrict;
create index on public.fichajes (proyecto_id) where proyecto_id is not null;

-- Valida el proyecto y devuelve el cliente que corresponde (el del proyecto si lo tiene)
create or replace function public._cliente_de_proyecto(p_org uuid, p_proyecto uuid, p_cliente uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v proyectos;
begin
  select * into v from proyectos where id = p_proyecto and org_id = p_org;
  if not found then raise exception 'Proyecto no encontrado'; end if;
  if not v.activo then raise exception 'El proyecto «%» está cerrado', v.nombre; end if;
  if v.cliente_id is not null and p_cliente is not null and p_cliente <> v.cliente_id then
    raise exception 'El proyecto «%» es de otro cliente', v.nombre;
  end if;
  return coalesce(v.cliente_id, p_cliente);
end $$;
revoke execute on function public._cliente_de_proyecto(uuid, uuid, uuid) from public, anon, authenticated;

-- Se cambia la firma: se borran las versiones anteriores para que no haya dos funciones con el mismo nombre
drop function public._insertar_fichaje(uuid, uuid, public.tipo_fichaje, double precision, double precision, real, uuid, text, text, timestamptz, uuid, text, text);
create or replace function public._insertar_fichaje(
  p_org uuid, p_user uuid, p_tipo tipo_fichaje, p_lat double precision, p_lng double precision, p_prec real,
  p_cliente uuid, p_nota text, p_origen text default 'APP', p_declarado timestamptz default null,
  p_corrige uuid default null, p_motivo text default null, p_estado text default null, p_proyecto uuid default null)
returns public.fichajes language plpgsql security definer set search_path = public, extensions as $$
declare v_prev text; v_row fichajes; v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('fichaje:' || p_org || ':' || p_user));
  select huella into v_prev from fichajes where org_id = p_org and user_id = p_user order by momento desc, id desc limit 1;
  insert into fichajes (org_id, user_id, tipo, momento, lat, lng, precision_m, cliente_id, proyecto_id, nota, origen,
                        momento_declarado, corrige_a, motivo, estado, registrado_por, huella_anterior, huella)
  values (p_org, p_user, p_tipo, v_now, p_lat, p_lng, p_prec, p_cliente, p_proyecto, p_nota, p_origen,
          p_declarado, p_corrige, p_motivo, p_estado, coalesce(auth.uid(), p_user), v_prev,
          encode(digest(concat_ws('|', coalesce(v_prev, ''), p_org, p_user, p_tipo,
                   to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                   coalesce(p_lat::text, ''), coalesce(p_lng::text, ''), coalesce(p_cliente::text, ''),
                   p_origen, coalesce(to_char(p_declarado at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
                   p_proyecto::text), 'sha256'), 'hex'))   -- concat_ws omite el NULL: sin proyecto, la huella es la de siempre
  returning * into v_row;
  return v_row;
end $$;
revoke execute on function public._insertar_fichaje from public, anon, authenticated;

drop function public.fichar(uuid, public.tipo_fichaje, double precision, double precision, real, uuid, text);
create or replace function public.fichar(
  p_org uuid, p_tipo public.tipo_fichaje,
  p_lat double precision default null, p_lng double precision default null, p_precision real default null,
  p_cliente uuid default null, p_nota text default null, p_proyecto uuid default null)
returns setof public.fichajes language plpgsql security definer set search_path = public as $$
declare e record; v_uid uuid := auth.uid();
begin
  if v_uid is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  if not modulo_activo(p_org, 'jornada') then raise exception 'El módulo de jornada no está activo' using hint = 'LIMITE_PLAN'; end if;
  -- El proyecto solo se indica al empezar a trabajar en algo (ENTRADA o CAMBIO_CLIENTE)
  if p_proyecto is not null then
    if p_tipo not in ('ENTRADA', 'CAMBIO_CLIENTE') then p_proyecto := null;
    else p_cliente := _cliente_de_proyecto(p_org, p_proyecto, p_cliente);
    end if;
  end if;
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
    if p_cliente is null and p_proyecto is null then raise exception 'Elige un cliente o un proyecto'; end if;
  end if;

  return next _insertar_fichaje(p_org, v_uid, p_tipo, p_lat, p_lng, p_precision, p_cliente, p_nota,
                                p_proyecto => p_proyecto);
end $$;
revoke execute on function public.fichar(uuid, public.tipo_fichaje, double precision, double precision, real, uuid, text, uuid) from public, anon;

drop function public.tramos_jornada(uuid, date, date, uuid);
create or replace function public.tramos_jornada(p_org uuid, p_desde date, p_hasta date, p_user uuid default null)
returns table (user_id uuid, dia date, tipo text, cliente_id uuid, proyecto_id uuid, inicio timestamptz, fin timestamptz, minutos int, km numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  r record; cur_user uuid; cur_dia date; st text; seg_ini timestamptz; seg_cli uuid; cli uuid; seg_pro uuid; pro uuid;
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
      cur_user := r.user_id; cur_dia := r.d; st := 'FUERA'; seg_ini := null; cli := null; pro := null; d_ini := null;
    end if;
    user_id := r.user_id; dia := r.d; km := null;
    -- cerrar el tramo abierto si el evento lo corta
    if seg_ini is not null and r.tipo in ('PAUSA','REANUDAR','SALIDA','CAMBIO_CLIENTE','ENTRADA')
       or (seg_ini is not null and r.tipo = 'DESPLAZAMIENTO_FIN' and r.cliente_id is distinct from seg_cli) then
      tipo := case when st = 'PAUSA' then 'PAUSA' else 'TRABAJO' end; cliente_id := seg_cli;
      proyecto_id := case when st = 'PAUSA' then null else seg_pro end;
      inicio := seg_ini; fin := r.m; minutos := extract(epoch from r.m - seg_ini)::int / 60;
      if minutos > 0 then return next; end if;
      seg_ini := null;
    end if;
    case r.tipo
      when 'ENTRADA'  then st := 'TRABAJANDO'; cli := r.cliente_id; pro := r.proyecto_id; seg_ini := r.m; seg_cli := cli; seg_pro := pro;
      when 'PAUSA'    then st := 'PAUSA'; seg_ini := r.m; seg_cli := null; seg_pro := null;
      when 'REANUDAR' then st := 'TRABAJANDO'; cli := coalesce(r.cliente_id, cli); seg_ini := r.m; seg_cli := cli; seg_pro := pro;
      when 'CAMBIO_CLIENTE' then cli := r.cliente_id; pro := r.proyecto_id; seg_ini := r.m; seg_cli := cli; seg_pro := pro;
      when 'SALIDA'   then st := 'FUERA';
      when 'DESPLAZAMIENTO_INICIO' then d_ini := r.m; d_cli := r.cliente_id; d_lat := r.lat; d_lng := r.lng;
      when 'DESPLAZAMIENTO_FIN' then
        if d_ini is not null then
          tipo := 'DESPLAZAMIENTO'; cliente_id := coalesce(r.cliente_id, d_cli); proyecto_id := null; inicio := d_ini; fin := r.m;
          minutos := extract(epoch from r.m - d_ini)::int / 60;
          km := case when d_lat is not null and r.lat is not null then round((6371 * 2 * asin(sqrt(
                  power(sin(radians(r.lat - d_lat) / 2), 2) +
                  cos(radians(d_lat)) * cos(radians(r.lat)) * power(sin(radians(r.lng - d_lng) / 2), 2))))::numeric, 2) end;
          return next;
          d_ini := null;
        end if;
        if st = 'TRABAJANDO' and coalesce(r.cliente_id, d_cli) is distinct from seg_cli then
          -- al llegar a otro cliente se deja el proyecto anterior
          cli := coalesce(r.cliente_id, d_cli); pro := null; seg_ini := r.m; seg_cli := cli; seg_pro := null;
        end if;
    end case;
  end loop;
  -- tramo abierto de hoy: hasta ahora
  if seg_ini is not null and st = 'TRABAJANDO' and cur_dia = (now() at time zone tz)::date then
    tipo := 'TRABAJO'; cliente_id := seg_cli; proyecto_id := seg_pro; inicio := seg_ini; fin := null; km := null;
    minutos := extract(epoch from now() - seg_ini)::int / 60; return next;
  end if;
end $$;
revoke execute on function public.tramos_jornada(uuid, date, date, uuid) from public, anon;

drop function public.asignar_cliente(uuid, timestamptz, uuid, uuid);
create or replace function public.asignar_cliente(
  p_org uuid, p_momento timestamptz, p_cliente uuid, p_user uuid default null, p_proyecto uuid default null)
returns public.fichajes language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_resp boolean; v_tz text; v_dia date;
begin
  if v_uid is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  p_user := coalesce(p_user, v_uid);
  v_resp := tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]);
  if p_user <> v_uid and not v_resp then raise exception 'Sin permiso'; end if;
  if not exists (select 1 from miembros where org_id = p_org and user_id = p_user) then
    raise exception 'Usuario no pertenece a la empresa';
  end if;
  if p_proyecto is not null then p_cliente := _cliente_de_proyecto(p_org, p_proyecto, p_cliente); end if;
  if p_cliente is null and p_proyecto is null then raise exception 'Elige un cliente o un proyecto'; end if;
  if p_cliente is not null and not exists (select 1 from clientes where id = p_cliente and org_id = p_org) then
    raise exception 'Elige un cliente';
  end if;
  if p_momento is null or p_momento > now() then raise exception 'No se puede asignar una hora futura'; end if;

  select coalesce(config->>'zona_horaria', 'Atlantic/Canary') into v_tz from organizaciones where id = p_org;
  v_dia := (p_momento at time zone v_tz)::date;
  if not exists (select 1 from tramos_jornada(p_org, v_dia, v_dia, p_user) t
                 where t.tipo = 'TRABAJO' and p_momento >= t.inicio and p_momento < coalesce(t.fin, now())) then
    raise exception 'A esa hora no hay trabajo fichado';
  end if;
  if exists (select 1 from horas_facturadas h where h.org_id = p_org and h.user_id = p_user
             and h.dia = v_dia and h.tipo = 'TRABAJO') then
    raise exception 'Las horas de ese día ya están facturadas; no se puede cambiar el cliente';
  end if;

  if v_resp then
    return _insertar_fichaje(p_org, p_user, 'CAMBIO_CLIENTE', null, null, null, p_cliente, null,
                             'RESPONSABLE', p_momento, null, 'Cliente asignado a posteriori', 'APROBADA', p_proyecto);
  end if;
  return _insertar_fichaje(p_org, p_user, 'CAMBIO_CLIENTE', null, null, null, p_cliente, null,
                           'CORRECCION', p_momento, null, 'Cliente asignado a posteriori', 'PENDIENTE', p_proyecto);
end $$;
revoke execute on function public.asignar_cliente(uuid, timestamptz, uuid, uuid, uuid) from public, anon;
