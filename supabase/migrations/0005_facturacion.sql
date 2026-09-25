-- =====================================================================
-- GOFIO · 0005 · Módulo FACTURACIÓN (solo testers seleccionados)
-- Reglas heredadas de la v7 en Google Sheets:
--  - Numeración correlativa por serie y año (EMIT26-0001), sin huecos, fecha no anterior a la última.
--  - Las facturas no se borran ni se modifican: se corrigen con una rectificativa.
--  - Huella SHA-256 encadenada con el MISMO formato que la v7, para continuar la cadena migrada:
--      sha256(prev | NUM | dd/MM/yyyy | CLIENTE_ID | base | igic | irpf | total)
--  - Importes en céntimos al calcular; IGIC agrupado por tipo; IRPF sobre la base.
-- =====================================================================

create table public.facturas (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizaciones(id) on delete restrict,
  num             text not null,
  serie           text not null,
  tipo_doc        text not null default 'FACTURA' check (tipo_doc in ('FACTURA', 'RECTIFICATIVA')),
  fecha           date not null,
  vencimiento     date,
  cliente_id      uuid references public.clientes(id) on delete restrict,
  cliente_codigo  text not null,            -- NIF en el momento de emitir
  cliente         jsonb not null,           -- datos fiscales congelados del cliente
  emisor          jsonb not null,           -- datos fiscales congelados del emisor
  periodo_desde   date,
  periodo_hasta   date,
  concepto        text,
  base            numeric(12,2) not null,
  igic            numeric(12,2) not null,
  irpf_pct        numeric(5,2) not null default 0,
  irpf            numeric(12,2) not null default 0,
  total           numeric(12,2) not null,
  coste           numeric(12,2) not null default 0,
  igic_desglose   jsonb not null default '[]',
  estado          text not null default 'EMITIDA' check (estado in ('EMITIDA', 'RECTIFICADA', 'HISTORICA', 'ANULADA')),
  rectifica_a     uuid references public.facturas(id),
  motivo          text,
  presupuesto_id  uuid,
  observaciones   text,
  pdf_url         text,
  pdf_firmado_url text,
  fecha_firma     timestamptz,
  huella_anterior text,
  huella          text not null,
  emitida_por     uuid references auth.users(id),
  emitida_en      timestamptz not null default now(),
  unique (org_id, num)
);
create index on public.facturas (org_id, fecha);

create table public.facturas_lineas (
  id          uuid primary key default gen_random_uuid(),
  factura_id  uuid not null references public.facturas(id) on delete restrict,
  linea       int not null,
  producto_id uuid references public.productos(id) on delete set null,
  codigo      text,
  descripcion text not null,
  cantidad    numeric(12,3) not null,
  unidad      text not null default 'ud',
  pvp_ud      numeric(12,2) not null,
  dto_pct     numeric(5,2) not null default 0,
  base        numeric(12,2) not null,
  igic_pct    numeric(5,2) not null,
  igic        numeric(12,2) not null,
  coste_ud    numeric(12,2) not null default 0,
  familia     text,
  unique (factura_id, linea)
);

create table public.presupuestos (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizaciones(id) on delete cascade,
  num           text not null,
  fecha         date not null,
  valido_hasta  date,
  cliente_id    uuid references public.clientes(id),
  datos         jsonb not null,                -- cabecera + líneas (se congela al pasar a factura)
  base          numeric(12,2) not null default 0,
  igic          numeric(12,2) not null default 0,
  irpf          numeric(12,2) not null default 0,
  total         numeric(12,2) not null default 0,
  anticipo      numeric(12,2) not null default 0,
  estado        text not null default 'ENVIADO' check (estado in ('BORRADOR','ENVIADO','ACEPTADO','RECHAZADO','FACTURADO','CADUCADO')),
  factura_id    uuid references public.facturas(id),
  pdf_url       text,
  observaciones text,
  creado_en     timestamptz not null default now(),
  unique (org_id, num)
);

