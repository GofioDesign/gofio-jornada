-- =====================================================================
-- GOFIO · 0034 · Registro de jornada más claro y completo (formato 2 del documento que se firma)
--  - Cada día lleva sus tramos de trabajo cuando hay más de uno (jornada partida o pausas),
--    no solo la primera entrada y la última salida.
--  - En lugar de «Correcciones: 2», el documento explica cada cambio hecho a mano: qué se
--    añadió o anuló, quién lo pidió, quién lo aprobó, cuándo y por qué.
--  - Fechas en formato español con el día de la semana, totales de pausas y desplazamientos
--    (estos van incluidos en el trabajo) y una nota con la base legal y el plazo de conservación.
--  - Las firmas guardan con qué formato se firmaron (formato). Las firmas hechas antes de esta
--    migración son del formato 1 y siguen vigentes mientras el registro no cambie: la vigencia
--    se comprueba siempre con el formato de cada firma.
--  - registro_para_firmar avisa además de las correcciones pendientes y de los días sin cerrar.
--  El texto tiene que ser idéntico al de documentoRegistro en app/js/lib/firma.js (modo demo).
-- =====================================================================

begin;

alter table public.firmas_registro add column formato smallint not null default 1 check (formato in (1, 2));
comment on column public.firmas_registro.formato is 'Versión del documento firmado: 1 = 0030, 2 = 0034';

create or replace function public._nombre_miembro(p_org uuid, p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select nullif(trim(m.nombre), '') from miembros m where m.org_id = p_org and m.user_id = p_user), '—')
$$;
revoke execute on function public._nombre_miembro(uuid, uuid) from public, anon, authenticated;

