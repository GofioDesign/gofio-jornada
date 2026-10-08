-- =====================================================================
-- GOFIO · 0017 · Marcar fichajes como error (pruebas, duplicados...)
--  - El fichaje original NO se borra ni se modifica: se anota en fichajes_anulados
--    con el motivo, quién y cuándo. Esa anotación tampoco se puede cambiar ni borrar.
--  - Los fichajes anulados dejan de contar en el estado, los tramos y el resumen
--    (y por tanto en informes, proyectos y facturación). Siguen en la copia.
--  - Solo propietario, admin y responsable. No se anulan días ya facturados.
-- =====================================================================

create table public.fichajes_anulados (
  fichaje_id  uuid primary key references public.fichajes(id) on delete restrict,
  org_id      uuid not null references public.organizaciones(id) on delete cascade,
  motivo      text not null check (trim(motivo) <> ''),
  anulado_por uuid not null default auth.uid() references auth.users(id),
  anulado_en  timestamptz not null default now()
);
create index on public.fichajes_anulados (org_id);

create or replace function public.anulaciones_inmutables() returns trigger language plpgsql as $$
begin
  raise exception 'Una anulación no se puede modificar ni borrar (registro legal).';
end $$;
create trigger fichajes_anulados_inmutables before update or delete on public.fichajes_anulados
  for each row execute function public.anulaciones_inmutables();
revoke execute on function public.anulaciones_inmutables() from public, anon;

-- Se ven igual que los fichajes: los propios, o todos si eres responsable. Se crean solo con anular_fichajes.
alter table public.fichajes_anulados enable row level security;
create policy fichajes_anulados_sel on public.fichajes_anulados for select using (
  public.es_miembro(org_id) and (
    public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])
    or exists (select 1 from public.fichajes f where f.id = fichaje_id and f.user_id = auth.uid())));

create or replace function public.anular_fichajes(p_org uuid, p_ids uuid[], p_motivo text)
returns int language plpgsql security definer set search_path = public as $$
declare v_tz text; n int;
begin
  if auth.uid() is null or not tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]) then
    raise exception 'Sin permiso';
  end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indica el motivo'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception 'Elige algún fichaje'; end if;
  if exists (select 1 from unnest(p_ids) i where not exists (select 1 from fichajes f where f.id = i and f.org_id = p_org)) then
    raise exception 'Fichaje no encontrado';
  end if;
  select coalesce(config->>'zona_horaria', 'Atlantic/Canary') into v_tz from organizaciones where id = p_org;
  if exists (select 1 from fichajes f join horas_facturadas h
               on h.org_id = f.org_id and h.user_id = f.user_id
              and h.dia = (coalesce(f.momento_declarado, f.momento) at time zone v_tz)::date
             where f.id = any(p_ids)) then
    raise exception 'Ese día ya está facturado; no se pueden anular sus fichajes';
  end if;
  insert into fichajes_anulados (fichaje_id, org_id, motivo)
  select f.id, p_org, trim(p_motivo) from fichajes f
   where f.id = any(p_ids) and not exists (select 1 from fichajes_anulados a where a.fichaje_id = f.id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.anular_fichajes(uuid, uuid[], text) from public, anon;

-- ---------- Los anulados dejan de contar ----------
create or replace function public.estado_jornada(p_org uuid, p_user uuid default auth.uid())
returns table (estado text, desde timestamptz, desplazamiento_abierto boolean, desplazamiento_desde timestamptz, cliente_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare v_last fichajes; v_desp fichajes;
begin
  if auth.uid() is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  if p_user is distinct from auth.uid()
     and not tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]) then
    raise exception 'Sin permiso';
  end if;
  select * into v_last from fichajes f
   where f.org_id = p_org and f.user_id = p_user and f.origen = 'APP' and not exists (select 1 from fichajes_anulados a where a.fichaje_id = f.id)
     and f.tipo in ('ENTRADA','PAUSA','REANUDAR','SALIDA')
   order by f.momento desc limit 1;
  select * into v_desp from fichajes f
   where f.org_id = p_org and f.user_id = p_user and f.origen = 'APP' and not exists (select 1 from fichajes_anulados a where a.fichaje_id = f.id)
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
revoke execute on function public.estado_jornada(uuid, uuid) from public, anon;

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
      and not exists (select 1 from fichajes_anulados a where a.fichaje_id = f.id)
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
    if r.origen <> 'APP' and r.tipo <> 'CAMBIO_CLIENTE' then correcciones := correcciones + 1; end if;
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
      and not exists (select 1 from fichajes_anulados a where a.fichaje_id = f.id)
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

create or replace function public.copia_jornada(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    -- Sin usuario: solo la Edge Function (service role) o la consola SQL (que no entra por la API)
    if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and session_user = 'authenticator' then
      raise exception 'Sin permiso';
    end if;
  elsif not puede_gestionar(p_org) then
    raise exception 'Sin permiso';
  end if;
  return jsonb_build_object(
    'formato', 'gofio-jornada/1',
    'generada', now(),
    'empresa', (select to_jsonb(o) - 'config' from organizaciones o where o.id = p_org),
    'miembros', (select coalesce(jsonb_agg(to_jsonb(m) order by m.nombre), '[]') from miembros m where m.org_id = p_org),
    'clientes', (select coalesce(jsonb_agg(to_jsonb(c) order by c.nombre), '[]') from clientes c where c.org_id = p_org),
    'fichajes', (select coalesce(jsonb_agg(to_jsonb(f) order by f.momento), '[]') from fichajes f where f.org_id = p_org),
    'proyectos', (select coalesce(jsonb_agg(to_jsonb(p) order by p.nombre), '[]') from proyectos p where p.org_id = p_org),
    'anulaciones', (select coalesce(jsonb_agg(to_jsonb(a) order by a.anulado_en), '[]') from fichajes_anulados a where a.org_id = p_org)
  );
end $$;
revoke execute on function public.copia_jornada(uuid) from public, anon;
