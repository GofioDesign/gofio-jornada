-- =====================================================================
-- GOFIO · 0032 · Planes por asientos
--  · Jornada ('gratis'): una sola persona.
--  · Jornada Pro equipo ('equipo'): tantas personas activas como asientos contratados.
--  · Copia automática: extra de Pro equipo que se cobra por asiento, siempre por
--    todos los asientos contratados (no se puede contratar para una parte del equipo).
--  · Facturación: módulo aparte (sigue siendo tester_facturacion / usa_facturacion).
-- La cuota mensual la paga solo la cuenta principal (el propietario): en la app
-- solo él ve el plan y el precio. Los precios se ajustan en planes y extras
-- (0 = pendiente de definir). Plan, asientos y extras los cambia solo superadmin.
--
-- Unidades que ya existen:
--  · En 'gratis' con más de una persona activa: pasan a Pro equipo con tantos
--    asientos como personas activas tengan hoy (siguen funcionando igual).
--  · En 'pro': pasan a Pro equipo con copia automática y tantos asientos como
--    personas activas (mínimo 1). El plan 'pro' desaparece.
-- =====================================================================

begin;

-- ---------- Catálogo ----------
alter table public.planes
  add column por_asientos boolean not null default false,          -- el límite de personas son los asientos de la empresa
  add column precio_asiento_mes_eur numeric(8,2) not null default 0;

insert into public.planes (id, nombre, max_usuarios, backup_auto, export_auto, precio_mes_eur, orden, por_asientos)
  values ('equipo', 'Jornada Pro equipo', null, false, false, 0, 2, true);
update public.planes set nombre = 'Jornada', max_usuarios = 1 where id = 'gratis';

-- Extras que se suman al plan
create table public.extras (
  id                     text primary key,           -- 'copia_auto', 'facturacion'
  nombre                 text not null,
  precio_mes_eur         numeric(8,2) not null default 0,   -- fijo al mes
  precio_asiento_mes_eur numeric(8,2) not null default 0,   -- por cada asiento contratado
  orden                  int not null default 0
);
insert into public.extras (id, nombre, orden) values
  ('copia_auto',  'Copia automática', 1),
  ('facturacion', 'Facturación',      2);
alter table public.extras enable row level security;
create policy extras_select on public.extras for select using (true);

-- ---------- Lo contratado por cada empresa ----------
alter table public.organizaciones
  add column asientos   int not null default 1 check (asientos >= 1),
  add column copia_auto boolean not null default false;

-- Unidades que ya existen (ver cabecera)
update public.organizaciones o
   set plan_id = 'equipo', asientos = greatest(n.activos, 1), copia_auto = (o.plan_id = 'pro')
  from (select o2.id, (select count(*)::int from public.miembros m where m.org_id = o2.id and m.activo) as activos
          from public.organizaciones o2) n
 where n.id = o.id and (o.plan_id = 'pro' or (o.plan_id = 'gratis' and n.activos > 1));
delete from public.planes where id = 'pro';

-- ---------- Qué permite el plan ----------
-- Personas activas que permite el plan (null = sin límite). Plan caducado: lo del plan gratis.
create or replace function public.limite_usuarios(p_org uuid)
returns int language sql stable set search_path = public as $$
  select case when o.plan_hasta is not null and o.plan_hasta < current_date then g.max_usuarios
              when p.por_asientos then o.asientos
              else p.max_usuarios end
    from organizaciones o join planes p on p.id = o.plan_id join planes g on g.id = 'gratis'
   where o.id = p_org;
$$;

-- ¿Tiene la copia automática contratada y en vigor?
create or replace function public.copia_activa(p_org uuid)
returns boolean language sql stable set search_path = public as $$
  select coalesce((select o.copia_auto and p.por_asientos and (o.plan_hasta is null or o.plan_hasta >= current_date)
                     from organizaciones o join planes p on p.id = o.plan_id where o.id = p_org), false);
$$;

