-- =====================================================================
-- GOFIO · 0001 · Base multi-empresa: empresas, usuarios, roles, planes y módulos
-- Cada empresa tiene sus datos aislados con RLS.
-- Un mismo usuario puede pertenecer a varias empresas con distinto rol.
-- Producto comercial: JORNADA (control horario). Plan gratis con límites y plan de pago
-- con copia de seguridad y exportación automáticas.
-- FACTURACION no se vende: solo se activa a testers seleccionados por Gofio Design.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Planes (editable por Gofio Design sin tocar código) ----------
create table public.planes (
  id                    text primary key,          -- 'gratis', 'pro', ...
  nombre                text not null,
  max_usuarios          int,                       -- null = sin límite
  backup_auto           boolean not null default false,  -- copia de seguridad automática (Google Drive)
  export_auto           boolean not null default false,  -- exportación periódica automática (gestoría / Inspección)
  dias_historial_app    int,                       -- null = todo; en gratis se puede limitar lo visible en la app (los datos NO se borran: obligación legal de 4 años)
  precio_mes_eur        numeric(8,2) not null default 0,
  orden                 int not null default 0
);

insert into public.planes (id, nombre, max_usuarios, backup_auto, export_auto, precio_mes_eur, orden) values
  ('gratis', 'Jornada Gratis', 5,    false, false, 0, 1),   -- copias y exportación manuales (botón en la app)
  ('pro',    'Jornada Pro',    null, true,  true,  0, 2);   -- copia y exportación automáticas
-- Los precios y el límite del plan gratis se ajustan aquí (0 = pendiente de definir).

create table public.organizaciones (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null,                 -- nombre comercial (marca)
  titular      text,                          -- titular fiscal
  nif          text,
  direccion    text,
  cp           text,
  localidad    text,
  provincia    text,
  pais         text default 'ESPAÑA',
  email        text,
  telefono     text,
  web          text,
  iban         text,
  bic          text,
  logo_url     text,
  plan_id      text not null default 'gratis' references public.planes(id),
  plan_hasta   date,                          -- null = indefinido
  -- FACTURACIÓN: solo testers seleccionados. Lo activa Gofio Design (service role), nunca la empresa.
  tester_facturacion boolean not null default false,
  usa_facturacion    boolean not null default false,  -- la empresa tester puede ocultarla si no la usa
  -- Destino de copias/exportaciones automáticas (plan pro)
  backup_drive_carpeta text,
  -- Parámetros de negocio. Sustituye a la hoja CONFIG.
  config       jsonb not null default jsonb_build_object(
                  'igic_defecto', 7,
                  'irpf_defecto', 15,
                  'dias_vencimiento', 30,
                  'dias_validez_presupuesto', 30,
                  'igic_periodo', 'TRIMESTRAL',
                  'deduce_igic', true,
                  'margen_minimo', 0.30,
                  'margen_ideal', 0.60,
                  'zona_horaria', 'Atlantic/Canary',
                  'serie_factura', 'EMIT',
                  'serie_rectificativa', 'RECT',
                  'serie_presupuesto', 'PRES',
                  'medio_pago_texto', 'Pago por transferencia bancaria.',
                  'email_gestoria', null,
                  'jornada_geolocalizar', true,
                  'jornada_horas_dia', 8
               ),
  creado_en    timestamptz not null default now()
);

create type public.rol_miembro as enum ('propietario', 'admin', 'responsable', 'empleado', 'gestoria');
-- propietario/admin: todo · responsable: ve y valida la jornada del equipo
-- empleado: ficha y ve lo suyo · gestoria: lectura de facturación e impuestos

