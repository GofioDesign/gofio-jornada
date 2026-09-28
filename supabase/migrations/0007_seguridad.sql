-- =====================================================================
-- GOFIO · 0007 · Endurecimiento de seguridad
--  1. Los visitantes sin sesión (rol anon) no pueden ejecutar NINGUNA función de la app.
--     Cerraba: copia_jornada() sin sesión devolvía la copia completa de cualquier empresa,
--     y estado_jornada() dejaba ver el estado de cualquier usuario.
--  2. copia_jornada y estado_jornada comprueban también la sesión por dentro (defensa doble).
--  3. El propietario no se puede degradar ni desactivar desde la app, ni se puede
--     nombrar un segundo propietario ni mover miembros de empresa.
-- Recuerda además en el panel: Authentication → Email → «Confirm email» ACTIVADO.
-- =====================================================================

-- ---------- 1. Sin permisos de ejecución para anon ----------
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated, service_role;
-- La función interna sigue cerrada también para los usuarios con sesión
revoke execute on function public._insertar_fichaje(uuid, uuid, public.tipo_fichaje, double precision, double precision, real,
                                                    uuid, text, text, timestamptz, uuid, text, text) from authenticated;
-- Funciones futuras: Supabase se las da a anon por defecto; se lo quitamos.
alter default privileges in schema public revoke execute on functions from anon;
-- OJO: Postgres además las da a PUBLIC (y eso no se puede quitar solo en este esquema).
-- Por eso CADA función nueva debe llevar detrás:
--   revoke execute on function public.<nombre>(<args>) from public, anon;
-- La prueba «anon puede ejecutar funciones de public» (tests/pruebas.sql) avisa si se olvida.

-- ---------- 2a. copia_jornada: sin sesión solo la puede usar el service role ----------
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
    'fichajes', (select coalesce(jsonb_agg(to_jsonb(f) order by f.momento), '[]') from fichajes f where f.org_id = p_org)
  );
end $$;
revoke execute on function public.copia_jornada(uuid) from public, anon;

-- ---------- 2b. estado_jornada: exige sesión y ser miembro ----------
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
revoke execute on function public.estado_jornada(uuid, uuid) from public, anon;

-- ---------- 3. Proteger al propietario ----------
create or replace function public.proteger_miembros() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Solo se restringe a los usuarios de la app; service_role y la consola SQL pueden todo
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if new.org_id is distinct from old.org_id or new.user_id is distinct from old.user_id then
    raise exception 'No se puede mover un miembro a otra empresa';
  end if;
  if old.rol = 'propietario' and (new.rol <> 'propietario' or not new.activo) then
    raise exception 'El propietario no se puede cambiar ni desactivar';
  end if;
  if new.rol = 'propietario' and old.rol <> 'propietario' then
    raise exception 'Solo puede haber un propietario';
  end if;
  return new;
end $$;
drop trigger if exists miembros_proteger on public.miembros;
create trigger miembros_proteger before update on public.miembros
  for each row execute function public.proteger_miembros();
revoke execute on function public.proteger_miembros() from public, anon;
