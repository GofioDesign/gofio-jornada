-- =====================================================================
-- GOFIO · 0024 · Panel de superadministración (Gofio Design)
--  - superadmins: usuarios de la plataforma que pueden dar de alta unidades
--    (empresas) y cambiar su plan y el acceso a facturación. Nadie puede leer ni
--    tocar esta tabla desde la app: se rellena desde el SQL Editor.
--      insert into public.superadmins (user_id) select id from auth.users where email = '<tu email>';
--  - sa_empresas / sa_crear_empresa / sa_actualizar_empresa: solo para superadmins.
--    Crear una unidad deja una invitación de propietario para el email indicado:
--    al entrar en la app con ese email, la acepta con un toque.
-- =====================================================================

begin;

create table public.superadmins (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  creado_en timestamptz not null default now()
);
alter table public.superadmins enable row level security;   -- sin políticas: nadie la lee desde la app
revoke all on public.superadmins from authenticated, anon;

create or replace function public.es_superadmin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from superadmins where user_id = auth.uid());
$$;

create or replace function public.sa_empresas()
returns table (id uuid, nombre text, nif text, plan_id text, plan_hasta date, tester_facturacion boolean, usa_facturacion boolean,
               creado_en timestamptz, propietario text, usuarios int, invitacion_pendiente text, ultimo_fichaje timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  return query
    select o.id, o.nombre, o.nif, o.plan_id, o.plan_hasta, o.tester_facturacion, o.usa_facturacion, o.creado_en,
           (select u.email::text from miembros m join auth.users u on u.id = m.user_id where m.org_id = o.id and m.rol = 'propietario' limit 1),
           (select count(*)::int from miembros m where m.org_id = o.id and m.activo),
           (select i.email from invitaciones i where i.org_id = o.id and i.rol = 'propietario' and i.aceptada_en is null order by i.creada_en desc limit 1),
           (select max(f.momento) from fichajes f where f.org_id = o.id)
    from organizaciones o
    order by o.creado_en desc;
end $$;

create or replace function public.sa_crear_empresa(p_nombre text, p_email_propietario text, p_nif text default null,
                                                   p_plan text default 'gratis', p_facturacion boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_email text := lower(trim(coalesce(p_email_propietario, '')));
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'Escribe el nombre de la unidad'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Escribe un email válido para el propietario'; end if;
  if not exists (select 1 from planes where id = p_plan) then raise exception 'Plan no válido: %', p_plan; end if;
  insert into organizaciones (nombre, nif, plan_id, tester_facturacion, usa_facturacion)
  values (trim(p_nombre), nullif(trim(p_nif), ''), p_plan, coalesce(p_facturacion, false), coalesce(p_facturacion, false))
  returning id into v_id;
  insert into invitaciones (org_id, email, rol, creada_por) values (v_id, v_email, 'propietario', auth.uid());
  return v_id;
end $$;

create or replace function public.sa_actualizar_empresa(p_org uuid, p_plan text, p_plan_hasta date default null, p_facturacion boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  if not exists (select 1 from planes where id = p_plan) then raise exception 'Plan no válido: %', p_plan; end if;
  update organizaciones set plan_id = p_plan, plan_hasta = p_plan_hasta, tester_facturacion = coalesce(p_facturacion, false),
         -- al activarla queda visible; al quitarla se oculta; si ya la tenía, la empresa conserva su elección
         usa_facturacion = case when not coalesce(p_facturacion, false) then false when not tester_facturacion then true else usa_facturacion end
   where id = p_org;
  if not found then raise exception 'Unidad no encontrada'; end if;
end $$;

revoke execute on function public.es_superadmin(), public.sa_empresas(), public.sa_crear_empresa(text, text, text, text, boolean),
  public.sa_actualizar_empresa(uuid, text, date, boolean) from public, anon;
grant execute on function public.es_superadmin(), public.sa_empresas(), public.sa_crear_empresa(text, text, text, text, boolean),
  public.sa_actualizar_empresa(uuid, text, date, boolean) to authenticated, service_role;

commit;
