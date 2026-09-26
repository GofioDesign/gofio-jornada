-- =====================================================================
-- GOFIO · 0006 · Aclaración de IGIC 0 % en las facturas
-- Si una factura lleva líneas al 0 % de IGIC, la ley pide indicar el motivo (exención, régimen
-- especial del pequeño empresario…). El texto se configura en Ajustes (config.texto_exencion_igic)
-- y se congela en emisor.nota_igic al emitir, como el resto de datos del emisor.
-- La huella no incluye el emisor, así que la cadena de la v7 no cambia.
-- =====================================================================

create or replace function public.facturas_nota_igic() returns trigger
language plpgsql set search_path = public as $$
declare v_nota text;
begin
  if exists (select 1 from jsonb_array_elements(coalesce(new.igic_desglose, '[]')) d where (d->>'pct')::numeric = 0) then
    select nullif(trim(config->>'texto_exencion_igic'), '') into v_nota from organizaciones where id = new.org_id;
    if v_nota is not null then new.emisor := coalesce(new.emisor, '{}') || jsonb_build_object('nota_igic', v_nota); end if;
  end if;
  return new;
end $$;

create trigger facturas_nota_igic before insert on public.facturas
  for each row execute function public.facturas_nota_igic();