-- Documento del mes de una persona, formato 2. Igual que _documento_registro (formato 1), lo llaman
-- funciones que ya han comprobado que quien pide es esa persona o un responsable.
create or replace function public._documento_registro_v2(p_org uuid, p_user uuid, p_periodo date)
returns table (documento text, huella text, dias int, minutos int, abiertos int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_org organizaciones; v_m miembros; v_tz text; v_hasta date; r record;
  c_dias constant text[] := array['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
  c_meses constant text[] := array['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  v_refs jsonb := '{}'; v_n int := 0; v_cambios text := ''; v_que text; v_t text;
  v_lista jsonb := '[]'; v_dia date; st text; t_ini timestamptz; p_ini timestamptz; d_ini timestamptz;
  v_ent timestamptz; v_sal timestamptz; v_trab int; v_paus int; v_desp int; v_tramos text[];
  v_pausas int := 0; v_despl int := 0; v_con_desp boolean; x jsonb; v_txt text;
begin
  select * into v_org from organizaciones o where o.id = p_org;
  select * into v_m from miembros m where m.org_id = p_org and m.user_id = p_user;
  v_tz := coalesce(v_org.config->>'zona_horaria', 'Atlantic/Canary');
  p_periodo := date_trunc('month', p_periodo)::date;
  v_hasta := (p_periodo + interval '1 month' - interval '1 day')::date;
  dias := 0; minutos := 0; abiertos := 0;

  for r in
    select f.*, coalesce(f.momento_declarado, f.momento) as m, (coalesce(f.momento_declarado, f.momento) at time zone v_tz)::date as d,
           a.fichaje_id is not null as anulado, a.motivo as a_motivo, a.anulado_por, a.anulado_en
      from fichajes f left join fichajes_anulados a on a.fichaje_id = f.id
     where f.org_id = p_org and f.user_id = p_user
       and (coalesce(f.momento_declarado, f.momento) at time zone v_tz)::date between p_periodo and v_hasta
     order by coalesce(f.momento_declarado, f.momento), f.momento, f.id
  loop
    -- Cambios hechos a mano: correcciones aprobadas y fichajes anulados (sin los de cliente, que no cambian las horas)
    if r.tipo <> 'CAMBIO_CLIENTE' and (r.anulado or (r.origen <> 'APP' and r.estado = 'APROBADA')) then
      v_n := v_n + 1;
      v_refs := jsonb_set(v_refs, array[r.d::text], to_jsonb(coalesce(v_refs->>(r.d::text), '') || '(' || v_n || ')'));
      v_que := (case r.tipo when 'ENTRADA' then 'entrada' when 'SALIDA' then 'salida' when 'PAUSA' then 'inicio de pausa'
                 when 'REANUDAR' then 'vuelta de la pausa' when 'DESPLAZAMIENTO_INICIO' then 'salida de desplazamiento'
                 when 'DESPLAZAMIENTO_FIN' then 'llegada de desplazamiento' else 'cambio de cliente' end)
               || ' a las ' || to_char(r.m at time zone v_tz, 'HH24:MI');
      if r.anulado then
        v_t := 'Se anuló: ' || v_que || '. Motivo: ' || _motivo_registro(r.a_motivo) || '. Lo anuló ' || _nombre_miembro(p_org, r.anulado_por)
               || ' el ' || to_char(r.anulado_en at time zone v_tz, 'DD/MM/YYYY "a las" HH24:MI') || '.';
      elsif r.origen = 'RESPONSABLE' then
        v_t := 'Se añadió a mano: ' || v_que || '. Lo registró ' || _nombre_miembro(p_org, r.registrado_por)
               || ' el ' || to_char(r.momento at time zone v_tz, 'DD/MM/YYYY "a las" HH24:MI') || '. Motivo: ' || _motivo_registro(r.motivo) || '.';
      else
        v_t := 'Se añadió a mano: ' || v_que || '. Lo pidió ' || _nombre_miembro(p_org, r.registrado_por)
               || ' el ' || to_char(r.momento at time zone v_tz, 'DD/MM/YYYY "a las" HH24:MI') || '. Motivo: ' || _motivo_registro(r.motivo) || '. '
               || case when r.revisado_por is null then 'Aprobado.'
                       else 'Lo aprobó ' || _nombre_miembro(p_org, r.revisado_por)
                            || coalesce(' el ' || to_char(r.revisado_en at time zone v_tz, 'DD/MM/YYYY "a las" HH24:MI'), '') || '.' end;
      end if;
      v_cambios := v_cambios || '(' || v_n || ') ' || c_dias[extract(isodow from r.d)] || ' ' || to_char(r.d, 'DD/MM') || ' · ' || v_t || E'\n';
    end if;

    continue when r.anulado or not (r.origen = 'APP' or r.estado = 'APROBADA');

    -- Días: la misma cuenta que resumen_jornada, guardando los tramos de trabajo
    if v_dia is distinct from r.d then
      if v_dia is not null then
        if st = 'TRABAJANDO' then v_tramos := v_tramos || (to_char(t_ini at time zone v_tz, 'HH24:MI') || '–sin cerrar'); end if;
        v_lista := v_lista || jsonb_build_object('dia', v_dia, 'ent', v_ent, 'sal', v_sal, 'abierta', st in ('TRABAJANDO', 'PAUSA'),
                     'trab', v_trab, 'paus', v_paus, 'desp', v_desp, 'tramos', to_jsonb(v_tramos));
      end if;
      v_dia := r.d; st := 'FUERA'; t_ini := null; p_ini := null; d_ini := null;
      v_ent := null; v_sal := null; v_trab := 0; v_paus := 0; v_desp := 0; v_tramos := '{}';
    end if;
    case r.tipo
      when 'ENTRADA' then
        if st = 'FUERA' then st := 'TRABAJANDO'; t_ini := r.m; v_ent := coalesce(v_ent, r.m); end if;
      when 'PAUSA' then
        if st = 'TRABAJANDO' then
          v_trab := v_trab + extract(epoch from r.m - t_ini)::int / 60;
          v_tramos := v_tramos || (to_char(t_ini at time zone v_tz, 'HH24:MI') || '–' || to_char(r.m at time zone v_tz, 'HH24:MI'));
          st := 'PAUSA'; p_ini := r.m;
        end if;
      when 'REANUDAR' then
        if st = 'PAUSA' then v_paus := v_paus + extract(epoch from r.m - p_ini)::int / 60; st := 'TRABAJANDO'; t_ini := r.m; end if;
      when 'SALIDA' then
        if st = 'TRABAJANDO' then
          v_trab := v_trab + extract(epoch from r.m - t_ini)::int / 60;
          v_tramos := v_tramos || (to_char(t_ini at time zone v_tz, 'HH24:MI') || '–' || to_char(r.m at time zone v_tz, 'HH24:MI'));
        elsif st = 'PAUSA' then v_paus := v_paus + extract(epoch from r.m - p_ini)::int / 60;
        end if;
        st := 'FUERA'; v_sal := r.m;
      when 'DESPLAZAMIENTO_INICIO' then d_ini := r.m;
      when 'DESPLAZAMIENTO_FIN' then
        if d_ini is not null then v_desp := v_desp + extract(epoch from r.m - d_ini)::int / 60; d_ini := null; end if;
      else null;
    end case;
  end loop;
  if v_dia is not null then
    if st = 'TRABAJANDO' then v_tramos := v_tramos || (to_char(t_ini at time zone v_tz, 'HH24:MI') || '–sin cerrar'); end if;
    v_lista := v_lista || jsonb_build_object('dia', v_dia, 'ent', v_ent, 'sal', v_sal, 'abierta', st in ('TRABAJANDO', 'PAUSA'),
                 'trab', v_trab, 'paus', v_paus, 'desp', v_desp, 'tramos', to_jsonb(v_tramos));
  end if;

  v_con_desp := exists (select 1 from jsonb_array_elements(v_lista) e where (e->>'desp')::int > 0);
  v_txt := 'REGISTRO DIARIO DE JORNADA' || E'\n'
    || 'Empresa: ' || v_org.nombre || coalesce(' · NIF ' || nullif(trim(v_org.nif), ''), '') || E'\n'
    || 'Persona trabajadora: ' || coalesce(nullif(trim(v_m.nombre), ''), '—') || coalesce(' · NIF ' || nullif(trim(v_m.nif), ''), '') || E'\n'
    || 'Periodo: ' || c_meses[extract(month from p_periodo)] || ' de ' || extract(year from p_periodo)
    || ' (del ' || to_char(p_periodo, 'DD/MM/YYYY') || ' al ' || to_char(v_hasta, 'DD/MM/YYYY') || ')' || E'\n'
    || 'Horas en la hora local de ' || v_tz || E'\n\n';
  if jsonb_array_length(v_lista) = 0 then
    v_txt := v_txt || 'No hay jornadas registradas en este periodo.' || E'\n';
  else
    v_txt := v_txt || rtrim(rpad('Día', 10) || rpad('Entrada', 8) || rpad('Salida', 12) || lpad('Trabajo', 7) || lpad('Pausas', 7)
                          || case when v_con_desp then lpad('Desplaz.', 9) else '' end) || E'\n';
    for x in select e from jsonb_array_elements(v_lista) e loop
      v_dia := (x->>'dia')::date;
      dias := dias + 1; minutos := minutos + (x->>'trab')::int;
      v_pausas := v_pausas + (x->>'paus')::int; v_despl := v_despl + (x->>'desp')::int;
      if (x->>'abierta')::boolean then abiertos := abiertos + 1; end if;
      v_txt := v_txt || rtrim(
          rpad(c_dias[extract(isodow from v_dia)] || ' ' || to_char(v_dia, 'DD/MM'), 10)
        || rpad(coalesce(to_char((x->>'ent')::timestamptz at time zone v_tz, 'HH24:MI'), ''), 8)
        || rpad(case when (x->>'abierta')::boolean then 'sin cerrar' else coalesce(to_char((x->>'sal')::timestamptz at time zone v_tz, 'HH24:MI'), '') end, 12)
        || lpad(_hm((x->>'trab')::int), 7) || lpad(_hm((x->>'paus')::int), 7)
        || case when v_con_desp then lpad(_hm((x->>'desp')::int), 9) else '' end)
        || coalesce('  ' || (v_refs->>(v_dia::text)), '') || E'\n';
      if jsonb_array_length(x->'tramos') > 1 then
        v_txt := v_txt || repeat(' ', 10) || 'Tramos de trabajo: '
              || (select string_agg(t, ', ' order by o) from jsonb_array_elements_text(x->'tramos') with ordinality as z(t, o)) || E'\n';
      end if;
    end loop;
    v_txt := v_txt || E'\nTotal: ' || _hm(minutos) || ' de trabajo en ' || dias || (case when dias = 1 then ' día' else ' días' end)
          || '. Pausas: ' || _hm(v_pausas) || '.'
          || case when v_con_desp then ' Desplazamientos: ' || _hm(v_despl) || ' (incluidos en el trabajo).' else '' end || E'\n';
  end if;
  if v_n > 0 then v_txt := v_txt || E'\nCambios hechos a mano en el registro\n' || v_cambios; end if;
  documento := v_txt || E'\nRegistro diario de jornada (artículo 34.9 del Estatuto de los Trabajadores). La empresa lo conserva durante cuatro años'
    || ' a disposición de la persona trabajadora, de sus representantes legales y de la Inspección de Trabajo y Seguridad Social.' || E'\n';
  huella := encode(digest(convert_to(documento, 'UTF8'), 'sha256'), 'hex');
  return next;
end $$;

create or replace function public._motivo_registro(p text) returns text language sql immutable set search_path = public as $$
  select coalesce(nullif(regexp_replace(trim(coalesce(p, '')), '[.[:space:]]+$', ''), ''), '—')
$$;
revoke execute on function public._motivo_registro(text) from public, anon, authenticated;
revoke execute on function public._documento_registro_v2(uuid, uuid, date) from public, anon, authenticated;

-- El documento en el formato que se pida: para comprobar si una firma antigua sigue vigente
create or replace function public._documento_registro_formato(p_org uuid, p_user uuid, p_periodo date, p_formato int)
returns table (documento text, huella text, dias int, minutos int)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_formato = 1 then
    return query select x.documento, x.huella, x.dias, x.minutos from _documento_registro(p_org, p_user, p_periodo) x;
  else
    return query select x.documento, x.huella, x.dias, x.minutos from _documento_registro_v2(p_org, p_user, p_periodo) x;
  end if;
end $$;
revoke execute on function public._documento_registro_formato(uuid, uuid, date, int) from public, anon, authenticated;

-- Lo que ve la persona antes de firmar un mes. Si su última firma sigue vigente, se enseña el documento que firmó.
create or replace function public.registro_para_firmar(p_org uuid, p_periodo date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); d record; f firmas_registro; v_firmado text; v_tz text; v_pend int; v_vigente boolean;
begin
  if v_uid is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  p_periodo := date_trunc('month', p_periodo)::date;
  select coalesce(config->>'zona_horaria', 'Atlantic/Canary') into v_tz from organizaciones where id = p_org;
  select * into d from _documento_registro_v2(p_org, v_uid, p_periodo);
  select * into f from firmas_registro x where x.org_id = p_org and x.user_id = v_uid and x.periodo = p_periodo
   order by x.firmado_en desc limit 1;
  if f.id is not null then
    select x.huella into v_firmado from _documento_registro_formato(p_org, v_uid, p_periodo, f.formato) x;
  end if;
  v_vigente := f.huella is not null and f.huella = v_firmado;
  select count(*) into v_pend from fichajes x
   where x.org_id = p_org and x.user_id = v_uid and x.estado = 'PENDIENTE'
     and date_trunc('month', coalesce(x.momento_declarado, x.momento) at time zone v_tz)::date = p_periodo;
  return jsonb_build_object('periodo', p_periodo,
    'documento', case when v_vigente then f.documento else d.documento end,
    'huella', case when v_vigente then f.huella else d.huella end,
    'dias', d.dias, 'minutos', d.minutos, 'sin_cerrar', d.abiertos, 'pendientes', v_pend,
    'cerrado', (p_periodo + interval '1 month')::date <= (now() at time zone v_tz)::date,
    'vigente', v_vigente,
    'firma', case when f.id is null then null else jsonb_build_object('id', f.id, 'metodo', f.metodo, 'destino', f.destino, 'firmado_en', f.firmado_en, 'huella', f.huella) end);
end $$;

-- Común a los dos modos de firma: comprueba el mes y que el documento no ha cambiado. Se firma siempre el formato 2.
create or replace function public._insertar_firma(p_org uuid, p_periodo date, p_huella text, p_metodo text, p_destino text, p_cms text default null)
returns public.firmas_registro language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid(); d record; v_tz text; v_cms bytea; v_doc bytea; v_row firmas_registro;
begin
  if v_uid is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  p_periodo := date_trunc('month', p_periodo)::date;
  select coalesce(config->>'zona_horaria', 'Atlantic/Canary') into v_tz from organizaciones where id = p_org;
  if (p_periodo + interval '1 month')::date > (now() at time zone v_tz)::date then
    raise exception 'Solo se pueden firmar meses ya terminados';
  end if;
  select * into d from _documento_registro_v2(p_org, v_uid, p_periodo);
  if d.dias = 0 then raise exception 'No hay jornadas que firmar en ese mes'; end if;
  if p_huella is distinct from d.huella then
    raise exception 'El registro ha cambiado mientras lo mirabas. Vuelve a abrirlo antes de firmar.';
  end if;
  if exists (select 1 from firmas_registro x where x.org_id = p_org and x.user_id = v_uid and x.periodo = p_periodo and x.huella = d.huella) then
    raise exception 'Ya has firmado este registro';
  end if;
  if p_metodo = 'CERTIFICADO' then
    begin
      v_cms := decode(regexp_replace(coalesce(p_cms, ''), '-----[A-Z0-9 ]+-----|\s', '', 'g'), 'base64');
    exception when others then
      raise exception 'El archivo de firma no es válido';
    end;
    if length(v_cms) < 100 or length(v_cms) > 200000 or get_byte(v_cms, 0) <> 48 then   -- 48 = 0x30, inicio de una estructura DER
      raise exception 'El archivo de firma no es válido. Sube el .csig que genera AutoFirma.';
    end if;
    -- La firma lleva dentro el resumen del documento firmado: tiene que ser el de este documento
    v_doc := convert_to(d.documento, 'UTF8');
    if position(digest(v_doc, 'sha256') in v_cms) = 0 and position(digest(v_doc, 'sha512') in v_cms) = 0
       and position(digest(v_doc, 'sha384') in v_cms) = 0 then
      raise exception 'Esa firma no es del registro de este mes. Firma el documento que has descargado, sin cambiarlo.';
    end if;
    p_cms := encode(v_cms, 'base64');
  end if;
  insert into firmas_registro (org_id, user_id, periodo, documento, huella, dias, minutos, metodo, destino, firma_cms, formato)
  values (p_org, v_uid, p_periodo, d.documento, d.huella, d.dias, d.minutos, p_metodo, p_destino, p_cms, 2)
  returning * into v_row;
  return v_row;
end $$;
revoke execute on function public._insertar_firma(uuid, date, text, text, text, text) from public, anon, authenticated;

-- Para responsables: quién ha firmado un mes y si su firma sigue valiendo (con el formato en que se firmó)
create or replace function public.estado_firmas(p_org uuid, p_periodo date)
returns table (user_id uuid, nombre text, dias int, minutos int, firma_id uuid, metodo text, destino text, firmado_en timestamptz, vigente boolean)
language plpgsql stable security definer set search_path = public as $$
declare m record; d record; f firmas_registro; v_firmado text;
begin
  if not tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]) then raise exception 'Sin permiso'; end if;
  p_periodo := date_trunc('month', p_periodo)::date;
  for m in select x.user_id, x.nombre from miembros x where x.org_id = p_org order by x.nombre loop
    select * into d from _documento_registro_v2(p_org, m.user_id, p_periodo);
    f := null; v_firmado := null;
    select * into f from firmas_registro x where x.org_id = p_org and x.user_id = m.user_id and x.periodo = p_periodo
     order by x.firmado_en desc limit 1;
    continue when d.dias = 0 and f.id is null;
    if f.id is not null then
      select x.huella into v_firmado from _documento_registro_formato(p_org, m.user_id, p_periodo, f.formato) x;
    end if;
    user_id := m.user_id; nombre := m.nombre; dias := d.dias; minutos := d.minutos;
    firma_id := f.id; metodo := f.metodo; destino := f.destino; firmado_en := f.firmado_en;
    vigente := f.huella is not null and f.huella = v_firmado;
    return next;
  end loop;
end $$;

revoke execute on function public.registro_para_firmar(uuid, date), public.estado_firmas(uuid, date) from public, anon;

commit;
