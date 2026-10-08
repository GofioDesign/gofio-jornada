-- =====================================================================
-- GOFIO · 0019 · Agrupar líneas de factura bajo un concepto
--  - facturas_lineas.grupo: concepto bajo el que sale la línea en la presentación
--    CONCEPTO. Las líneas con el mismo grupo (y tipo de IGIC) salen en una sola fila
--    con la suma; las que no tienen grupo salen con su descripción.
--  - emitir_factura guarda el «grupo» de cada línea (misma firma que en 0018).
--  - Solo cambia la presentación: ni los totales ni la huella.
-- =====================================================================

begin;

alter table public.facturas_lineas add column if not exists grupo text;

create or replace function public.emitir_factura(
  p_org uuid, p_cliente uuid, p_fecha date, p_lineas jsonb,
  p_irpf_pct numeric default null, p_observaciones text default null,
  p_periodo_desde date default null, p_periodo_hasta date default null,
  p_presupuesto uuid default null, p_rectifica uuid default null, p_motivo text default null,
  p_horas jsonb default null,   -- tramos de JORNADA que se facturan: [{user_id, dia, tipo, minutos, km}]
  p_agrupacion text default 'DETALLE',
  p_concepto text default null)   -- texto del concepto único (agrupación TOTAL); si no, se juntan las descripciones
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
                        rectifica_a, motivo, presupuesto_id, observaciones, huella_anterior, huella, emitida_por, agrupacion)
  values (p_org, v_num, v_serie, v_tipo, p_fecha, p_fecha + coalesce((o.config->>'dias_vencimiento')::int, 30),
          c.id, c.codigo, to_jsonb(c) - array['id','org_id','lat','lng','notas','creado_en','actualizado_en'],
          jsonb_build_object('marca', o.nombre, 'titular', o.titular, 'nif', o.nif, 'direccion', o.direccion, 'cp', o.cp,
                             'localidad', o.localidad, 'provincia', o.provincia, 'email', o.email, 'telefono', o.telefono,
                             'web', o.web, 'iban', o.iban, 'bic', o.bic, 'pago', o.config->>'medio_pago_texto'),
          p_periodo_desde, p_periodo_hasta,
          left(coalesce(nullif(trim(p_concepto), ''), (select string_agg(x->>'descripcion', ' · ') from jsonb_array_elements(p_lineas) x)), 250),
          (t->>'base')::numeric, (t->>'igic')::numeric, v_irpf, (t->>'irpf')::numeric, (t->>'total')::numeric,
          (t->>'coste')::numeric, t->'igic_desglose', p_rectifica, p_motivo, p_presupuesto, p_observaciones, v_prev,
          encode(digest(concat_ws('|', coalesce(v_prev, ''), v_num, to_char(p_fecha, 'DD/MM/YYYY'), c.codigo,
                  to_char((t->>'base')::numeric, 'FM999999990.00'), to_char((t->>'igic')::numeric, 'FM999999990.00'),
                  to_char((t->>'irpf')::numeric, 'FM999999990.00'), to_char((t->>'total')::numeric, 'FM999999990.00')), 'sha256'), 'hex'),
          auth.uid(), coalesce(p_agrupacion, 'DETALLE'))
  returning * into v_f;

  for l in select * from jsonb_array_elements(p_lineas) loop
    i := i + 1;
    insert into facturas_lineas (factura_id, linea, producto_id, codigo, descripcion, cantidad, unidad, pvp_ud, dto_pct,
                                 base, igic_pct, igic, coste_ud, familia, categoria, grupo)
    values (v_f.id, i, nullif(l->>'producto_id', '')::uuid, l->>'codigo', l->>'descripcion', (l->>'cantidad')::numeric,
            coalesce(l->>'unidad', 'ud'), (l->>'pvp')::numeric, coalesce((l->>'dto')::numeric, 0),
            (t->'lineas'->(i-1)->>'base')::numeric, coalesce((l->>'igic')::numeric, 0), (t->'lineas'->(i-1)->>'igic')::numeric,
            coalesce((l->>'coste')::numeric, 0), l->>'familia', nullif(l->>'categoria', ''),
            left(nullif(trim(l->>'grupo'), ''), 250));
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
revoke execute on function public.emitir_factura(uuid, uuid, date, jsonb, numeric, text, date, date, uuid, uuid, text, jsonb, text, text) from public, anon;
grant execute on function public.emitir_factura(uuid, uuid, date, jsonb, numeric, text, date, date, uuid, uuid, text, jsonb, text, text) to authenticated, service_role;

commit;
