-- Baja lógica: conserva proveedores, precios históricos y productos relacionados.
alter table public.proveedores
  add column activo boolean not null default true;
