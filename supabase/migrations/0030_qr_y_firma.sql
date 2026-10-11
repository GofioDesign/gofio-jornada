-- =====================================================================
-- GOFIO · 0030 · Fichar con código QR · Firma mensual del registro de jornada
--  QR
--  - puntos_qr: un código por sitio (taller, local, obra). Se imprime y se pega allí.
--    Al escanearlo con la cámara del móvil se abre la app con ?qr=<token>.
--  - fichar(…, p_qr): el fichaje queda marcado con el punto (punto_id) y, al empezar a
--    trabajar, toma el cliente o proyecto del punto si no se elige otro.
--  - El token se puede cambiar (renovar_qr) si alguien fotografía el código y ficha desde casa.
--  FIRMA
--  - Cada persona firma el registro de cada mes ya cerrado. El documento que se firma lo
--    genera el servidor (_documento_registro) y se guarda tal cual junto con su huella SHA-256.
--  - Con código (EMAIL o SMS): la app pide a Supabase Auth un código de un solo uso y lo
--    verifica; el servidor exige que el token de la sesión lleve una verificación por código
--    de los últimos 10 minutos (claim «amr»).
--  - Con certificado: la persona firma el documento con AutoFirma (CAdES) y sube el archivo.
--    Se comprueba que la firma es de ese documento exacto (su resumen va dentro) y se guarda
--    para poder validarla después con AutoFirma o VALIDe.
--  - Las firmas no se pueden modificar ni borrar. Si el registro cambia después (una
--    corrección aprobada), la firma deja de estar vigente y se puede volver a firmar.
-- =====================================================================

begin;

-- ---------- Puntos de fichaje con QR ----------
create table public.puntos_qr (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizaciones(id) on delete cascade,
  nombre      text not null check (length(trim(nombre)) between 1 and 60),
  cliente_id  uuid references public.clientes(id) on delete set null,
  proyecto_id uuid references public.proyectos(id) on delete set null,
  token       text not null unique default encode(gen_random_bytes(18), 'hex'),
  activo      boolean not null default true,
  creado_por  uuid default auth.uid() references auth.users(id),
  creado_en   timestamptz not null default now()
);
create index on public.puntos_qr (org_id);

alter table public.puntos_qr enable row level security;
create policy puntos_qr_sel on public.puntos_qr for select
  using (public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[]));
create policy puntos_qr_ins on public.puntos_qr for insert with check (
  public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])
  and (cliente_id is null or exists (select 1 from public.clientes c where c.id = cliente_id and c.org_id = puntos_qr.org_id))
  and (proyecto_id is null or exists (select 1 from public.proyectos p where p.id = proyecto_id and p.org_id = puntos_qr.org_id)));
create policy puntos_qr_upd on public.puntos_qr for update
  using (public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[]))
  with check (
  public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])
  and (cliente_id is null or exists (select 1 from public.clientes c where c.id = cliente_id and c.org_id = puntos_qr.org_id))
  and (proyecto_id is null or exists (select 1 from public.proyectos p where p.id = proyecto_id and p.org_id = puntos_qr.org_id)));
create policy puntos_qr_del on public.puntos_qr for delete using (public.puede_gestionar(org_id));
-- El token solo lo pone el servidor (al crear o con renovar_qr), y un punto no cambia de empresa
revoke insert, update on public.puntos_qr from authenticated;
grant insert (org_id, nombre, cliente_id, proyecto_id, activo) on public.puntos_qr to authenticated;
grant update (nombre, cliente_id, proyecto_id, activo) on public.puntos_qr to authenticated;

