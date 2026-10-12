-- =====================================================================
-- GOFIO · 0035 · Cliente que te paga por NÓMINA
--  - Para quien trabaja por cuenta ajena y además tiene clientes propios: la empresa
--    se da de alta como cliente y se ficha para ella como para cualquier otro, pero
--    marcada «por nómina» no se factura (sus horas no salen como pendientes).
--  - Cada persona apunta cada mes su nómina (bruto y neto) y la app calcula el precio
--    hora real con las horas que fichó ese mes para ese cliente.
--  - La nómina es de la PERSONA: solo la ve y la toca quien la apuntó (ni el propietario
--    ni la gestoría). No es el registro de jornada de la empresa que paga la nómina.
-- =====================================================================

alter table public.clientes add column if not exists por_nomina boolean not null default false;

create table public.nominas (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizaciones(id) on delete cascade,
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  mes        date not null check (mes = date_trunc('month', mes)::date),   -- día 1 del mes
  bruto      numeric(10,2) check (bruto >= 0),
  neto       numeric(10,2) check (neto >= 0),
  creado_en  timestamptz not null default now(),
  check (bruto is not null or neto is not null),
  unique (org_id, cliente_id, user_id, mes)
);
create index on public.nominas (org_id, user_id, mes);

alter table public.nominas enable row level security;
create policy nominas_propias on public.nominas for all
  using (user_id = auth.uid() and public.es_miembro(org_id))
  with check (user_id = auth.uid() and public.es_miembro(org_id)
              and exists (select 1 from public.clientes c where c.id = cliente_id and c.org_id = nominas.org_id));
grant select, insert, update, delete on public.nominas to authenticated;

-- Las horas de un cliente por nómina nunca quedan pendientes de facturar
create or replace function public.horas_pendientes(p_org uuid, p_cliente uuid, p_desde date, p_hasta date)
returns table (user_id uuid, nombre text, dia date, tipo text, minutos int, km numeric, tramos int)
language sql stable security definer set search_path = public as $$
  select t.user_id, m.nombre, t.dia, t.tipo, sum(t.minutos)::int, sum(t.km), count(*)::int
  from tramos_jornada(p_org, p_desde, p_hasta, null) t
  left join miembros m on m.org_id = p_org and m.user_id = t.user_id
  where public.puede_facturar(p_org)
    and not exists (select 1 from clientes c where c.id = p_cliente and c.por_nomina)
    and t.cliente_id = p_cliente and t.tipo in ('TRABAJO', 'DESPLAZAMIENTO') and t.fin is not null
    and not exists (select 1 from horas_facturadas h where h.org_id = p_org and h.cliente_id = p_cliente
                    and h.user_id = t.user_id and h.dia = t.dia and h.tipo = t.tipo)
  group by t.user_id, m.nombre, t.dia, t.tipo
  order by t.dia, m.nombre, t.tipo;
$$;