create or replace function public.comprobar_limite_usuarios() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_max int; v_n int;
begin
  if not new.activo then return new; end if;
  v_max := limite_usuarios(new.org_id);
  if v_max is null then return new; end if;
  select count(*) into v_n from miembros where org_id = new.org_id and activo and user_id <> new.user_id;
  if v_n >= v_max then
    raise exception 'Tu plan permite % %. Desactiva a alguien o amplía los asientos.', v_max, case when v_max = 1 then 'persona activa' else 'personas activas' end
      using errcode = 'P0001', hint = 'LIMITE_PLAN';
  end if;
  return new;
end $$;
revoke execute on function public.comprobar_limite_usuarios() from public, anon, authenticated;

create or replace function public.invitar(p_org uuid, p_email text, p_rol public.rol_miembro default 'empleado', p_nombre text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_max int; v_n int; v_tok text;
begin
  if not puede_gestionar(p_org) then raise exception 'Sin permiso'; end if;
  if p_rol = 'propietario' then raise exception 'Solo puede haber un propietario'; end if;
  v_max := limite_usuarios(p_org);
  select count(*) into v_n from miembros where org_id = p_org and activo;
  if v_max is not null and v_n >= v_max then
    raise exception 'Tu plan permite % %. Amplía los asientos para invitar a más gente.', v_max, case when v_max = 1 then 'persona activa' else 'personas activas' end
      using hint = 'LIMITE_PLAN';
  end if;
  insert into invitaciones (org_id, email, nombre, rol, creada_por) values (p_org, lower(trim(p_email)), p_nombre, p_rol, auth.uid())
    returning token into v_tok;
  return v_tok;
end $$;

-- Plan, asientos y extras: solo superadmin (o la consola SQL), nunca la empresa
create or replace function public.proteger_plan() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if new.plan_id is distinct from old.plan_id or new.plan_hasta is distinct from old.plan_hasta
     or new.asientos is distinct from old.asientos or new.copia_auto is distinct from old.copia_auto then
    raise exception 'El plan solo se puede cambiar desde la suscripción';
  end if;
  if new.tester_facturacion is distinct from old.tester_facturacion then
    raise exception 'La facturación solo está disponible para testers invitados por Gofio Design';
  end if;
  if new.usa_facturacion and not new.tester_facturacion then
    raise exception 'La facturación solo está disponible para testers invitados por Gofio Design';
  end if;
  return new;
end $$;

-- Empresas con copia automática pendiente (Edge Function con service role)
create or replace view public.v_copias_pendientes as
select o.id as org_id, o.nombre, o.backup_drive_carpeta,
       (select max(hecha_en) from exportaciones e where e.org_id = o.id and e.tipo = 'AUTO_DRIVE' and e.ok) as ultima
from organizaciones o
where public.copia_activa(o.id) and o.backup_drive_carpeta is not null and o.baja_en is null;
revoke all on public.v_copias_pendientes from anon, authenticated;

-- ---------- Superadministración ----------
-- Comprueba plan, asientos y copia; devuelve los asientos que se guardan
create or replace function public._validar_plan(p_org uuid, p_plan text, p_asientos int, p_copia_auto boolean)
returns int language plpgsql stable set search_path = public as $$
declare v_por_asientos boolean; v_asientos int; v_activos int;
begin
  select por_asientos into v_por_asientos from planes where id = p_plan;
  if not found then raise exception 'Plan no válido: %', p_plan; end if;
  if not v_por_asientos then
    if coalesce(p_copia_auto, false) then raise exception 'La copia automática va con Jornada Pro equipo'; end if;
    v_asientos := 1;
  else
    v_asientos := coalesce(p_asientos, 1);
    if v_asientos < 1 then raise exception 'Pon al menos 1 asiento'; end if;
  end if;
  select count(*)::int into v_activos from miembros where org_id = p_org and activo;
  if v_activos > coalesce((select max_usuarios from planes where id = p_plan and not por_asientos), v_asientos) then
    raise exception 'La unidad tiene % personas activas: hay que desactivar a alguien antes de dejarla con menos', v_activos;
  end if;
  return v_asientos;
end $$;
revoke execute on function public._validar_plan(uuid, text, int, boolean) from public, anon, authenticated;

drop function public.sa_crear_empresa(text, text, text, text, boolean);
create function public.sa_crear_empresa(p_nombre text, p_email_propietario text, p_nif text default null,
                                        p_plan text default 'gratis', p_facturacion boolean default false,
                                        p_asientos int default 1, p_copia_auto boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_email text := lower(trim(coalesce(p_email_propietario, ''))); v_asientos int;
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'Escribe el nombre de la unidad'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Escribe un email válido para el propietario'; end if;
  v_asientos := _validar_plan(null, p_plan, p_asientos, p_copia_auto);
  insert into organizaciones (nombre, nif, plan_id, asientos, copia_auto, tester_facturacion, usa_facturacion)
  values (trim(p_nombre), nullif(trim(p_nif), ''), p_plan, v_asientos, coalesce(p_copia_auto, false),
          coalesce(p_facturacion, false), coalesce(p_facturacion, false))
  returning id into v_id;
  insert into invitaciones (org_id, email, rol, creada_por) values (v_id, v_email, 'propietario', auth.uid());
  return v_id;
end $$;

drop function public.sa_actualizar_empresa(uuid, text, date, boolean);
create function public.sa_actualizar_empresa(p_org uuid, p_plan text, p_plan_hasta date default null, p_facturacion boolean default false,
                                             p_asientos int default 1, p_copia_auto boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_asientos int;
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  if not exists (select 1 from organizaciones where id = p_org) then raise exception 'Unidad no encontrada'; end if;
  v_asientos := _validar_plan(p_org, p_plan, p_asientos, p_copia_auto);
  update organizaciones set plan_id = p_plan, plan_hasta = p_plan_hasta, asientos = v_asientos, copia_auto = coalesce(p_copia_auto, false),
         tester_facturacion = coalesce(p_facturacion, false),
         usa_facturacion = case when not coalesce(p_facturacion, false) then false when not tester_facturacion then true else usa_facturacion end
   where id = p_org;
end $$;

drop function public.sa_empresas();
create function public.sa_empresas()
returns table (id uuid, nombre text, nif text, plan_id text, plan_hasta date, tester_facturacion boolean, usa_facturacion boolean,
               creado_en timestamptz, propietario text, usuarios int, invitacion_pendiente text, ultimo_fichaje timestamptz,
               con_registros boolean, baja_en timestamptz, baja_motivo text, eliminar_desde date,
               asientos int, copia_auto boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  return query
    select o.id, o.nombre, o.nif, o.plan_id, o.plan_hasta, o.tester_facturacion, o.usa_facturacion, o.creado_en,
           (select u.email::text from miembros m join auth.users u on u.id = m.user_id where m.org_id = o.id and m.rol = 'propietario' limit 1),
           (select count(*)::int from miembros m where m.org_id = o.id and m.activo),
           (select i.email from invitaciones i where i.org_id = o.id and i.rol = 'propietario' and i.aceptada_en is null order by i.creada_en desc limit 1),
           (select max(f.momento) from fichajes f where f.org_id = o.id),
           exists (select 1 from fichajes f where f.org_id = o.id) or exists (select 1 from facturas f where f.org_id = o.id),
           o.baja_en, o.baja_motivo, o.eliminar_desde, o.asientos, o.copia_auto
    from organizaciones o
    order by o.baja_en is not null, o.creado_en desc;
end $$;

revoke execute on function public.sa_empresas(), public.sa_crear_empresa(text, text, text, text, boolean, int, boolean),
  public.sa_actualizar_empresa(uuid, text, date, boolean, int, boolean) from public, anon;
grant execute on function public.sa_empresas(), public.sa_crear_empresa(text, text, text, text, boolean, int, boolean),
  public.sa_actualizar_empresa(uuid, text, date, boolean, int, boolean) to authenticated, service_role;
revoke execute on function public.limite_usuarios(uuid), public.copia_activa(uuid) from public, anon;
grant execute on function public.limite_usuarios(uuid), public.copia_activa(uuid) to authenticated, service_role;

commit;
