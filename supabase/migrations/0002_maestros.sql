-- =====================================================================
-- GOFIO · 0002 · Datos maestros: clientes, proveedores, productos, precios
-- =====================================================================

create table public.clientes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizaciones(id) on delete cascade,
  codigo        text not null,                -- NIF/NIE/CIF (ID_CLIENTE en la hoja)
  nombre        text not null,
  tipo          text not null default 'PARTICULAR' check (tipo in ('PARTICULAR','EMPRESA','AUTONOMO','ADMINISTRACION')),
  aplica_irpf   boolean not null default false,
  irpf_pct      numeric(5,2),                 -- null = usa el de la empresa
  direccion     text,
  cp            text,
  localidad     text,
  municipio     text,
  provincia     text,
  pais          text default 'ESPAÑA',
  email         text,
  telefono      text,
  idioma        text not null default 'ES' check (idioma in ('ES','DE','EN')),
  lat           double precision,             -- ubicación exacta de la obra/casa (para Waze/Maps)
  lng           double precision,
  notas         text,
  activo        boolean not null default true,
  creado_en     timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (org_id, codigo)
);
create index on public.clientes (org_id, nombre);
create trigger clientes_upd before update on public.clientes for each row execute function public.tocar_actualizado();

create table public.proveedores (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizaciones(id) on delete cascade,
  codigo        text not null,                -- ID corto: ULTIMA, LEROY...
  nombre        text not null,
  nif           text,
  web           text,
  email         text,
  telefono      text,
  contacto      text,
  direccion     text,
  notas         text,
  unique (org_id, codigo)
);

create table public.productos (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizaciones(id) on delete cascade,
  codigo              text not null,
  familia             text not null default 'MATERIALES',
  descripcion         text not null,          -- interna
  descripcion_factura text,                   -- la que ve el cliente
  unidad              text not null default 'ud',
  proveedor_id        uuid references public.proveedores(id) on delete set null,
  ref_proveedor       text,
  coste_ud            numeric(12,2) not null default 0,
  pvp                 numeric(12,2) not null default 0,
  pvp_historico       numeric(12,2),
  igic_pct            numeric(5,2),           -- null = el de la empresa
  activo              boolean not null default true,
  notas               text,
  actualizado_en      timestamptz not null default now(),
  unique (org_id, codigo)
);
create index on public.productos (org_id, familia);
create trigger productos_upd before update on public.productos for each row execute function public.tocar_actualizado();

create table public.precios_proveedor (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizaciones(id) on delete cascade,
  producto_id   uuid not null references public.productos(id) on delete cascade,
  proveedor_id  uuid not null references public.proveedores(id) on delete cascade,
  precio        numeric(12,2) not null,       -- sin IGIC
  fecha         date not null default current_date,
  ref_proveedor text,
  url           text
);
create index on public.precios_proveedor (producto_id, precio);

-- Vista de productos con margen y mejor precio (sustituye las fórmulas de PRODUCTOS)
create view public.v_productos with (security_invoker = true) as
select p.*,
       o.config,
       (p.pvp - p.coste_ud)                                           as margen,
       case when p.coste_ud = 0 then null
            else round((p.pvp - p.coste_ud) / nullif(p.pvp, 0), 4) end as rentabilidad,
       case when p.coste_ud = 0 then null
            else round(p.coste_ud / (1 - coalesce((o.config->>('margen_ideal_' || lower(p.familia)))::numeric,
                                                   (o.config->>'margen_ideal')::numeric, 0.6)), 2) end as pvp_ideal,
       mp.precio  as mejor_precio,
       pr.nombre  as mejor_proveedor
from public.productos p
join public.organizaciones o on o.id = p.org_id
left join lateral (select precio, proveedor_id from public.precios_proveedor x
                   where x.producto_id = p.id order by precio asc, fecha desc limit 1) mp on true
left join public.proveedores pr on pr.id = mp.proveedor_id;

-- ---------- RLS ----------
-- Clientes (= lugares de trabajo) son comunes a JORNADA y FACTURACIÓN:
-- los ve cualquier miembro; los crean/editan propietario, admin y responsable.
alter table public.clientes enable row level security;
create policy clientes_sel on public.clientes for select using (public.es_miembro(org_id));
create policy clientes_ins on public.clientes for insert with check (public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[]));
create policy clientes_upd on public.clientes for update using (public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[]))
  with check (public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[]));
create policy clientes_del on public.clientes for delete using (public.puede_gestionar(org_id));

-- Proveedores, productos y precios son del módulo FACTURACIÓN
do $$
declare t text;
begin
  foreach t in array array['proveedores','productos','precios_proveedor'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select using (public.puede_ver_facturacion(org_id))', t || '_sel', t);
    execute format('create policy %I on public.%I for insert with check (public.puede_facturar(org_id))', t || '_ins', t);
    execute format('create policy %I on public.%I for update using (public.puede_facturar(org_id)) with check (public.puede_facturar(org_id))', t || '_upd', t);
    execute format('create policy %I on public.%I for delete using (public.puede_facturar(org_id))', t || '_del', t);
  end loop;
end $$;

-- Los técnicos pueden guardar la ubicación GPS de un cliente (al llegar a la obra)
create or replace function public.fijar_ubicacion_cliente(p_cliente uuid, p_lat double precision, p_lng double precision)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from clientes where id = p_cliente;
  if v_org is null or not es_miembro(v_org) then raise exception 'Sin permiso'; end if;
  update clientes set lat = p_lat, lng = p_lng where id = p_cliente;
end $$;
