-- =====================================================================
-- GOFIO · 0021 · Cambiar el orden de las líneas de una factura emitida
--  - facturas_lineas.orden: posición con la que sale la línea en el documento
--    (vacío = su número de línea). El número de línea no cambia.
--  - corregir_textos_factura acepta «orden» en cada línea, igual que la
--    descripción y el grupo. Solo es presentación: ni importes ni huella.
--  Requiere la 0020.
-- =====================================================================

begin;

alter table public.facturas_lineas add column if not exists orden int;

create or replace function public.lineas_inmutables() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_setting('gofio.corregir_textos', true) = 'on'
     and (to_jsonb(new) - array['descripcion', 'grupo', 'orden']) = (to_jsonb(old) - array['descripcion', 'grupo', 'orden']) then
    return new;
  end if;
  raise exception 'Las líneas de una factura emitida no se pueden cambiar';
end $$;

-- p_lineas: [{linea, descripcion, grupo, orden}] (solo las que cambian; las demás se quedan como están)
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
    update facturas_lineas set descripcion = trim(l->>'descripcion'), grupo = left(nullif(trim(l->>'grupo'), ''), 250),
                               orden = coalesce((l->>'orden')::int, orden)
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

commit;
