-- =====================================================================
-- GOFIO · 0020 · Corregir los textos de una factura emitida
--  - corregir_textos_factura(): cambia la descripción y el «Agrupar bajo» de las
--    líneas, el concepto (agrupación TOTAL) y las observaciones de una factura ya
--    emitida. Nada más: ni importes, ni cliente, ni fecha, ni número, así que la
--    huella y la cadena no cambian.
--  - Los disparadores de inmutabilidad solo dejan pasar esos campos cuando el
--    cambio viene de esta función (marca gofio.corregir_textos en la transacción).
--  - facturas.textos_corregidos_en: cuándo se corrigieron los textos por última vez.
--  Para cambiar importes sigue haciendo falta una rectificativa (emitir_factura con
--  p_rectifica), que deja la original como RECTIFICADA.
-- =====================================================================

begin;

alter table public.facturas add column if not exists textos_corregidos_en timestamptz;

create or replace function public.facturas_inmutables() returns trigger language plpgsql as $$
declare libres text[] := array['estado', 'pdf_url', 'pdf_firmado_url', 'fecha_firma', 'observaciones'];
begin
  if tg_op = 'DELETE' then raise exception 'Las facturas no se borran: emite una rectificativa'; end if;
  if current_setting('gofio.corregir_textos', true) = 'on' then libres := libres || array['concepto', 'textos_corregidos_en']; end if;
  if (to_jsonb(new) - libres) is distinct from (to_jsonb(old) - libres) then
    raise exception 'Una factura emitida no se puede modificar: emite una rectificativa';
  end if;
  return new;
end $$;

create or replace function public.lineas_inmutables() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_setting('gofio.corregir_textos', true) = 'on'
     and (to_jsonb(new) - array['descripcion', 'grupo']) = (to_jsonb(old) - array['descripcion', 'grupo']) then
    return new;
  end if;
  raise exception 'Las líneas de una factura emitida no se pueden cambiar';
end $$;

-- p_lineas: [{linea, descripcion, grupo}] (solo las que cambian; las demás se quedan como están)
create or replace function public.corregir_textos_factura(
  p_factura uuid, p_lineas jsonb default '[]', p_concepto text default null, p_observaciones text default null)
returns public.facturas language plpgsql security definer set search_path = public as $$
declare f facturas; l jsonb; n int;
begin
  select * into f from facturas where id = p_factura;
  if not found or not puede_facturar(f.org_id) then raise exception 'Sin permiso para facturar'; end if;
  perform set_config('gofio.corregir_textos', 'on', true);
  for l in select * from jsonb_array_elements(coalesce(p_lineas, '[]')) loop
    if coalesce(trim(l->>'descripcion'), '') = '' then raise exception 'Todas las líneas necesitan una descripción'; end if;
    update facturas_lineas set descripcion = trim(l->>'descripcion'), grupo = left(nullif(trim(l->>'grupo'), ''), 250)
     where factura_id = f.id and linea = (l->>'linea')::int;
    get diagnostics n = row_count;
    if n = 0 then raise exception 'La línea % no existe en la factura %', l->>'linea', f.num; end if;
  end loop;
  update facturas set concepto = coalesce(left(nullif(trim(p_concepto), ''), 250), concepto),
                      observaciones = nullif(trim(p_observaciones), ''),
                      textos_corregidos_en = now()
   where id = f.id returning * into f;
  perform set_config('gofio.corregir_textos', 'off', true);
  return f;
end $$;
revoke execute on function public.corregir_textos_factura(uuid, jsonb, text, text) from public, anon;
grant execute on function public.corregir_textos_factura(uuid, jsonb, text, text) to authenticated, service_role;

-- v_facturas expande f.* al crearse: se rehace para que incluya «textos_corregidos_en».
drop view public.v_facturas;
create view public.v_facturas with (security_invoker = true) as
select f.*,
       coalesce(c.cobrado, 0)                        as cobrado,
       f.total - coalesce(c.cobrado, 0)              as pendiente,
       case when f.estado in ('RECTIFICADA','ANULADA','HISTORICA') then f.estado
            when f.total - coalesce(c.cobrado, 0) <= 0 then 'COBRADA'
            when coalesce(c.cobrado, 0) > 0 then 'PARCIAL'
            when f.vencimiento < current_date then 'VENCIDA'
            else 'PENDIENTE' end                     as estado_cobro
from public.facturas f
left join (select factura_id, sum(importe) cobrado from public.cobros group by factura_id) c on c.factura_id = f.id;

commit;