create or replace function public.renovar_qr(p_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v puntos_qr;
begin
  select * into v from puntos_qr where id = p_id;
  if not found or not tiene_rol(v.org_id, array['propietario','admin','responsable']::rol_miembro[]) then raise exception 'Sin permiso'; end if;
  update puntos_qr set token = encode(gen_random_bytes(18), 'hex') where id = p_id returning token into v.token;
  return v.token;
end $$;

-- Lo que la app necesita al escanear: solo si quien escanea es de esa empresa y el punto sigue activo
create or replace function public.punto_qr(p_token text)
returns table (id uuid, org_id uuid, nombre text, cliente_id uuid, proyecto_id uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  return query select p.id, p.org_id, p.nombre, p.cliente_id, p.proyecto_id from puntos_qr p
    where p.token = p_token and p.activo and es_miembro(p.org_id);
  if not found then raise exception 'Este código QR no es de tu empresa o ya no está activo'; end if;
end $$;

-- ---------- Fichajes: de qué punto QR vienen ----------
alter table public.fichajes add column punto_id uuid references public.puntos_qr(id) on delete restrict;

drop function public._insertar_fichaje(uuid, uuid, public.tipo_fichaje, double precision, double precision, real, uuid, text, text, timestamptz, uuid, text, text, uuid);
create or replace function public._insertar_fichaje(
  p_org uuid, p_user uuid, p_tipo tipo_fichaje, p_lat double precision, p_lng double precision, p_prec real,
  p_cliente uuid, p_nota text, p_origen text default 'APP', p_declarado timestamptz default null,
  p_corrige uuid default null, p_motivo text default null, p_estado text default null, p_proyecto uuid default null,
  p_punto uuid default null)
returns public.fichajes language plpgsql security definer set search_path = public, extensions as $$
declare v_prev text; v_row fichajes; v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('fichaje:' || p_org || ':' || p_user));
  select huella into v_prev from fichajes where org_id = p_org and user_id = p_user order by momento desc, id desc limit 1;
  insert into fichajes (org_id, user_id, tipo, momento, lat, lng, precision_m, cliente_id, proyecto_id, punto_id, nota, origen,
                        momento_declarado, corrige_a, motivo, estado, registrado_por, huella_anterior, huella)
  values (p_org, p_user, p_tipo, v_now, p_lat, p_lng, p_prec, p_cliente, p_proyecto, p_punto, p_nota, p_origen,
          p_declarado, p_corrige, p_motivo, p_estado, coalesce(auth.uid(), p_user), v_prev,
          encode(digest(concat_ws('|', coalesce(v_prev, ''), p_org, p_user, p_tipo,
                   to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                   coalesce(p_lat::text, ''), coalesce(p_lng::text, ''), coalesce(p_cliente::text, ''),
                   p_origen, coalesce(to_char(p_declarado at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
                   p_proyecto::text, 'qr:' || p_punto), 'sha256'), 'hex'))   -- concat_ws omite los NULL: sin proyecto ni QR, la huella es la de siempre
  returning * into v_row;
  return v_row;
end $$;
revoke execute on function public._insertar_fichaje from public, anon, authenticated;

drop function public.fichar(uuid, public.tipo_fichaje, double precision, double precision, real, uuid, text, uuid);
create or replace function public.fichar(
  p_org uuid, p_tipo public.tipo_fichaje,
  p_lat double precision default null, p_lng double precision default null, p_precision real default null,
  p_cliente uuid default null, p_nota text default null, p_proyecto uuid default null, p_qr text default null)
returns setof public.fichajes language plpgsql security definer set search_path = public as $$
declare e record; v_uid uuid := auth.uid(); v_punto puntos_qr;
begin
  if v_uid is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  if not modulo_activo(p_org, 'jornada') then raise exception 'El módulo de jornada no está activo' using hint = 'LIMITE_PLAN'; end if;
  -- Fichaje con QR: el punto tiene que ser de esta empresa y estar activo.
  -- Al empezar a trabajar (o al llegar) se toma su cliente o proyecto si no se elige otro.
  if p_qr is not null then
    select * into v_punto from puntos_qr where token = p_qr and org_id = p_org and activo;
    if not found then raise exception 'Este código QR no es de tu empresa o ya no está activo'; end if;
    if p_tipo in ('ENTRADA', 'CAMBIO_CLIENTE') and p_cliente is null and p_proyecto is null then
      p_cliente := v_punto.cliente_id; p_proyecto := v_punto.proyecto_id;
    elsif p_tipo = 'DESPLAZAMIENTO_FIN' and p_cliente is null then
      p_cliente := v_punto.cliente_id;
    end if;
  end if;
  -- El proyecto solo se indica al empezar a trabajar en algo (ENTRADA o CAMBIO_CLIENTE)
  if p_proyecto is not null then
    if p_tipo not in ('ENTRADA', 'CAMBIO_CLIENTE') then p_proyecto := null;
    else p_cliente := _cliente_de_proyecto(p_org, p_proyecto, p_cliente);
    end if;
  end if;
  select * into e from estado_jornada(p_org, v_uid);

  if p_tipo = 'ENTRADA' then
    if e.estado <> 'FUERA' then raise exception 'Ya tienes la jornada iniciada'; end if;
  elsif p_tipo = 'PAUSA' then
    if e.estado <> 'TRABAJANDO' then raise exception 'No estás trabajando ahora mismo'; end if;
  elsif p_tipo = 'REANUDAR' then
    if e.estado <> 'PAUSA' then raise exception 'No estás en pausa'; end if;
  elsif p_tipo = 'SALIDA' then
    if e.estado = 'FUERA' then raise exception 'No has iniciado la jornada'; end if;
    if e.desplazamiento_abierto then
      return next _insertar_fichaje(p_org, v_uid, 'DESPLAZAMIENTO_FIN', p_lat, p_lng, p_precision, e.cliente_id, 'Cerrado al finalizar la jornada');
    end if;
  elsif p_tipo = 'DESPLAZAMIENTO_INICIO' then
    if e.desplazamiento_abierto then raise exception 'Ya hay un desplazamiento en curso'; end if;
    if e.estado = 'FUERA' then
      return next _insertar_fichaje(p_org, v_uid, 'ENTRADA', p_lat, p_lng, p_precision, null, 'Inicio al salir de desplazamiento');
    elsif e.estado = 'PAUSA' then
      return next _insertar_fichaje(p_org, v_uid, 'REANUDAR', p_lat, p_lng, p_precision, null, null);
    end if;
  elsif p_tipo = 'DESPLAZAMIENTO_FIN' then
    if not e.desplazamiento_abierto then raise exception 'No hay ningún desplazamiento en curso'; end if;
    p_cliente := coalesce(p_cliente, e.cliente_id);
  elsif p_tipo = 'CAMBIO_CLIENTE' then
    if e.estado <> 'TRABAJANDO' then raise exception 'Inicia la jornada antes de elegir cliente'; end if;
    if p_cliente is null and p_proyecto is null then raise exception 'Elige un cliente o un proyecto'; end if;
  end if;

  return next _insertar_fichaje(p_org, v_uid, p_tipo, p_lat, p_lng, p_precision, p_cliente, p_nota,
                                p_proyecto => p_proyecto, p_punto => v_punto.id);
end $$;

-- ---------- Firma del registro ----------
create table public.firmas_registro (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizaciones(id) on delete restrict,
  user_id     uuid not null references auth.users(id) on delete restrict,
  periodo     date not null check (extract(day from periodo) = 1),   -- primer día del mes firmado
  documento   text not null,                    -- el texto exacto que se firmó
  huella      text not null,                    -- sha256 del documento (UTF-8), en hex
  dias        int not null,
  minutos     int not null,
  metodo      text not null check (metodo in ('EMAIL', 'SMS', 'CERTIFICADO')),
  destino     text,                             -- email o teléfono al que llegó el código
  firma_cms   text,                             -- firma CAdES en base64 (solo con certificado)
  firmado_en  timestamptz not null default now(),
  unique (org_id, user_id, periodo, huella),
  constraint firma_certificado check ((metodo = 'CERTIFICADO') = (firma_cms is not null))
);
create index on public.firmas_registro (org_id, periodo);

create or replace function public.firmas_inmutables() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'Las firmas del registro no se pueden modificar ni borrar';
end $$;
revoke execute on function public.firmas_inmutables() from public, anon, authenticated;
create trigger firmas_registro_inmutables before update or delete on public.firmas_registro
  for each row execute function public.firmas_inmutables();

alter table public.firmas_registro enable row level security;
create policy firmas_registro_sel on public.firmas_registro for select using (
  public.es_miembro(org_id) and (user_id = auth.uid()
    or public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])));
-- Sin políticas de insert/update/delete: solo con las funciones de abajo.

create or replace function public._hm(p_min int) returns text language sql immutable set search_path = public as $$
  select (coalesce(p_min, 0) / 60) || ':' || lpad((coalesce(p_min, 0) % 60)::text, 2, '0')
$$;

-- Documento del mes de una persona: cabecera y una línea por día con jornada.
-- Lo llaman funciones que ya han comprobado que quien pide es esa persona o un responsable.
create or replace function public._documento_registro(p_org uuid, p_user uuid, p_periodo date)
returns table (documento text, huella text, dias int, minutos int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_org organizaciones; v_m miembros; v_tz text; v_hasta date; r record; v_txt text;
begin
  select * into v_org from organizaciones o where o.id = p_org;
  select * into v_m from miembros m where m.org_id = p_org and m.user_id = p_user;
  v_tz := coalesce(v_org.config->>'zona_horaria', 'Atlantic/Canary');
  v_hasta := (p_periodo + interval '1 month' - interval '1 day')::date;
  dias := 0; minutos := 0;
  v_txt := 'REGISTRO DE JORNADA' || E'\n'
    || 'Empresa: ' || v_org.nombre || coalesce(' · NIF ' || nullif(trim(v_org.nif), ''), '') || E'\n'
    || 'Persona: ' || coalesce(nullif(trim(v_m.nombre), ''), '—') || coalesce(' · NIF ' || nullif(trim(v_m.nif), ''), '') || E'\n'
    || 'Periodo: del ' || to_char(p_periodo, 'YYYY-MM-DD') || ' al ' || to_char(v_hasta, 'YYYY-MM-DD') || ' (hora de ' || v_tz || ')' || E'\n\n'
    || 'Día;Entrada;Salida;Trabajo;Pausas;Desplazamientos;Correcciones' || E'\n';
  for r in select * from resumen_jornada(p_org, p_periodo, v_hasta, p_user) x order by x.dia loop
    dias := dias + 1; minutos := minutos + r.minutos_trabajo;
    v_txt := v_txt || concat_ws(';', to_char(r.dia, 'YYYY-MM-DD'),
      coalesce(to_char(r.primera_entrada at time zone v_tz, 'HH24:MI'), ''),
      case when r.abierta then 'sin cerrar' else coalesce(to_char(r.ultima_salida at time zone v_tz, 'HH24:MI'), '') end,
      _hm(r.minutos_trabajo), _hm(r.minutos_pausa), _hm(r.minutos_desplazamiento), r.correcciones) || E'\n';
  end loop;
  documento := v_txt || E'\nTotal: ' || _hm(minutos) || ' de trabajo en ' || dias || (case when dias = 1 then ' día' else ' días' end) || E'\n';
  huella := encode(digest(convert_to(documento, 'UTF8'), 'sha256'), 'hex');
  return next;
end $$;
revoke execute on function public._documento_registro(uuid, uuid, date) from public, anon, authenticated;

-- ¿El token de la sesión viene de verificar un código hace menos de 10 minutos?
-- Supabase Auth anota cada verificación en el claim «amr» (método y momento).
create or replace function public._codigo_reciente() returns boolean
language sql stable set search_path = public as $$
  select exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(auth.jwt()->'amr') = 'array' then auth.jwt()->'amr' else '[]'::jsonb end) a
     where a->>'method' in ('otp', 'magiclink', 'email/signup', 'sms/signup', 'phone_change', 'email_change')
       and (a->>'timestamp') ~ '^\d+$' and (a->>'timestamp')::bigint >= extract(epoch from now())::bigint - 600)