create table public.borradores (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizaciones(id) on delete cascade,
  tipo           text not null check (tipo in ('FACTURA','PRESUPUESTO')),
  cliente_id     uuid references public.clientes(id) on delete set null,
  datos          jsonb not null,
  total          numeric(12,2),
  autor          uuid default auth.uid() references auth.users(id),
  actualizado_en timestamptz not null default now()
);
create trigger borradores_upd before update on public.borradores for each row execute function public.tocar_actualizado();

create table public.cobros (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizaciones(id) on delete cascade,
  factura_id  uuid not null references public.facturas(id) on delete restrict,
  fecha       date not null default current_date,
  importe     numeric(12,2) not null,
  medio       text not null default 'TRANSFERENCIA',
  notas       text,
  creado_en   timestamptz not null default now()
);

create table public.gastos (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizaciones(id) on delete cascade,
  fecha            date not null,
  proveedor_id     uuid references public.proveedores(id) on delete set null,
  proveedor_nombre text,
  num_factura_prov text,
  concepto         text,
  categoria        text not null default 'OTROS',
  base             numeric(12,2) not null default 0,
  igic_pct         numeric(5,2) not null default 7,
  igic             numeric(12,2) not null default 0,
  igic_deducible   boolean,
  irpf_retenido    numeric(12,2) not null default 0,
  total            numeric(12,2) not null default 0,
  deducible        boolean not null default true,
  pagado           boolean not null default true,
  adjunto_url      text,
  notas            text
);
create index on public.gastos (org_id, fecha);

create table public.impuestos (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizaciones(id) on delete cascade,
  periodo            text not null,     -- '2026-T3' o '2026-09'
  modelo             text not null,     -- '420', '130', ...
  estimado           numeric(12,2),
  pagado             numeric(12,2),
  fecha_presentacion date,
  justificante_url   text,
  notas              text,
  unique (org_id, periodo, modelo)
);

-- ---------- Horas de JORNADA facturadas a clientes ----------
create table public.horas_facturadas (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizaciones(id) on delete cascade,
  factura_id  uuid not null references public.facturas(id) on delete restrict,
  cliente_id  uuid not null references public.clientes(id) on delete restrict,
  user_id     uuid not null references auth.users(id),
  dia         date not null,
  tipo        text not null check (tipo in ('TRABAJO', 'DESPLAZAMIENTO')),
  minutos     int not null,
  km          numeric(8,2),
  unique (org_id, cliente_id, user_id, dia, tipo)
);

-- Horas y desplazamientos de un cliente aún SIN facturar (agrupados por persona y día)
create or replace function public.horas_pendientes(p_org uuid, p_cliente uuid, p_desde date, p_hasta date)
returns table (user_id uuid, nombre text, dia date, tipo text, minutos int, km numeric, tramos int)
language sql stable security definer set search_path = public as $$
  select t.user_id, m.nombre, t.dia, t.tipo, sum(t.minutos)::int, sum(t.km), count(*)::int
  from tramos_jornada(p_org, p_desde, p_hasta, null) t
  left join miembros m on m.org_id = p_org and m.user_id = t.user_id
  where public.puede_facturar(p_org)
    and t.cliente_id = p_cliente and t.tipo in ('TRABAJO', 'DESPLAZAMIENTO') and t.fin is not null
    and not exists (select 1 from horas_facturadas h where h.org_id = p_org and h.cliente_id = p_cliente
                    and h.user_id = t.user_id and h.dia = t.dia and h.tipo = t.tipo)
  group by t.user_id, m.nombre, t.dia, t.tipo
  order by t.dia, m.nombre, t.tipo;
$$;

