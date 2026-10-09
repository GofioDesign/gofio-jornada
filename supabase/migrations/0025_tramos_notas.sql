-- =====================================================================
-- GOFIO · 0025 · Asignar solo una parte de un tramo · Notas de trabajo
--  - asignar_cliente admite «sin asignar» (cliente y proyecto nulos). Sirve para
--    asignar solo una parte de un tramo: la app asigna el nuevo cliente o proyecto
--    desde la hora de inicio elegida y devuelve lo que había a partir de la hora de fin.
--    El registro de jornada no cambia: las horas de entrada y salida son las fichadas.
--  - notas_tramo: qué se hizo en un tramo de trabajo (descripción de tareas) y qué
--    materiales se usaron. Se identifica por la persona y la hora de inicio del tramo.
--    La escribe la propia persona, o propietario/admin/responsable para su equipo.
-- =====================================================================

begin;

create or replace function public.asignar_cliente(
  p_org uuid, p_momento timestamptz, p_cliente uuid, p_user uuid default null, p_proyecto uuid default null)
returns public.fichajes language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_resp boolean; v_tz text; v_dia date; v_motivo text;
begin
  if v_uid is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  p_user := coalesce(p_user, v_uid);
  v_resp := tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]);
  if p_user <> v_uid and not v_resp then raise exception 'Sin permiso'; end if;
  if not exists (select 1 from miembros where org_id = p_org and user_id = p_user) then
    raise exception 'Usuario no pertenece a la empresa';
  end if;
  if p_proyecto is not null then p_cliente := _cliente_de_proyecto(p_org, p_proyecto, p_cliente); end if;
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

  v_motivo := case when p_cliente is null and p_proyecto is null then 'Sin asignar a partir de esta hora' else 'Cliente asignado a posteriori' end;
  if v_resp then
    return _insertar_fichaje(p_org, p_user, 'CAMBIO_CLIENTE', null, null, null, p_cliente, null,
                             'RESPONSABLE', p_momento, null, v_motivo, 'APROBADA', p_proyecto);
  end if;
  return _insertar_fichaje(p_org, p_user, 'CAMBIO_CLIENTE', null, null, null, p_cliente, null,
                           'CORRECCION', p_momento, null, v_motivo, 'PENDIENTE', p_proyecto);
end $$;
revoke execute on function public.asignar_cliente(uuid, timestamptz, uuid, uuid, uuid) from public, anon;
grant execute on function public.asignar_cliente(uuid, timestamptz, uuid, uuid, uuid) to authenticated, service_role;

create table public.notas_tramo (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizaciones(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  inicio         timestamptz not null,                     -- hora de inicio del tramo
  texto          text not null default '',
  -- [{ "descripcion": "Tubo PVC 40", "cantidad": 2, "unidad": "m", "producto_id": "…" | null }]
  materiales     jsonb not null default '[]' check (jsonb_typeof(materiales) = 'array'),
  escrita_por    uuid not null default auth.uid() references auth.users(id),
  actualizado_en timestamptz not null default now(),
  unique (org_id, user_id, inicio)
);
create trigger notas_tramo_upd before update on public.notas_tramo for each row execute function public.tocar_actualizado();

alter table public.notas_tramo enable row level security;
create policy notas_tramo_sel on public.notas_tramo for select using (
  public.es_miembro(org_id) and (user_id = auth.uid() or public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])));
create policy notas_tramo_ins on public.notas_tramo for insert with check (
  public.es_miembro(org_id) and (user_id = auth.uid() or public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])));
create policy notas_tramo_upd on public.notas_tramo for update using (
  public.es_miembro(org_id) and (user_id = auth.uid() or public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])))
  with check (public.es_miembro(org_id) and (user_id = auth.uid() or public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])));
create policy notas_tramo_del on public.notas_tramo for delete using (
  public.es_miembro(org_id) and (user_id = auth.uid() or public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])));
grant select, insert, update, delete on public.notas_tramo to authenticated;

commit;
