-- =====================================================================
-- GOFIO · 0029 · Eliminar unidades y darlas de baja (superadministración)
--  - Una unidad que NO ha empezado (sin fichajes ni facturas) se puede eliminar ya.
--  - Una unidad que ha dejado de funcionar se DA DE BAJA: sus usuarios dejan de
--    entrar, los datos se conservan y se calcula desde cuándo se pueden borrar:
--      · registro de jornada: 4 años desde el último fichaje (art. 34.9 del Estatuto
--        de los Trabajadores);
--      · facturas y gastos: 6 años desde el cierre del ejercicio del último documento
--        (art. 30 del Código de Comercio; cubre los 4 de la Ley General Tributaria).
--    Hasta esa fecha se puede reactivar. Desde esa fecha, el superadmin puede
--    eliminarla definitivamente (nunca se borra sola).
-- =====================================================================

begin;

alter table public.organizaciones
  add column baja_en        timestamptz,
  add column baja_motivo    text,
  add column eliminar_desde date;

-- Una unidad dada de baja no es accesible para sus miembros (los datos siguen ahí, bloqueados)
create or replace function public.es_miembro(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from miembros m join organizaciones o on o.id = m.org_id
                 where m.org_id = p_org and m.user_id = auth.uid() and m.activo and o.baja_en is null);
