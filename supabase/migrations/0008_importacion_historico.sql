-- Continúa correctamente la cadena de huellas al reanudar una importación parcial.
create or replace function public.importar_historico_facturas(p_org uuid, p_facturas jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare f jsonb; l jsonb; v_id uuid; n int := 0; i int; v_prev text; v_existente text; v_cli clientes;
begin
  if not (puede_facturar(p_org) and tiene_rol(p_org, array['propietario']::rol_miembro[])) then raise exception 'Sin permiso'; end if;
  if jsonb_typeof(coalesce(p_facturas, '[]')) <> 'array' then raise exception 'Formato de importación no válido'; end if;

  for f in select value from jsonb_array_elements(p_facturas)
           order by (value->>'fecha')::date, value->>'num'
  loop
    select id, huella into v_id, v_existente from facturas where org_id = p_org and num = f->>'num';
    if found then v_prev := v_existente; continue; end if;

    select * into v_cli from clientes where org_id = p_org and codigo = f->>'cliente_codigo';
    if not found then raise exception 'Cliente no encontrado para la factura %: %', f->>'num', f->>'cliente_codigo'; end if;

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
    for l in select value from jsonb_array_elements(coalesce(f->'lineas', '[]')) order by coalesce((value->>'linea')::int, 0) loop
      i := i + 1;
      insert into facturas_lineas (factura_id, linea, codigo, descripcion, cantidad, unidad, pvp_ud, dto_pct, base, igic_pct, igic, coste_ud, familia)
      values (v_id, i, l->>'codigo', l->>'descripcion', (l->>'cantidad')::numeric, coalesce(l->>'unidad', 'ud'), (l->>'pvp_ud')::numeric,
              coalesce((l->>'dto_pct')::numeric, 0), (l->>'base')::numeric, coalesce((l->>'igic_pct')::numeric, 0),
              coalesce((l->>'igic')::numeric, 0), coalesce((l->>'coste_ud')::numeric, 0), l->>'familia');
    end loop;
    for l in select value from jsonb_array_elements(coalesce(f->'cobros', '[]')) loop
      insert into cobros (org_id, factura_id, fecha, importe, medio, notas)
      values (p_org, v_id, (l->>'fecha')::date, (l->>'importe')::numeric, coalesce(l->>'medio', 'TRANSFERENCIA'), l->>'notas');
    end loop;
    n := n + 1;
  end loop;
  return n;
end $$;
