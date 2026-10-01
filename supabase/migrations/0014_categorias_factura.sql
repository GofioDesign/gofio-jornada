-- =====================================================================
-- GOFIO · 0014 · Categorías de factura: mano de obra, materiales, pequeño material, transporte
--  - Cada producto lleva una categoría de factura (por defecto, la que corresponde a su familia).
--  - Cada línea de factura guarda su categoría; si no llega, la del producto o la de su familia.
--  - La factura guarda cómo se presentan las líneas en el documento:
--      DETALLE    una fila por línea (como hasta ahora)
--      CATEGORIAS líneas agrupadas bajo cada categoría con su subtotal
--      RESUMEN    una fila por categoría (y tipo de IGIC) con su importe
--    Los totales, el IGIC y la huella no cambian: solo cambia la presentación.
-- =====================================================================
begin;

create or replace function public.categoria_de_familia(p_familia text)
returns text language sql immutable set search_path = public as $$
  select case upper(trim(coalesce(p_familia, '')))
    when 'MANO DE OBRA' then 'MANO DE OBRA' when 'DISEÑO' then 'MANO DE OBRA' when 'SERVICIOS' then 'MANO DE OBRA'
    when 'MATERIALES' then 'MATERIALES' when 'MATERIAL' then 'MATERIALES'
    when 'PEQUEÑO MATERIAL' then 'PEQUEÑO MATERIAL' when 'FIJACIONES Y ACCESORIOS' then 'PEQUEÑO MATERIAL'
    when 'TRANSPORTE' then 'TRANSPORTE' when 'DESPLAZAMIENTO' then 'TRANSPORTE'
    else 'OTROS' end;
$$;
revoke execute on function public.categoria_de_familia(text) from public, anon;
grant execute on function public.categoria_de_familia(text) to authenticated, service_role;

-- ---------- Productos ----------
drop view public.v_productos;

alter table public.productos add column if not exists categoria text;
update public.productos set categoria = public.categoria_de_familia(familia) where categoria is null;
alter table public.productos
  alter column categoria set not null,
  add constraint productos_categoria_check
    check (categoria in ('MANO DE OBRA', 'MATERIALES', 'PEQUEÑO MATERIAL', 'TRANSPORTE', 'OTROS'));

-- Altas sin categoría (formulario antiguo, importador de la v7): se deduce de la familia.
create or replace function public.productos_categoria() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.categoria is null then new.categoria := categoria_de_familia(new.familia); end if;
  return new;
end $$;
revoke execute on function public.productos_categoria() from public, anon;
create trigger productos_categoria before insert or update on public.productos
  for each row execute function public.productos_categoria();

create view public.v_productos with (security_invoker = true) as
select p.*,
       o.config,
       (p.pvp - p.coste_ud)                                           as margen,
       case when p.coste_ud = 0 then null
            else round((p.pvp - p.coste_ud) / nullif(p.coste_ud, 0), 4) end as rentabilidad,
       case when p.coste_ud = 0 then null
            else round(p.coste_ud * (1 + coalesce((o.config->>('margen_ideal_' || lower(p.familia)))::numeric,
                                                   (o.config->>'margen_ideal')::numeric, 0.6)), 2) end as pvp_ideal,
       mp.precio_ud as mejor_precio,
       mp.precio as mejor_precio_compra,
       mp.contenido_compra as mejor_contenido_compra,
       pr.nombre as mejor_proveedor
from public.productos p
join public.organizaciones o on o.id = p.org_id
left join lateral (select precio, precio_ud, contenido_compra, proveedor_id from public.precios_proveedor x
                   where x.producto_id = p.id order by precio_ud asc, fecha desc limit 1) mp on true
left join public.proveedores pr on pr.id = mp.proveedor_id;

-- ---------- Facturas ----------
alter table public.facturas add column if not exists agrupacion text not null default 'DETALLE'
  constraint facturas_agrupacion_check check (agrupacion in ('DETALLE', 'CATEGORIAS', 'RESUMEN'));

-- v_facturas expande f.* al crearse: se rehace para que incluya «agrupacion».
drop view public.v_facturas;
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

-- Las líneas ya emitidas no se tocan (son inmutables): su categoría se deduce al mostrarlas.
alter table public.facturas_lineas add column if not exists categoria text
  constraint facturas_lineas_categoria_check
    check (categoria in ('MANO DE OBRA', 'MATERIALES', 'PEQUEÑO MATERIAL', 'TRANSPORTE', 'OTROS'));

create or replace function public.facturas_lineas_categoria() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.categoria is null and new.producto_id is not null then
    select categoria into new.categoria from productos where id = new.producto_id;
  end if;
  if new.categoria is null then new.categoria := categoria_de_familia(new.familia); end if;
  return new;
end $$;
revoke execute on function public.facturas_lineas_categoria() from public, anon;
create trigger facturas_lineas_categoria before insert on public.facturas_lineas
  for each row execute function public.facturas_lineas_categoria();

-- emitir_factura recibe la presentación elegida (p_agrupacion) y la categoría de cada línea.
drop function public.emitir_factura(uuid, uuid, date, jsonb, numeric, text, date, date, uuid, uuid, text, jsonb);
-- p_lineas: [{codigo, descripcion, cantidad, unidad, pvp, dto, igic, coste, familia, categoria, producto_id}]
create or replace function public.emitir_factura(
  p_org uuid, p_cliente uuid, p_fecha date, p_lineas jsonb,
  p_irpf_pct numeric default null, p_observaciones text default null,
  p_periodo_desde date default null, p_periodo_hasta date default null,
  p_presupuesto uuid default null, p_rectifica uuid default null, p_motivo text default null,
  p_horas jsonb default null,   -- tramos de JORNADA que se facturan: [{user_id, dia, tipo, minutos, km}]
  p_agrupacion text default 'DETALLE')
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
          left((select string_agg(x->>'descripcion', ' · ') from jsonb_array_elements(p_lineas) x), 250),
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
                                 base, igic_pct, igic, coste_ud, familia, categoria)
    values (v_f.id, i, nullif(l->>'producto_id', '')::uuid, l->>'codigo', l->>'descripcion', (l->>'cantidad')::numeric,
            coalesce(l->>'unidad', 'ud'), (l->>'pvp')::numeric, coalesce((l->>'dto')::numeric, 0),
            (t->'lineas'->(i-1)->>'base')::numeric, coalesce((l->>'igic')::numeric, 0), (t->'lineas'->(i-1)->>'igic')::numeric,
            coalesce((l->>'coste')::numeric, 0), l->>'familia', nullif(l->>'categoria', ''));
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
revoke execute on function public.emitir_factura(uuid, uuid, date, jsonb, numeric, text, date, date, uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function public.emitir_factura(uuid, uuid, date, jsonb, numeric, text, date, date, uuid, uuid, text, jsonb, text) to authenticated, service_role;

commit;