$$;
revoke execute on function public._codigo_reciente() from public, anon, authenticated;

-- Lo que ve la persona antes de firmar un mes: el documento, su huella y la última firma
create or replace function public.registro_para_firmar(p_org uuid, p_periodo date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); d record; f firmas_registro; v_tz text;
begin
  if v_uid is null or not es_miembro(p_org) then raise exception 'Sin permiso'; end if;
  p_periodo := date_trunc('month', p_periodo)::date;
  select coalesce(config->>'zona_horaria', 'Atlantic/Canary') into v_tz from organizaciones where id = p_org;
  select * into d from _documento_registro(p_org, v_uid, p_periodo);
  select * into f from firmas_registro x where x.org_id = p_org and x.user_id = v_uid and x.periodo = p_periodo
   order by x.firmado_en desc limit 1;
  return jsonb_build_object('periodo', p_periodo, 'documento', d.documento, 'huella', d.huella, 'dias', d.dias, 'minutos', d.minutos,
    'cerrado', (p_periodo + interval '1 month')::date <= (now() at time zone v_tz)::date,
    'vigente', f.huella is not null and f.huella = d.huella,
    'firma', case when f.id is null then null else jsonb_build_object('id', f.id, 'metodo', f.metodo, 'destino', f.destino, 'firmado_en', f.firmado_en, 'huella', f.huella) end);
