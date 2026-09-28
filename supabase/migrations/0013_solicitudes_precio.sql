-- Solicitudes de precio originadas desde borradores de presupuesto.
create table public.solicitudes_precio (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizaciones(id) on delete cascade,
  presupuesto_id uuid references public.borradores(id) on delete set null,
  proveedor_id   uuid references public.proveedores(id) on delete set null,
  proveedor      text not null,
  email          text not null,
  asunto         text not null,
  mensaje        text not null,
  lineas         jsonb not null default '[]',
  estado         text not null default 'SOLICITADA' check (estado in ('SOLICITADA','RECIBIDA','CANCELADA')),
  solicitada_por uuid default auth.uid() references auth.users(id),
  solicitada_en  timestamptz not null default now()
);

create index solicitudes_precio_presupuesto_idx
  on public.solicitudes_precio (presupuesto_id, solicitada_en desc);

alter table public.solicitudes_precio enable row level security;
create policy solicitudes_precio_sel on public.solicitudes_precio for select
  using (public.puede_ver_facturacion(org_id));
create policy solicitudes_precio_ins on public.solicitudes_precio for insert
  with check (public.puede_facturar(org_id));
create policy solicitudes_precio_upd on public.solicitudes_precio for update
  using (public.puede_facturar(org_id)) with check (public.puede_facturar(org_id));