-- ---------- Vista con estado de cobro (sustituye COBRADO/PENDIENTE y la hoja PENDIENTES) ----------
create view public.v_facturas with (security_invoker = true) as
select f.*,
       coalesce(c.cobrado, 0)                        as cobrado,
       f.total - coalesce(c.cobrado, 0)              as pendiente,
       case when f.estado in ('RECTIFICADA','ANULADA','HISTORICA') then f.estado
            when f.total - coalesce(c.cobrado, 0) <= 0 then 'COBRADA'
            when coalesce(c.cobrado, 0) > 0 then 'PARCIAL'
            when f.vencimiento < current_date then 'VENCIDA'
            else 'PENDIENTE' end                     as estado_cobro
from public.facturas f
left join (select factura_id, sum(importe) cobrado from public.cobros group by factura_id) c on c.factura_id = f.id;

-- ---------- Inmutabilidad ----------
create or replace function public.facturas_inmutables() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Las facturas no se borran: emite una rectificativa'; end if;
  if (to_jsonb(new) - array['estado','pdf_url','pdf_firmado_url','fecha_firma','observaciones'])
     is distinct from (to_jsonb(old) - array['estado','pdf_url','pdf_firmado_url','fecha_firma','observaciones']) then
    raise exception 'Una factura emitida no se puede modificar: emite una rectificativa';
  end if;
  return new;
end $$;
create trigger facturas_inmutables before update or delete on public.facturas
  for each row execute function public.facturas_inmutables();

create or replace function public.lineas_inmutables() returns trigger language plpgsql as $$
begin raise exception 'Las líneas de una factura emitida no se pueden cambiar'; end $$;
create trigger lineas_inmutables before update or delete on public.facturas_lineas
  for each row execute function public.lineas_inmutables();

-- ---------- Cálculo (idéntico a calc_ de la v7) ----------
-- p_lineas: [{codigo, descripcion, cantidad, unidad, pvp, dto (0-100), igic (0-100), coste, familia, producto_id}]
create or replace function public.calcular_documento(p_lineas jsonb, p_irpf_pct numeric)
returns jsonb language plpgsql immutable as $$
declare l jsonb; b bigint; base bigint := 0; coste bigint := 0; igic bigint := 0; irpf bigint;
        rates jsonb := '{}'; k text; out_lines jsonb := '[]'; desglose jsonb := '[]'; i int := 0;
begin
  for l in select * from jsonb_array_elements(p_lineas) loop
    i := i + 1;
    b := round((l->>'cantidad')::numeric * (l->>'pvp')::numeric * (1 - coalesce((l->>'dto')::numeric, 0) / 100) * 100);
    base := base + b;
    coste := coste + round((l->>'cantidad')::numeric * coalesce((l->>'coste')::numeric, 0) * 100);
    k := (coalesce((l->>'igic')::numeric, 0))::text;
    rates := jsonb_set(rates, array[k], to_jsonb(coalesce((rates->>k)::bigint, 0) + b));
    out_lines := out_lines || jsonb_build_object('linea', i, 'base', b / 100.0,
                  'igic', round(b * coalesce((l->>'igic')::numeric, 0) / 100) / 100.0);
  end loop;
  for k in select jsonb_object_keys(rates) order by 1 loop
    desglose := desglose || jsonb_build_object('pct', k::numeric, 'base', (rates->>k)::bigint / 100.0,
                  'cuota', round((rates->>k)::bigint * k::numeric / 100) / 100.0);
    igic := igic + round((rates->>k)::bigint * k::numeric / 100);
  end loop;
  irpf := round(base * coalesce(p_irpf_pct, 0) / 100);
  return jsonb_build_object('base', base / 100.0, 'igic', igic / 100.0, 'irpf', irpf / 100.0,
    'total', (base + igic - irpf) / 100.0, 'coste', coste / 100.0, 'margen', (base - coste) / 100.0,
    'igic_desglose', desglose, 'lineas', out_lines);
end $$;

-- ---------- EMITIR FACTURA ----------
create or replace function public.emitir_factura(
  p_org uuid, p_cliente uuid, p_fecha date, p_lineas jsonb,
  p_irpf_pct numeric default null, p_observaciones text default null,
  p_periodo_desde date default null, p_periodo_hasta date default null,
  p_presupuesto uuid default null, p_rectifica uuid default null, p_motivo text default null,
  p_horas jsonb default null)   -- tramos de JORNADA que se facturan: [{user_id, dia, tipo, minutos, km}]
