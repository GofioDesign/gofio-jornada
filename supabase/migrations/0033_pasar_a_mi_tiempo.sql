-- =====================================================================
-- GOFIO · 0033 · Pasar a «Mi tiempo» el tiempo fichado en un proyecto personal
--  - Antes de existir «Mi tiempo», algunas personas apuntaban tareas de casa como
--    proyectos de la empresa (p. ej. «Hogar - tender ropa») y ese tiempo cuenta como trabajo.
--  - pasar_a_mi_tiempo copia los tramos de TU tiempo en ese proyecto a una tarea personal
--    (mismas horas) y, si se pide, los saca de la jornada con una corrección: una PAUSA al
--    empezar el tramo y un REANUDAR al acabar (si después se siguió trabajando). Los
--    fichajes originales no se tocan; las correcciones quedan en el registro con su motivo.
--  - Quien es propietario, admin o responsable las deja aprobadas; un empleado las deja
--    pendientes de aprobación, como cualquier corrección.
--  - No toca días ya facturados ni el tramo que sigue abierto. Repetirlo no duplica nada.
-- =====================================================================

create or replace function public.pasar_a_mi_tiempo(p_org uuid, p_proyecto uuid, p_tarea text, p_quitar_de_jornada boolean default true)
returns table (tramos int, minutos int, omitidos int)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_resp boolean; v_tz text; v_pro proyectos; v_tarea uuid; v_motivo text;
  t record; v_fin_cierra boolean;
begin
  if v_uid is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  select * into v_pro from proyectos where id = p_proyecto and org_id = p_org;
  if not found then raise exception 'Proyecto no encontrado'; end if;
  p_tarea := left(trim(regexp_replace(coalesce(p_tarea, ''), '\s+', ' ', 'g')), 60);
  if p_tarea = '' then raise exception 'Escribe el nombre de la tarea personal'; end if;
  v_resp := tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]);
  select coalesce(config->>'zona_horaria', 'Atlantic/Canary') into v_tz from organizaciones where id = p_org;
  v_motivo := 'Tiempo personal pasado a Mi tiempo (' || v_pro.nombre || ')';

  insert into tareas_personales (user_id, nombre) values (v_uid, p_tarea) on conflict (user_id, nombre) do update set activa = true
    returning id into v_tarea;

  tramos := 0; minutos := 0; omitidos := 0;
  for t in
    select * from tramos_jornada(p_org, (v_pro.creado_en at time zone v_tz)::date - 1, (now() at time zone v_tz)::date, v_uid) x
     where x.tipo = 'TRABAJO' and x.proyecto_id = p_proyecto and x.user_id = v_uid
     order by x.inicio
  loop
    if t.fin is null or exists (select 1 from horas_facturadas h where h.org_id = p_org and h.user_id = v_uid and h.dia = t.dia and h.tipo = 'TRABAJO') then
      omitidos := omitidos + 1; continue;
    end if;
    if not exists (select 1 from tiempos_personales tp where tp.user_id = v_uid and tp.inicio = t.inicio) then
      insert into tiempos_personales (user_id, tarea_id, inicio, fin) values (v_uid, v_tarea, t.inicio, t.fin);
    end if;
    if p_quitar_de_jornada then
      -- ¿El tramo acaba porque se paró o se salió? Entonces basta la PAUSA; si no, se reanuda al acabar.
      v_fin_cierra := exists (select 1 from fichajes f
                               where f.org_id = p_org and f.user_id = v_uid and coalesce(f.momento_declarado, f.momento) = t.fin
                                 and f.tipo in ('PAUSA', 'SALIDA') and (f.origen = 'APP' or f.estado = 'APROBADA')
                                 and not exists (select 1 from fichajes_anulados a where a.fichaje_id = f.id));
      perform _insertar_fichaje(p_org, v_uid, 'PAUSA', null, null, null, null, null,
                                case when v_resp then 'RESPONSABLE' else 'CORRECCION' end, t.inicio, null, v_motivo,
                                case when v_resp then 'APROBADA' else 'PENDIENTE' end);
      if not v_fin_cierra then
        perform _insertar_fichaje(p_org, v_uid, 'REANUDAR', null, null, null, null, null,
                                  case when v_resp then 'RESPONSABLE' else 'CORRECCION' end, t.fin, null, v_motivo,
                                  case when v_resp then 'APROBADA' else 'PENDIENTE' end);
      end if;
    end if;
    tramos := tramos + 1; minutos := minutos + t.minutos;
  end loop;
  return next;
end $$;
revoke execute on function public.pasar_a_mi_tiempo(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.pasar_a_mi_tiempo(uuid, uuid, text, boolean) to authenticated;