end $$;

-- Común a los dos modos de firma: comprueba el mes y que el documento no ha cambiado
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
  select * into d from _documento_registro(p_org, v_uid, p_periodo);
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
  insert into firmas_registro (org_id, user_id, periodo, documento, huella, dias, minutos, metodo, destino, firma_cms)
  values (p_org, v_uid, p_periodo, d.documento, d.huella, d.dias, d.minutos, p_metodo, p_destino, p_cms)
  returning * into v_row;
  return v_row;
end $$;
revoke execute on function public._insertar_firma(uuid, date, text, text, text, text) from public, anon, authenticated;

-- Firma con el código que acaba de llegar por correo o SMS
create or replace function public.firmar_registro(p_org uuid, p_periodo date, p_huella text, p_canal text)
returns public.firmas_registro language plpgsql security definer set search_path = public as $$
declare v_destino text;
begin
  if p_canal not in ('EMAIL', 'SMS') then raise exception 'Elige cómo recibir el código'; end if;
  if not _codigo_reciente() then
    raise exception 'Escribe el código que te hemos enviado antes de firmar' using hint = 'CODIGO_FIRMA';
  end if;
  v_destino := nullif(trim(case p_canal when 'EMAIL' then auth.jwt()->>'email' else auth.jwt()->>'phone' end), '');
  if v_destino is null then
    raise exception '%', case p_canal when 'EMAIL' then 'Tu cuenta no tiene email' else 'Tu cuenta no tiene un teléfono confirmado' end;
  end if;
  return _insertar_firma(p_org, p_periodo, p_huella, p_canal, v_destino);
