-- =====================================================================
-- GOFIO · 0022 · Registrar facturas anteriores (emitidas fuera de la app)
--  - registrar_factura_anterior(): da de alta una factura que ya se emitió antes
--    (p. ej. desde la hoja v7) con su número y su fecha originales, sus líneas y,
--    si se indica, el cobro. Queda como HISTORICA: no entra en la cadena de huellas
--    (emitida_en = su fecha, sin huella propia) y no cambia la numeración de la app.
--  - El número tiene que ser anterior a las facturas que ya emite la app en esa serie,
--    para no dejar huecos ni duplicar números futuros.
-- =====================================================================

begin;

create or replace function public.registrar_factura_anterior(
  p_org uuid,
  p_cliente uuid,
  p_num text,
  p_fecha date,
  p_lineas jsonb,
  p_irpf_pct numeric default null,
  p_observaciones text default null,
  p_agrupacion text default 'DETALLE',
  p_concepto text default null,
  p_cobrada date default null)   -- fecha del cobro (por el total); vacío = pendiente de cobro
returns public.facturas language plpgsql security definer set search_path = public as $$
declare
  o organizaciones; c clientes; t jsonb; v_num text := upper(trim(coalesce(p_num, ''))); v_serie text; v_n int; v_primera int;
  v_irpf numeric; v_f facturas; l jsonb; i int := 0;
begin
  if not puede_facturar(p_org) then raise exception 'Sin permiso para facturar'; end if;
  if v_num !~ '^[A-Z]+[0-9]{2}-[0-9]+$' then raise exception 'El número debe tener el formato de la serie, p. ej. EMIT26-0001'; end if;
  if p_fecha is null or p_fecha > current_date then raise exception 'Indica la fecha original de la factura (no puede ser futura)'; end if;
  if jsonb_array_length(coalesce(p_lineas, '[]')) = 0 then raise exception 'La factura no tiene líneas'; end if;
  v_serie := substring(v_num from '^(.*)-[0-9]+$');
  v_n := substring(v_num from '-([0-9]+)$')::int;
  if right(v_serie, 2) <> to_char(p_fecha, 'YY') then
    raise exception 'El número % no corresponde al año de la fecha (%)', v_num, to_char(p_fecha, 'YYYY');
  end if;
  v_num := v_serie || '-' || lpad(v_n::text, greatest(4, length(v_n::text)), '0');

  select * into o from organizaciones where id = p_org;
  select * into c from clientes where id = p_cliente and org_id = p_org;
  if not found then raise exception 'Cliente no encontrado'; end if;
  if coalesce(c.codigo, '') = '' or coalesce(c.nombre, '') = '' then raise exception 'El cliente necesita NIF y nombre'; end if;

  perform pg_advisory_xact_lock(hashtext('factura:' || p_org));
  if exists (select 1 from facturas where org_id = p_org and num = v_num) then
    raise exception 'Ya hay una factura con el número %', v_num;
  end if;
  select min(substring(num from '-(\d+)$')::int) into v_primera
    from facturas where org_id = p_org and serie = v_serie and estado <> 'HISTORICA';
  if v_primera is not null and v_n >= v_primera then
    raise exception 'La % es posterior a las facturas que ya emite la app (desde la %-%)', v_num, v_serie, lpad(v_primera::text, 4, '0');
  end if;

  v_irpf := coalesce(p_irpf_pct, case when c.aplica_irpf then coalesce(c.irpf_pct, (o.config->>'irpf_defecto')::numeric) else 0 end);
  t := calcular_documento(p_lineas, v_irpf);

  insert into facturas (org_id, num, serie, tipo_doc, fecha, vencimiento, cliente_id, cliente_codigo, cliente, emisor,
                        concepto, base, igic, irpf_pct, irpf, total, coste, igic_desglose, estado, observaciones,
                        huella_anterior, huella, emitida_por, emitida_en, agrupacion)
  values (p_org, v_num, v_serie, 'FACTURA', p_fecha, p_fecha + coalesce((o.config->>'dias_vencimiento')::int, 30),
          c.id, c.codigo, to_jsonb(c) - array['id','org_id','lat','lng','notas','creado_en','actualizado_en'],
          jsonb_build_object('marca', o.nombre, 'titular', o.titular, 'nif', o.nif, 'direccion', o.direccion, 'cp', o.cp,
                             'localidad', o.localidad, 'provincia', o.provincia, 'email', o.email, 'telefono', o.telefono,
                             'web', o.web, 'iban', o.iban, 'bic', o.bic, 'pago', o.config->>'medio_pago_texto'),
          left(coalesce(nullif(trim(p_concepto), ''), (select string_agg(x->>'descripcion', ' · ') from jsonb_array_elements(p_lineas) x)), 250),
          (t->>'base')::numeric, (t->>'igic')::numeric, v_irpf, (t->>'irpf')::numeric, (t->>'total')::numeric,
          (t->>'coste')::numeric, t->'igic_desglose', 'HISTORICA', nullif(trim(p_observaciones), ''),
          null, 'IMPORTADA-SIN-HUELLA', auth.uid(), p_fecha::timestamptz, coalesce(p_agrupacion, 'DETALLE'))
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

  if p_cobrada is not null and v_f.total > 0 then
    insert into cobros (org_id, factura_id, fecha, importe, notas)
    values (p_org, v_f.id, p_cobrada, v_f.total, 'Cobro de una factura anterior a la app');
  end if;
  return v_f;
end $$;
revoke execute on function public.registrar_factura_anterior(uuid, uuid, text, date, jsonb, numeric, text, text, text, date) from public, anon;
grant execute on function public.registrar_factura_anterior(uuid, uuid, text, date, jsonb, numeric, text, text, text, date) to authenticated, service_role;

-- La cadena de huellas solo recorre las facturas que tienen huella: una factura anterior
-- registrada a mano (sin huella) no rompe la comprobación de la que viene detrás.
create or replace function public.comprobar_integridad(p_org uuid)
returns table (num text, ok boolean) language sql stable security definer set search_path = public, extensions as $$
  select f.num,
         f.huella = encode(digest(concat_ws('|', coalesce(f.huella_anterior, ''), f.num, to_char(f.fecha, 'DD/MM/YYYY'), f.cliente_codigo,
            to_char(f.base, 'FM999999990.00'), to_char(f.igic, 'FM999999990.00'), to_char(f.irpf, 'FM999999990.00'),
            to_char(f.total, 'FM999999990.00')), 'sha256'), 'hex')
         and f.huella_anterior is not distinct from lag(f.huella) over (order by f.emitida_en, f.num)
  from facturas f where f.org_id = p_org and public.puede_ver_facturacion(p_org) and f.huella <> 'IMPORTADA-SIN-HUELLA'
  order by f.emitida_en, f.num;
$$;

commit;
