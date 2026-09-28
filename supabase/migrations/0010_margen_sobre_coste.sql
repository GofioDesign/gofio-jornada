-- El margen objetivo es un porcentaje sobre coste y puede superar el 100 %.
create or replace view public.v_productos with (security_invoker = true) as
select p.*,
       o.config,
       (p.pvp - p.coste_ud)                                           as margen,
       case when p.coste_ud = 0 then null
            else round((p.pvp - p.coste_ud) / nullif(p.coste_ud, 0), 4) end as rentabilidad,
       case when p.coste_ud = 0 then null
            else round(p.coste_ud * (1 + coalesce((o.config->>('margen_ideal_' || lower(p.familia)))::numeric,
                                                   (o.config->>'margen_ideal')::numeric, 0.6)), 2) end as pvp_ideal,
       mp.precio  as mejor_precio,
       pr.nombre  as mejor_proveedor
from public.productos p
join public.organizaciones o on o.id = p.org_id
left join lateral (select precio, proveedor_id from public.precios_proveedor x
                   where x.producto_id = p.id order by precio asc, fecha desc limit 1) mp on true
left join public.proveedores pr on pr.id = mp.proveedor_id;