returns public.facturas language plpgsql security definer set search_path = public, extensions as $$
declare
  o organizaciones; c clientes; t jsonb; v_serie text; v_num text; v_max int; v_last date; v_prev text;
  v_irpf numeric; v_f facturas; l jsonb; i int := 0; v_tipo text := 'FACTURA';
begin
  if not puede_facturar(p_org) then raise exception 'Sin permiso para facturar'; end if;
  if jsonb_array_length(coalesce(p_lineas, '[]')) = 0 then raise exception 'La factura no tiene líneas'; end if;
  select * into o from organizaciones where id = p_org;
  select * into c from clientes where id = p_cliente and org_id = p_org;
  if not found then raise exception 'Cliente no encontrado'; end if;
  if coalesce(c.codigo, '') = '' or coalesce(c.nombre, '') = '' then raise exception 'El cliente necesita NIF y nombre'; end if;

  v_irpf := coalesce(p_irpf_pct, case when c.aplica_irpf then coalesce(c.irpf_pct, (o.config->>'irpf_defecto')::numeric) else 0 end);
  t := calcular_documento(p_lineas, v_irpf);

  if p_rectifica is not null then
    v_tipo := 'RECTIFICATIVA';
    if coalesce(trim(p_motivo), '') = '' then raise exception 'Indica el motivo de la rectificación'; end if;
  end if;
  v_serie := coalesce(o.config->>case when p_rectifica is null then 'serie_factura' else 'serie_rectificativa' end,
                      case when p_rectifica is null then 'EMIT' else 'RECT' end) || to_char(p_fecha, 'YY');

  perform pg_advisory_xact_lock(hashtext('factura:' || p_org));
  select coalesce(max(substring(num from '-(\d+)$')::int), 0), max(fecha) into v_max, v_last
    from facturas where org_id = p_org and serie = v_serie;
  if v_last is not null and p_fecha < v_last then
    raise exception 'La fecha (%) no puede ser anterior a la última factura de la serie (%)', p_fecha, v_last;
  end if;
  v_num := v_serie || '-' || lpad((v_max + 1)::text, 4, '0');
  select huella into v_prev from facturas where org_id = p_org order by emitida_en desc, num desc limit 1;

  insert into facturas (org_id, num, serie, tipo_doc, fecha, vencimiento, cliente_id, cliente_codigo, cliente, emisor,
                        periodo_desde, periodo_hasta, concepto, base, igic, irpf_pct, irpf, total, coste, igic_desglose,
                        rectifica_a, motivo, presupuesto_id, observaciones, huella_anterior, huella, emitida_por)
  values (p_org, v_num, v_serie, v_tipo, p_fecha, p_fecha + coalesce((o.config->>'dias_vencimiento')::int, 30),
          c.id, c.codigo, to_jsonb(c) - array['id','org_id','lat','lng','notas','creado_en','actualizado_en'],
          jsonb_build_object('marca', o.nombre, 'titular', o.titular, 'nif', o.nif, 'direccion', o.direccion, 'cp', o.cp,
                             'localidad', o.localidad, 'provincia', o.provincia, 'email', o.email, 'telefono', o.telefono,
                             'web', o.web, 'iban', o.iban, 'bic', o.bic, 'pago', o.config->>'medio_pago_texto'),
          p_periodo_desde, p_periodo_hasta,
          left((select string_agg(x->>'descripcion', ' · ') from jsonb_array_elements(p_lineas) x), 250),
          (t->>'base')::numeric, (t->>'igic')::numeric, v_irpf, (t->>'irpf')::numeric, (t->>'total')::numeric,
          (t->>'coste')::numeric, t->'igic_desglose', p_rectifica, p_motivo, p_presupuesto, p_observaciones, v_prev,
          encode(digest(concat_ws('|', coalesce(v_prev, ''), v_num, to_char(p_fecha, 'DD/MM/YYYY'), c.codigo,
                  to_char((t->>'base')::numeric, 'FM999999990.00'), to_char((t->>'igic')::numeric, 'FM999999990.00'),
                  to_char((t->>'irpf')::numeric, 'FM999999990.00'), to_char((t->>'total')::numeric, 'FM999999990.00')), 'sha256'), 'hex'),
          auth.uid())
  returning * into v_f;

  for l in select * from jsonb_array_elements(p_lineas) loop
    i := i + 1;
    insert into facturas_lineas (factura_id, linea, producto_id, codigo, descripcion, cantidad, unidad, pvp_ud, dto_pct,
                                 base, igic_pct, igic, coste_ud, familia)
    values (v_f.id, i, nullif(l->>'producto_id', '')::uuid, l->>'codigo', l->>'descripcion', (l->>'cantidad')::numeric,
            coalesce(l->>'unidad', 'ud'), (l->>'pvp')::numeric, coalesce((l->>'dto')::numeric, 0),
            (t->'lineas'->(i-1)->>'base')::numeric, coalesce((l->>'igic')::numeric, 0), (t->'lineas'->(i-1)->>'igic')::numeric,
            coalesce((l->>'coste')::numeric, 0), l->>'familia');
  end loop;

  if p_horas is not null then
    insert into horas_facturadas (org_id, factura_id, cliente_id, user_id, dia, tipo, minutos, km)
    select p_org, v_f.id, c.id, (h->>'user_id')::uuid, (h->>'dia')::date, h->>'tipo', (h->>'minutos')::int, nullif(h->>'km', '')::numeric
    from jsonb_array_elements(p_horas) h;   -- la restricción única impide facturar dos veces las mismas horas
  end if;

  if p_rectifica is not null then update facturas set estado = 'RECTIFICADA' where id = p_rectifica and org_id = p_org; end if;
  if p_presupuesto is not null then update presupuestos set estado = 'FACTURADO', factura_id = v_f.id where id = p_presupuesto and org_id = p_org; end if;
  return v_f;
