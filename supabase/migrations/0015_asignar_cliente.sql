-- =====================================================================
-- GOFIO · 0015 · Asignar cliente a horas ya fichadas
--  - El registro horario no se toca: se añade un CAMBIO_CLIENTE con la hora declarada
--    (como una corrección). Solo cambia a qué cliente se imputan las horas, no cuántas son.
--  - Propietario, admin y responsable lo aplican al momento; un empleado lo solicita
--    y queda PENDIENTE hasta que un responsable lo apruebe (revisar_correccion).
--  - Las horas de un día ya facturado no se pueden reasignar.
-- =====================================================================

create or replace function public.asignar_cliente(
  p_org uuid, p_momento timestamptz, p_cliente uuid, p_user uuid default null)
returns public.fichajes language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_resp boolean; v_tz text; v_dia date;
begin
  if v_uid is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  p_user := coalesce(p_user, v_uid);
  v_resp := tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]);
  if p_user <> v_uid and not v_resp then raise exception 'Sin permiso'; end if;
  if not exists (select 1 from miembros where org_id = p_org and user_id = p_user) then
    raise exception 'Usuario no pertenece a la empresa';
  end if;
  if p_cliente is null or not exists (select 1 from clientes where id = p_cliente and org_id = p_org) then
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

  if v_resp then
    return _insertar_fichaje(p_org, p_user, 'CAMBIO_CLIENTE', null, null, null, p_cliente, null,
                             'RESPONSABLE', p_momento, null, 'Cliente asignado a posteriori', 'APROBADA');
  end if;
  return _insertar_fichaje(p_org, p_user, 'CAMBIO_CLIENTE', null, null, null, p_cliente, null,
                           'CORRECCION', p_momento, null, 'Cliente asignado a posteriori', 'PENDIENTE');
end $$;
revoke execute on function public.asignar_cliente(uuid, timestamptz, uuid, uuid) from public, anon;

-- Una asignación de cliente no es una corrección del horario: no cuenta en el resumen.
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
revoke execute on function public.resumen_jornada(uuid, date, date, uuid) from public, anon;
