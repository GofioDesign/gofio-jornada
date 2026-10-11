-- =====================================================================
-- GOFIO · 0026 · Superadministración: gestionar la invitación del propietario
--  - sa_invitar_propietario: cambia (o vuelve a crear) la invitación de propietario
--    de una unidad; anula las que estuvieran pendientes.
--  - sa_anular_invitacion: anula la invitación de propietario pendiente.
--  El correo de aviso lo manda la app con el acceso por enlace de Supabase Auth.
-- =====================================================================

begin;

create or replace function public.sa_invitar_propietario(p_org uuid, p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Escribe un email válido para el propietario'; end if;
  if not exists (select 1 from organizaciones where id = p_org) then raise exception 'Unidad no encontrada'; end if;
  if exists (select 1 from miembros where org_id = p_org and rol = 'propietario') then raise exception 'La unidad ya tiene propietario'; end if;
  delete from invitaciones where org_id = p_org and rol = 'propietario' and aceptada_en is null;
  insert into invitaciones (org_id, email, rol, creada_por) values (p_org, v_email, 'propietario', auth.uid());
end $$;

create or replace function public.sa_anular_invitacion(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  delete from invitaciones where org_id = p_org and rol = 'propietario' and aceptada_en is null;
  if not found then raise exception 'No hay invitación pendiente'; end if;
end $$;

revoke execute on function public.sa_invitar_propietario(uuid, text), public.sa_anular_invitacion(uuid) from public, anon;
grant execute on function public.sa_invitar_propietario(uuid, text), public.sa_anular_invitacion(uuid) to authenticated, service_role;

commit;