end $$;

-- Comprobar la cadena de huellas (equivale a "Comprobar integridad" de la v7)
create or replace function public.comprobar_integridad(p_org uuid)
returns table (num text, ok boolean) language sql stable security definer set search_path = public, extensions as $$
  select f.num,
         f.huella = encode(digest(concat_ws('|', coalesce(f.huella_anterior, ''), f.num, to_char(f.fecha, 'DD/MM/YYYY'), f.cliente_codigo,
            to_char(f.base, 'FM999999990.00'), to_char(f.igic, 'FM999999990.00'), to_char(f.irpf, 'FM999999990.00'),
            to_char(f.total, 'FM999999990.00')), 'sha256'), 'hex')
         and f.huella_anterior is not distinct from lag(f.huella) over (order by f.emitida_en, f.num)
  from facturas f where f.org_id = p_org and public.puede_ver_facturacion(p_org)
  order by f.emitida_en, f.num;
$$;

-- ---------- Importación del histórico de la v7 (solo propietario, una vez) ----------
-- p_facturas: filas de FACTURAS con sus LINEAS; se respetan NUM, FECHA y HUELLA originales.
create or replace function public.importar_historico_facturas(p_org uuid, p_facturas jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare f jsonb; l jsonb; v_id uuid; n int := 0; i int; v_prev text; v_cli clientes;
begin
  if not (puede_facturar(p_org) and tiene_rol(p_org, array['propietario']::rol_miembro[])) then raise exception 'Sin permiso'; end if;
  for f in select * from jsonb_array_elements(p_facturas) order by (value->>'fecha'), (value->>'num') loop
    if exists (select 1 from facturas where org_id = p_org and num = f->>'num') then continue; end if;
    select * into v_cli from clientes where org_id = p_org and codigo = f->>'cliente_codigo';
    insert into facturas (org_id, num, serie, tipo_doc, fecha, vencimiento, cliente_id, cliente_codigo, cliente, emisor,
                          concepto, base, igic, irpf_pct, irpf, total, coste, estado, observaciones, huella_anterior, huella, emitida_en)
    values (p_org, f->>'num', f->>'serie', coalesce(f->>'tipo_doc', 'FACTURA'), (f->>'fecha')::date, (f->>'vencimiento')::date,
            v_cli.id, f->>'cliente_codigo', jsonb_build_object('nombre', f->>'cliente_nombre', 'codigo', f->>'cliente_codigo'), '{}'::jsonb,
            f->>'concepto', (f->>'base')::numeric, (f->>'igic')::numeric, coalesce((f->>'irpf_pct')::numeric, 0),
            coalesce((f->>'irpf')::numeric, 0), (f->>'total')::numeric, coalesce((f->>'coste')::numeric, 0), 'HISTORICA',
            f->>'observaciones', v_prev, coalesce(nullif(f->>'huella', ''), 'IMPORTADA-SIN-HUELLA'),
            ((f->>'fecha')::date)::timestamptz)
    returning id, huella into v_id, v_prev;
    i := 0;
    for l in select * from jsonb_array_elements(coalesce(f->'lineas', '[]')) loop
      i := i + 1;
      insert into facturas_lineas (factura_id, linea, codigo, descripcion, cantidad, unidad, pvp_ud, dto_pct, base, igic_pct, igic, coste_ud, familia)
      values (v_id, i, l->>'codigo', l->>'descripcion', (l->>'cantidad')::numeric, coalesce(l->>'unidad', 'ud'), (l->>'pvp_ud')::numeric,
              coalesce((l->>'dto_pct')::numeric, 0), (l->>'base')::numeric, coalesce((l->>'igic_pct')::numeric, 0),
              coalesce((l->>'igic')::numeric, 0), coalesce((l->>'coste_ud')::numeric, 0), l->>'familia');
    end loop;
    for l in select * from jsonb_array_elements(coalesce(f->'cobros', '[]')) loop
      insert into cobros (org_id, factura_id, fecha, importe, medio, notas)
      values (p_org, v_id, (l->>'fecha')::date, (l->>'importe')::numeric, coalesce(l->>'medio', 'TRANSFERENCIA'), l->>'notas');
    end loop;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- RLS ----------
alter table public.facturas        enable row level security;
alter table public.facturas_lineas enable row level security;
alter table public.presupuestos    enable row level security;
alter table public.borradores      enable row level security;
alter table public.cobros          enable row level security;
alter table public.gastos          enable row level security;
alter table public.impuestos       enable row level security;
alter table public.horas_facturadas enable row level security;
create policy hf_sel on public.horas_facturadas for select using (public.puede_ver_facturacion(org_id));

-- Facturas y líneas: lectura para gestión/gestoría; escritura SOLO vía emitir_factura (sin política de insert)
create policy fac_sel on public.facturas for select using (public.puede_ver_facturacion(org_id));
create policy fac_upd on public.facturas for update using (public.puede_facturar(org_id)) with check (public.puede_facturar(org_id));
create policy lin_sel on public.facturas_lineas for select using (
  exists (select 1 from public.facturas f where f.id = factura_id and public.puede_ver_facturacion(f.org_id)));

do $$
declare t text;
begin
  foreach t in array array['presupuestos','borradores','cobros','gastos','impuestos'] loop
    execute format('create policy %I on public.%I for select using (public.puede_ver_facturacion(org_id))', t || '_sel', t);
    execute format('create policy %I on public.%I for insert with check (public.puede_facturar(org_id))', t || '_ins', t);
    execute format('create policy %I on public.%I for update using (public.puede_facturar(org_id)) with check (public.puede_facturar(org_id))', t || '_upd', t);
    execute format('create policy %I on public.%I for delete using (public.puede_facturar(org_id))', t || '_del', t);
  end loop;
end $$;
