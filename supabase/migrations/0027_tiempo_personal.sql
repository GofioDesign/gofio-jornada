-- =====================================================================
-- GOFIO · 0027 · TIEMPO PERSONAL
--  - Cronómetro privado para tareas personales (baño, cocinar, tender la ropa…).
--  - Es de la PERSONA, no de la empresa: no lleva org_id y solo lo ve quien lo usa
--    (ni el propietario ni la gestoría). No es un fichaje: no entra en el registro
--    de jornada ni en la facturación.
--  - El uso elegido en el sondeo inicial va en organizaciones.config->>'uso'
--    (personal, profesional, ambos o indeciso); no necesita columna nueva.
-- =====================================================================

create table public.tareas_personales (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nombre    text not null check (trim(nombre) <> '' and length(nombre) <= 60),
  orden     int not null default 0,
  activa    boolean not null default true,
  creado_en timestamptz not null default now(),
  unique (user_id, nombre)
);

create table public.tiempos_personales (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tarea_id uuid not null references public.tareas_personales(id) on delete cascade,
  inicio   timestamptz not null default now(),
  fin      timestamptz,
  check (fin is null or fin >= inicio)
);
create index on public.tiempos_personales (user_id, inicio);
-- Un solo cronómetro en marcha por persona
create unique index tiempos_personales_en_marcha on public.tiempos_personales (user_id) where fin is null;

alter table public.tareas_personales enable row level security;
create policy tareas_personales_propias on public.tareas_personales for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.tiempos_personales enable row level security;
create policy tiempos_personales_propios on public.tiempos_personales for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and exists (select 1 from public.tareas_personales t where t.id = tarea_id and t.user_id = auth.uid()));

grant select, insert, update, delete on public.tareas_personales, public.tiempos_personales to authenticated;