$$;
create or replace function public.tiene_rol(p_org uuid, p_roles public.rol_miembro[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from miembros m join organizaciones o on o.id = m.org_id
                 where m.org_id = p_org and m.user_id = auth.uid() and m.activo and m.rol = any(p_roles) and o.baja_en is null);
$$;

-- Fecha a partir de la cual la ley ya no obliga a conservar los datos de la unidad
create or replace function public.plazo_conservacion(p_org uuid)
returns date language sql stable security definer set search_path = public as $$
  select greatest(
    current_date,
    (select (max(coalesce(f.momento_declarado, f.momento)) + interval '4 years')::date from fichajes f where f.org_id = p_org),
    (select make_date(extract(year from max(x.fecha))::int + 7, 1, 1)
       from (select fecha from facturas where org_id = p_org union all select fecha from gastos where org_id = p_org) x));
$$;
revoke execute on function public.plazo_conservacion(uuid) from public, anon, authenticated;

-- Los fichajes, anulaciones y facturas no se borran nunca... salvo al eliminar una unidad cuyo plazo legal ya pasó.
-- El borrado se separa del update para poder abrirlo solo en ese caso (gofio.purga_unidad = id de la unidad).
drop trigger fichajes_no_update on public.fichajes;
create trigger fichajes_no_update before update on public.fichajes for each row execute function public.fichajes_inmutables();
create trigger fichajes_no_delete before delete on public.fichajes for each row
  when (current_setting('gofio.purga_unidad', true) is distinct from old.org_id::text) execute function public.fichajes_inmutables();

drop trigger fichajes_anulados_inmutables on public.fichajes_anulados;
create trigger fichajes_anulados_inmutables before update on public.fichajes_anulados for each row execute function public.anulaciones_inmutables();
create trigger fichajes_anulados_no_delete before delete on public.fichajes_anulados for each row
  when (current_setting('gofio.purga_unidad', true) is distinct from old.org_id::text) execute function public.anulaciones_inmutables();

drop trigger facturas_inmutables on public.facturas;
create trigger facturas_inmutables before update on public.facturas for each row execute function public.facturas_inmutables();
create trigger facturas_no_delete before delete on public.facturas for each row
  when (current_setting('gofio.purga_unidad', true) is distinct from old.org_id::text) execute function public.facturas_inmutables();

drop trigger lineas_inmutables on public.facturas_lineas;
create trigger lineas_inmutables before update on public.facturas_lineas for each row execute function public.lineas_inmutables();
create trigger lineas_no_delete before delete on public.facturas_lineas for each row
  when (coalesce(current_setting('gofio.purga_unidad', true), '') = '') execute function public.lineas_inmutables();

-- Listado del panel: se añade la baja y si la unidad ya tiene registros legales
drop function public.sa_empresas();
create function public.sa_empresas()
returns table (id uuid, nombre text, nif text, plan_id text, plan_hasta date, tester_facturacion boolean, usa_facturacion boolean,
               creado_en timestamptz, propietario text, usuarios int, invitacion_pendiente text, ultimo_fichaje timestamptz,
               con_registros boolean, baja_en timestamptz, baja_motivo text, eliminar_desde date)
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
           o.baja_en, o.baja_motivo, o.eliminar_desde
    from organizaciones o
    order by o.baja_en is not null, o.creado_en desc;
end $$;

create or replace function public.sa_dar_de_baja(p_org uuid, p_motivo text default null)
returns date language plpgsql security definer set search_path = public as $$
declare v date;
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  if not exists (select 1 from organizaciones where id = p_org) then raise exception 'Unidad no encontrada'; end if;
  if exists (select 1 from organizaciones where id = p_org and baja_en is not null) then raise exception 'La unidad ya está de baja'; end if;
  v := plazo_conservacion(p_org);
  update organizaciones set baja_en = now(), baja_motivo = nullif(trim(coalesce(p_motivo, '')), ''), eliminar_desde = v where id = p_org;
  delete from invitaciones where org_id = p_org and aceptada_en is null;
  return v;
end $$;

create or replace function public.sa_reactivar(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  update organizaciones set baja_en = null, baja_motivo = null, eliminar_desde = null where id = p_org and baja_en is not null;
  if not found then raise exception 'La unidad no está de baja'; end if;
end $$;

-- Elimina la unidad y todos sus datos. p_nombre: el nombre de la unidad, como confirmación.
create or replace function public.sa_eliminar_unidad(p_org uuid, p_nombre text)
returns void language plpgsql security definer set search_path = public as $$
declare o organizaciones; v_registros boolean; v_plazo date;
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  select * into o from organizaciones where id = p_org;
  if not found then raise exception 'Unidad no encontrada'; end if;
  if lower(trim(coalesce(p_nombre, ''))) <> lower(trim(o.nombre)) then raise exception 'Escribe el nombre exacto de la unidad para confirmar'; end if;
  v_registros := exists (select 1 from fichajes where org_id = p_org) or exists (select 1 from facturas where org_id = p_org);
  if v_registros then
    if o.baja_en is null then
      raise exception 'La unidad tiene fichajes o facturas: dala de baja y podrás eliminarla cuando acabe el plazo legal';
    end if;
    v_plazo := greatest(o.eliminar_desde, plazo_conservacion(p_org));
    if v_plazo > current_date then
      raise exception 'Hay que conservar sus datos hasta el %', to_char(v_plazo, 'DD/MM/YYYY');
    end if;
    -- Plazo cumplido: se abren los borrados solo para esta unidad y en esta transacción
    perform set_config('gofio.purga_unidad', p_org::text, true);
    delete from horas_facturadas where org_id = p_org;
    delete from cobros where org_id = p_org;
    delete from presupuestos where org_id = p_org;
    delete from facturas_lineas where factura_id in (select id from facturas where org_id = p_org);
    delete from facturas where org_id = p_org;
    delete from fichajes_anulados where org_id = p_org;
    delete from fichajes where org_id = p_org;
  end if;
  delete from organizaciones where id = p_org;   -- el resto (miembros, clientes, proyectos…) va en cascada
  perform set_config('gofio.purga_unidad', '', true);
end $$;

-- Copia completa para entregarla a la empresa o a quien la pida legalmente durante la baja
create or replace function public.sa_copia_unidad(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not es_superadmin() then raise exception 'Solo para superadministración'; end if;
  if not exists (select 1 from organizaciones where id = p_org) then raise exception 'Unidad no encontrada'; end if;
  return jsonb_build_object(
    'formato', 'gofio-unidad/1',
    'generada', now(),
    'empresa', (select to_jsonb(o) from organizaciones o where o.id = p_org),
    'miembros', (select coalesce(jsonb_agg(to_jsonb(m) order by m.nombre), '[]') from miembros m where m.org_id = p_org),
    'clientes', (select coalesce(jsonb_agg(to_jsonb(c) order by c.nombre), '[]') from clientes c where c.org_id = p_org),
    'fichajes', (select coalesce(jsonb_agg(to_jsonb(f) order by f.momento), '[]') from fichajes f where f.org_id = p_org),
    'fichajes_anulados', (select coalesce(jsonb_agg(to_jsonb(a)), '[]') from fichajes_anulados a where a.org_id = p_org),
    'facturas', (select coalesce(jsonb_agg(to_jsonb(f) || jsonb_build_object('lineas',
                   (select coalesce(jsonb_agg(to_jsonb(l) order by l.linea), '[]') from facturas_lineas l where l.factura_id = f.id))
                 order by f.fecha, f.serie, f.num), '[]') from facturas f where f.org_id = p_org),
    'gastos', (select coalesce(jsonb_agg(to_jsonb(g) order by g.fecha), '[]') from gastos g where g.org_id = p_org)
  );
end $$;

revoke execute on function public.sa_empresas(), public.sa_dar_de_baja(uuid, text), public.sa_reactivar(uuid),
  public.sa_eliminar_unidad(uuid, text), public.sa_copia_unidad(uuid) from public, anon;
grant execute on function public.sa_empresas(), public.sa_dar_de_baja(uuid, text), public.sa_reactivar(uuid),
  public.sa_eliminar_unidad(uuid, text), public.sa_copia_unidad(uuid) to authenticated, service_role;

commit;
