-- Precisión subcéntimo y conversión entre formatos de compra y unidades de venta.
begin;

drop view public.v_productos;

alter table public.productos
  alter column coste_ud type numeric(14,4) using coste_ud::numeric(14,4);

alter table public.productos
  add column unidad_compra text,
  add column contenido_compra numeric(14,4) not null default 1 check (contenido_compra > 0),
  add column coste_compra numeric(14,4) not null default 0;

update public.productos set coste_compra = coste_ud;

alter table public.precios_proveedor
  alter column precio type numeric(14,4) using precio::numeric(14,4),
  add column contenido_compra numeric(14,4) not null default 1 check (contenido_compra > 0),
  add column precio_ud numeric(14,4) generated always as (round(precio / contenido_compra, 4)) stored;

alter table public.facturas_lineas
  alter column coste_ud type numeric(14,4) using coste_ud::numeric(14,4);

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

commit;
