-- Importación transaccional de los maestros de la hoja v7.
create unique index if not exists precios_proveedor_natural
  on public.precios_proveedor (org_id, producto_id, proveedor_id, fecha, precio);

create or replace function public.importar_maestros_facturacion(
  p_org uuid, p_proveedores jsonb, p_productos jsonb, p_precios jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_prov uuid; v_prod uuid; n_prov int := 0; n_prod int := 0; n_prec int := 0;
begin
  if not puede_facturar(p_org) then raise exception 'Sin permiso'; end if;
  if jsonb_typeof(coalesce(p_proveedores, '[]')) <> 'array'
     or jsonb_typeof(coalesce(p_productos, '[]')) <> 'array'
     or jsonb_typeof(coalesce(p_precios, '[]')) <> 'array' then raise exception 'Formato de importación no válido'; end if;

  for r in select value from jsonb_array_elements(coalesce(p_proveedores, '[]')) loop
    insert into proveedores (org_id, codigo, nombre, nif, web, email, telefono, contacto, direccion, notas)
    values (p_org, r->>'codigo', r->>'nombre', r->>'nif', r->>'web', r->>'email', r->>'telefono', r->>'contacto', r->>'direccion', r->>'notas')
    on conflict (org_id, codigo) do update set nombre = excluded.nombre, nif = excluded.nif, web = excluded.web,
      email = excluded.email, telefono = excluded.telefono, contacto = excluded.contacto, direccion = excluded.direccion, notas = excluded.notas;
    n_prov := n_prov + 1;
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_productos, '[]')) loop
    select id into v_prov from proveedores where org_id = p_org and codigo = r->>'proveedor_codigo';
    insert into productos (org_id, codigo, familia, descripcion, descripcion_factura, unidad, proveedor_id, ref_proveedor,
                           coste_ud, pvp, pvp_historico, igic_pct, activo, notas)
    values (p_org, r->>'codigo', r->>'familia', r->>'descripcion', r->>'descripcion_factura', r->>'unidad', v_prov,
            r->>'ref_proveedor', coalesce((r->>'coste_ud')::numeric, 0), coalesce((r->>'pvp')::numeric, 0),
            nullif(r->>'pvp_historico', '')::numeric, nullif(r->>'igic_pct', '')::numeric,
            coalesce((r->>'activo')::boolean, true), r->>'notas')
    on conflict (org_id, codigo) do update set familia = excluded.familia, descripcion = excluded.descripcion,
      descripcion_factura = excluded.descripcion_factura, unidad = excluded.unidad, proveedor_id = excluded.proveedor_id,
      ref_proveedor = excluded.ref_proveedor, coste_ud = excluded.coste_ud, pvp = excluded.pvp,
      pvp_historico = excluded.pvp_historico, igic_pct = excluded.igic_pct, activo = excluded.activo, notas = excluded.notas;
    n_prod := n_prod + 1;
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_precios, '[]')) loop
    select id into v_prod from productos where org_id = p_org and codigo = r->>'producto_codigo';
    select id into v_prov from proveedores where org_id = p_org and codigo = r->>'proveedor_codigo';
    if v_prod is null or v_prov is null then raise exception 'Referencia no encontrada en precio de proveedor'; end if;
    insert into precios_proveedor (org_id, producto_id, proveedor_id, precio, fecha, ref_proveedor, url)
    values (p_org, v_prod, v_prov, (r->>'precio')::numeric, (r->>'fecha')::date, r->>'ref_proveedor', r->>'url')
    on conflict (org_id, producto_id, proveedor_id, fecha, precio) do nothing;
    if found then n_prec := n_prec + 1; end if;
  end loop;
  return jsonb_build_object('proveedores', n_prov, 'productos', n_prod, 'precios', n_prec);
end $$;