create table public.miembros (
  org_id     uuid not null references public.organizaciones(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  rol        public.rol_miembro not null default 'empleado',
  nombre     text,
  nif        text,                            -- para el registro de jornada
  activo     boolean not null default true,
  creado_en  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on public.miembros (user_id);

create table public.invitaciones (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizaciones(id) on delete cascade,
  email       text not null,
  nombre      text,
  rol         public.rol_miembro not null default 'empleado',
  token       text not null unique default encode(gen_random_bytes(18), 'hex'),
  creada_por  uuid references auth.users(id),
  creada_en   timestamptz not null default now(),
  aceptada_en timestamptz
);

-- ---------- helpers de permisos (security definer para evitar recursión RLS) ----------
create or replace function public.es_miembro(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from miembros where org_id = p_org and user_id = auth.uid() and activo);
$$;

create or replace function public.tiene_rol(p_org uuid, p_roles public.rol_miembro[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from miembros where org_id = p_org and user_id = auth.uid() and activo and rol = any(p_roles));
$$;

create or replace function public.puede_gestionar(p_org uuid)
returns boolean language sql stable as $$
  select public.tiene_rol(p_org, array['propietario','admin']::public.rol_miembro[]);
$$;

-- ¿El módulo está activo y lo permite el plan (y el plan no ha caducado)?
create or replace function public.modulo_activo(p_org uuid, p_modulo text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select case p_modulo
             when 'jornada'     then true    -- todas las empresas; el plan solo cambia límites y automatismos
             when 'facturacion' then o.tester_facturacion and o.usa_facturacion
             else false end
    from organizaciones o where o.id = p_org), false);
$$;

-- Facturación: miembro con rol de gestión (o gestoría en lectura) y módulo activo
create or replace function public.puede_ver_facturacion(p_org uuid)
returns boolean language sql stable as $$
  select public.modulo_activo(p_org, 'facturacion')
     and public.tiene_rol(p_org, array['propietario','admin','gestoria']::public.rol_miembro[]);
$$;
create or replace function public.puede_facturar(p_org uuid)
returns boolean language sql stable as $$
  select public.modulo_activo(p_org, 'facturacion') and public.puede_gestionar(p_org);
$$;

-- ---------- Límite de usuarios del plan ----------
create or replace function public.comprobar_limite_usuarios() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_max int; v_n int;
begin
  if not new.activo then return new; end if;
  select case when o.plan_hasta is not null and o.plan_hasta < current_date then g.max_usuarios else p.max_usuarios end into v_max
    from organizaciones o join planes p on p.id = o.plan_id join planes g on g.id = 'gratis' where o.id = new.org_id;
  if v_max is null then return new; end if;
  select count(*) into v_n from miembros where org_id = new.org_id and activo
     and not (org_id = new.org_id and user_id = new.user_id);
  if v_n >= v_max then
    raise exception 'Tu plan permite % usuarios activos. Desactiva alguno o cambia de plan.', v_max
      using errcode = 'P0001', hint = 'LIMITE_PLAN';
  end if;
  return new;
end $$;
create trigger miembros_limite before insert or update of activo on public.miembros
  for each row execute function public.comprobar_limite_usuarios();

-- El plan y el acceso de tester solo los cambia Gofio Design (service role / SQL), nunca la empresa
create or replace function public.proteger_plan() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Solo se restringe a los usuarios de la app; service_role y la consola SQL (postgres) pueden todo
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if new.plan_id is distinct from old.plan_id or new.plan_hasta is distinct from old.plan_hasta then
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
create trigger organizaciones_plan before update on public.organizaciones
  for each row execute function public.proteger_plan();

-- ---------- RLS ----------
alter table public.planes         enable row level security;
alter table public.organizaciones enable row level security;
alter table public.miembros       enable row level security;
alter table public.invitaciones   enable row level security;

create policy planes_select on public.planes for select using (true);

create policy org_select on public.organizaciones for select using (public.es_miembro(id));
create policy org_update on public.organizaciones for update using (public.puede_gestionar(id)) with check (public.puede_gestionar(id));

create policy miembros_select on public.miembros for select using (public.es_miembro(org_id));
create policy miembros_admin  on public.miembros for update using (public.puede_gestionar(org_id)) with check (public.puede_gestionar(org_id));

create policy inv_admin on public.invitaciones for all using (public.puede_gestionar(org_id)) with check (public.puede_gestionar(org_id));

-- ---------- Alta de empresa (asistente de configuración inicial) ----------
create or replace function public.crear_organizacion(p_nombre text, p_nif text default null, p_nombre_usuario text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Necesitas iniciar sesión'; end if;
  insert into organizaciones (nombre, nif) values (p_nombre, p_nif) returning id into v_id;
  insert into miembros (org_id, user_id, rol, nombre) values (v_id, auth.uid(), 'propietario', p_nombre_usuario);
  return v_id;
end $$;

-- Invitar: comprueba el límite del plan antes de crear la invitación
create or replace function public.invitar(p_org uuid, p_email text, p_rol public.rol_miembro default 'empleado', p_nombre text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_max int; v_n int; v_tok text;
begin
  if not puede_gestionar(p_org) then raise exception 'Sin permiso'; end if;
  if p_rol = 'propietario' then raise exception 'Solo puede haber un propietario'; end if;
  select case when o.plan_hasta is not null and o.plan_hasta < current_date then g.max_usuarios else p.max_usuarios end into v_max
    from organizaciones o join planes p on p.id = o.plan_id join planes g on g.id = 'gratis' where o.id = p_org;
  select count(*) into v_n from miembros where org_id = p_org and activo;
  if v_max is not null and v_n >= v_max then
    raise exception 'Tu plan permite % usuarios activos.', v_max using hint = 'LIMITE_PLAN';
  end if;
  insert into invitaciones (org_id, email, nombre, rol, creada_por) values (p_org, lower(trim(p_email)), p_nombre, p_rol, auth.uid())
    returning token into v_tok;
  return v_tok;
end $$;

create or replace function public.aceptar_invitacion(p_token text, p_nombre text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_inv invitaciones;
begin
  select * into v_inv from invitaciones where token = p_token and aceptada_en is null;
  if not found then raise exception 'Invitación no válida o ya usada'; end if;
  if lower(v_inv.email) <> lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'Esta invitación es para %', v_inv.email;
  end if;
  insert into miembros (org_id, user_id, rol, nombre) values (v_inv.org_id, auth.uid(), v_inv.rol, coalesce(p_nombre, v_inv.nombre))
    on conflict (org_id, user_id) do update set rol = excluded.rol, activo = true;
  update invitaciones set aceptada_en = now() where id = v_inv.id;
  return v_inv.org_id;
end $$;

-- Invitaciones pendientes para el usuario que acaba de entrar (se aceptan con un toque)
create or replace function public.mis_invitaciones()
returns table (token text, org_nombre text, rol public.rol_miembro)
language sql stable security definer set search_path = public as $$
  select i.token, o.nombre, i.rol from invitaciones i join organizaciones o on o.id = i.org_id
  where i.aceptada_en is null and lower(i.email) = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

-- Trigger genérico de fecha de actualización
create or replace function public.tocar_actualizado() returns trigger language plpgsql as $$
begin new.actualizado_en = now(); return new; end $$;
