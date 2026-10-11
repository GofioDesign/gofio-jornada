-- =====================================================================
-- GOFIO · 0031 · Horarios de trabajo
--  - Horario semanal de la empresa (user_id null) y, si hace falta, uno propio por persona.
--    Cada día de la semana (1 = lunes … 7 = domingo) puede tener varios tramos: 08:00–13:00 y 15:00–18:00
--    es una jornada partida; el hueco entre tramos es el descanso.
--  - Quien tiene horario propio usa solo el suyo (los días sin tramos no trabaja); el resto usa el de la empresa.
--  - Sirve para comparar las horas previstas con las trabajadas (Equipo, Jornada). No cambia los fichajes.
--  - Se guarda entero de una vez con guardar_horario (propietario o administrador).
-- =====================================================================

begin;

create table public.horarios_trabajo (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizaciones(id) on delete cascade,
  user_id     uuid,                                   -- null = horario de la empresa
  dia_semana  smallint not null check (dia_semana between 1 and 7),
  inicio      time not null,
  fin         time not null,
  check (fin > inicio),
  foreign key (org_id, user_id) references public.miembros(org_id, user_id) on delete cascade
);
create index on public.horarios_trabajo (org_id, user_id);

alter table public.horarios_trabajo enable row level security;
-- Cada persona ve el horario de la empresa y el suyo; quien ve al equipo, todos
create policy horarios_trabajo_sel on public.horarios_trabajo for select using (
  public.es_miembro(org_id) and (user_id is null or user_id = auth.uid()
    or public.tiene_rol(org_id, array['propietario','admin','responsable']::public.rol_miembro[])));
-- Solo se escribe con guardar_horario
revoke insert, update, delete on public.horarios_trabajo from authenticated;

-- Sustituye el horario de la empresa (p_user null) o el de una persona por p_tramos:
-- [{ "dia": 1, "inicio": "08:00", "fin": "13:00" }, …]. Una lista vacía lo borra
-- (la persona vuelve a usar el horario de la empresa).
create or replace function public.guardar_horario(p_org uuid, p_user uuid, p_tramos jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not puede_gestionar(p_org) then raise exception 'Sin permiso'; end if;
  if p_user is not null and not exists (select 1 from miembros where org_id = p_org and user_id = p_user) then
    raise exception 'Esa persona no es de tu empresa';
  end if;
  p_tramos := coalesce(p_tramos, '[]');
  if jsonb_typeof(p_tramos) <> 'array' then raise exception 'Horario no válido'; end if;
  if exists (select 1 from jsonb_array_elements(p_tramos) t
             where (t->>'dia')::int not between 1 and 7 or (t->>'inicio')::time >= (t->>'fin')::time) then
    raise exception 'Cada tramo tiene que acabar después de empezar';
  end if;
  if exists (select 1 from jsonb_array_elements(p_tramos) with ordinality a(t, i)
             join jsonb_array_elements(p_tramos) with ordinality b(t, i) on a.i < b.i
              and (a.t->>'dia')::int = (b.t->>'dia')::int
              and (a.t->>'inicio')::time < (b.t->>'fin')::time and (b.t->>'inicio')::time < (a.t->>'fin')::time) then
    raise exception 'Hay tramos del mismo día que se solapan';
  end if;
  delete from horarios_trabajo where org_id = p_org and user_id is not distinct from p_user;
  insert into horarios_trabajo (org_id, user_id, dia_semana, inicio, fin)
    select p_org, p_user, (t->>'dia')::smallint, (t->>'inicio')::time, (t->>'fin')::time from jsonb_array_elements(p_tramos) t;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.guardar_horario(uuid, uuid, jsonb) from public, anon;
grant execute on function public.guardar_horario(uuid, uuid, jsonb) to authenticated;

commit;
