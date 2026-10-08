-- =====================================================================
-- GOFIO · 0023 · Acceso de solo lectura por API (claves por empresa)
--  - api_claves: claves que crea el propietario en Ajustes. Solo se guarda su huella
--    (sha256); la clave entera se muestra una única vez al crearla.
--  - api_horarios / api_resumen / api_facturas: se llaman sin iniciar sesión, con la
--    clave como parámetro, desde la API REST de Supabase:
--      GET https://<proyecto>.supabase.co/rest/v1/rpc/api_horarios?clave=gj_…&desde=2026-10-01&hasta=2026-10-31
--      (cabecera apikey: la clave pública anon de la app)
--    Cada llamada actúa con los permisos actuales de quien creó la clave: si deja la
--    empresa o pierde el rol, la clave deja de servir. Solo leen; nunca escriben.
-- =====================================================================

begin;

create table public.api_claves (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizaciones(id) on delete cascade,
  nombre      text not null,
  prefijo     text not null,             -- primeros caracteres, para reconocerla en la lista
  huella      text not null unique,      -- sha256 de la clave
  creada_por  uuid not null references auth.users(id),
  creada_en   timestamptz not null default now(),
  revocada_en timestamptz
);
alter table public.api_claves enable row level security;
create policy api_claves_sel on public.api_claves for select using (public.tiene_rol(org_id, array['propietario']::public.rol_miembro[]));
revoke insert, update, delete on public.api_claves from authenticated, anon;

-- Devuelve la clave entera (única vez que se puede ver)
create or replace function public.crear_clave_api(p_org uuid, p_nombre text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_clave text := 'gj_' || encode(gen_random_bytes(24), 'hex');
begin
  if not tiene_rol(p_org, array['propietario']::rol_miembro[]) then raise exception 'Solo el propietario puede crear claves de API'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'Ponle un nombre a la clave (p. ej. «Hoja de horarios»)'; end if;
  insert into api_claves (org_id, nombre, prefijo, huella, creada_por)
  values (p_org, left(trim(p_nombre), 80), left(v_clave, 9), encode(digest(v_clave, 'sha256'), 'hex'), auth.uid());
  return v_clave;
end $$;

create or replace function public.revocar_clave_api(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from api_claves where id = p_id;
  if v_org is null or not tiene_rol(v_org, array['propietario']::rol_miembro[]) then raise exception 'Sin permiso'; end if;
  update api_claves set revocada_en = coalesce(revocada_en, now()) where id = p_id;
end $$;

-- Comprueba la clave y pasa a actuar como quien la creó (solo durante esta llamada)
create or replace function public.api_entrar(p_clave text, p_desde date, p_hasta date)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare k api_claves;
begin
  select * into k from api_claves where huella = encode(digest(coalesce(p_clave, ''), 'sha256'), 'hex') and revocada_en is null;
  if not found then raise exception 'Clave de API no válida o revocada'; end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde then raise exception 'Indica desde y hasta (AAAA-MM-DD)'; end if;
  if p_hasta - p_desde > 366 then raise exception 'El periodo no puede pasar de un año'; end if;
  perform set_config('request.jwt.claim.sub', k.creada_por::text, true);
  return k.org_id;
end $$;
revoke execute on function public.api_entrar(text, date, date) from public, anon, authenticated;

-- Horarios: un tramo de trabajo, pausa o desplazamiento por fila
create or replace function public.api_horarios(clave text, desde date, hasta date)
returns table (persona text, nif text, fecha date, tipo text, inicio timestamptz, fin timestamptz, minutos int,
               cliente text, proyecto text, km numeric)
language plpgsql security definer set search_path = public as $$
declare v_org uuid := api_entrar(clave, desde, hasta);
begin
  return query
    select m.nombre, m.nif, t.dia, t.tipo, t.inicio, t.fin, t.minutos, c.nombre, p.nombre, t.km
    from tramos_jornada(v_org, desde, hasta) t
    left join miembros m on m.org_id = v_org and m.user_id = t.user_id
    left join clientes c on c.id = t.cliente_id
    left join proyectos p on p.id = t.proyecto_id
    order by m.nombre, t.dia, t.inicio;
end $$;

-- Registro de jornada: una fila por persona y día
create or replace function public.api_resumen(clave text, desde date, hasta date)
returns table (persona text, nif text, fecha date, primera_entrada timestamptz, ultima_salida timestamptz,
               minutos_trabajo int, minutos_pausa int, minutos_desplazamiento int, km numeric, abierta boolean, correcciones int)
language plpgsql security definer set search_path = public as $$
declare v_org uuid := api_entrar(clave, desde, hasta);
begin
  return query
    select r.nombre, m.nif, r.dia, r.primera_entrada, r.ultima_salida, r.minutos_trabajo, r.minutos_pausa,
           r.minutos_desplazamiento, r.km_linea_recta, r.abierta, r.correcciones
    from resumen_jornada(v_org, desde, hasta) r
    left join miembros m on m.org_id = v_org and m.user_id = r.user_id
    order by r.nombre, r.dia;
end $$;

-- Facturas emitidas en el periodo (si la empresa usa facturación y quien creó la clave puede verla)
create or replace function public.api_facturas(clave text, desde date, hasta date)
returns table (num text, fecha date, vencimiento date, cliente text, nif_cliente text, concepto text, base numeric, igic numeric,
               irpf numeric, total numeric, cobrado numeric, pendiente numeric, estado text)
language plpgsql security definer set search_path = public as $$
declare v_org uuid := api_entrar(clave, desde, hasta);
begin
  if not puede_ver_facturacion(v_org) then raise exception 'Sin permiso para ver la facturación'; end if;
  return query
    select f.num, f.fecha, f.vencimiento, f.cliente->>'nombre', f.cliente_codigo, f.concepto, f.base, f.igic,
           f.irpf, f.total, f.cobrado, f.pendiente, f.estado_cobro
    from v_facturas f
    where f.org_id = v_org and f.fecha between desde and hasta
    order by f.fecha, f.num;
end $$;

revoke execute on function public.crear_clave_api(uuid, text), public.revocar_clave_api(uuid) from public, anon;
grant execute on function public.crear_clave_api(uuid, text), public.revocar_clave_api(uuid) to authenticated, service_role;
-- Las tres de lectura son las únicas funciones que puede llamar un visitante sin sesión (anon)
revoke execute on function public.api_horarios(text, date, date), public.api_resumen(text, date, date), public.api_facturas(text, date, date) from public;
grant execute on function public.api_horarios(text, date, date), public.api_resumen(text, date, date), public.api_facturas(text, date, date) to anon, authenticated, service_role;

commit;
