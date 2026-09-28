-- =====================================================================
-- GOFIO · 0004 · Copias de seguridad y exportaciones
--  - Plan GRATIS: la empresa descarga a mano (CSV del registro + copia JSON completa).
--  - Plan PRO: una función programada (Edge Function "copia-automatica") sube cada
--    noche la copia y el CSV del mes a la carpeta de Google Drive de la empresa.
-- =====================================================================

create table public.exportaciones (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizaciones(id) on delete cascade,
  tipo        text not null check (tipo in ('MANUAL_CSV', 'MANUAL_COPIA', 'AUTO_DRIVE')),
  periodo     text,                 -- '2026-09' o rango
  destino     text,                 -- nombre/URL del archivo en Drive (auto)
  ok          boolean not null default true,
  error       text,
  hecha_por   uuid references auth.users(id),
  hecha_en    timestamptz not null default now()
);
create index on public.exportaciones (org_id, hecha_en desc);

alter table public.exportaciones enable row level security;
create policy exp_sel on public.exportaciones for select using (public.puede_gestionar(org_id));

-- Registrar una exportación manual (la app genera el archivo en el propio móvil/PC)
create or replace function public.registrar_exportacion(p_org uuid, p_tipo text, p_periodo text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]) then raise exception 'Sin permiso'; end if;
  if p_tipo not in ('MANUAL_CSV', 'MANUAL_COPIA') then raise exception 'Tipo no válido'; end if;
  insert into exportaciones (org_id, tipo, periodo, hecha_por) values (p_org, p_tipo, p_periodo, auth.uid());
end $$;

-- Copia completa de la JORNADA de una empresa en JSON (miembros, clientes, fichajes).
-- La usan el botón "Descargar copia" (gratis) y la copia automática (pro).
create or replace function public.copia_jornada(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not puede_gestionar(p_org) then raise exception 'Sin permiso'; end if;
  return jsonb_build_object(
    'formato', 'gofio-jornada/1',
    'generada', now(),
    'empresa', (select to_jsonb(o) - 'config' from organizaciones o where o.id = p_org),
    'miembros', (select coalesce(jsonb_agg(to_jsonb(m) order by m.nombre), '[]') from miembros m where m.org_id = p_org),
    'clientes', (select coalesce(jsonb_agg(to_jsonb(c) order by c.nombre), '[]') from clientes c where c.org_id = p_org),
    'fichajes', (select coalesce(jsonb_agg(to_jsonb(f) order by f.momento), '[]') from fichajes f where f.org_id = p_org)
  );
end $$;

-- Empresas con copia automática pendiente (la consulta la Edge Function con service role)
create or replace view public.v_copias_pendientes as
select o.id as org_id, o.nombre, o.backup_drive_carpeta,
       (select max(hecha_en) from exportaciones e where e.org_id = o.id and e.tipo = 'AUTO_DRIVE' and e.ok) as ultima
from organizaciones o join planes p on p.id = o.plan_id
where p.backup_auto and (o.plan_hasta is null or o.plan_hasta >= current_date)
  and o.backup_drive_carpeta is not null;
revoke all on public.v_copias_pendientes from anon, authenticated;