end $$;

-- Firma con certificado digital: el archivo CAdES (.csig) en base64
create or replace function public.firmar_registro_certificado(p_org uuid, p_periodo date, p_huella text, p_firma text)
returns public.firmas_registro language plpgsql security definer set search_path = public as $$
begin
  return _insertar_firma(p_org, p_periodo, p_huella, 'CERTIFICADO', null, p_firma);
end $$;

-- Para responsables: quién ha firmado un mes y si su firma sigue valiendo
create or replace function public.estado_firmas(p_org uuid, p_periodo date)
returns table (user_id uuid, nombre text, dias int, minutos int, firma_id uuid, metodo text, destino text, firmado_en timestamptz, vigente boolean)
language plpgsql stable security definer set search_path = public as $$
declare m record; d record; f firmas_registro;
begin
  if not tiene_rol(p_org, array['propietario','admin','responsable']::rol_miembro[]) then raise exception 'Sin permiso'; end if;
  p_periodo := date_trunc('month', p_periodo)::date;
  for m in select x.user_id, x.nombre from miembros x where x.org_id = p_org order by x.nombre loop
    select * into d from _documento_registro(p_org, m.user_id, p_periodo);
    f := null;
    select * into f from firmas_registro x where x.org_id = p_org and x.user_id = m.user_id and x.periodo = p_periodo
     order by x.firmado_en desc limit 1;
    continue when d.dias = 0 and f.id is null;
    user_id := m.user_id; nombre := m.nombre; dias := d.dias; minutos := d.minutos;
    firma_id := f.id; metodo := f.metodo; destino := f.destino; firmado_en := f.firmado_en;
    vigente := f.huella is not null and f.huella = d.huella;
    return next;
  end loop;
end $$;

revoke execute on function public.renovar_qr(uuid), public.punto_qr(text),
  public.fichar(uuid, public.tipo_fichaje, double precision, double precision, real, uuid, text, uuid, text),
  public._hm(int), public.registro_para_firmar(uuid, date), public.firmar_registro(uuid, date, text, text),
  public.firmar_registro_certificado(uuid, date, text, text), public.estado_firmas(uuid, date) from public, anon;

commit;
