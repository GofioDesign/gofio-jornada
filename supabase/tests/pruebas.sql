-- Pruebas de las migraciones en Postgres local (ver tests/ejecutar.sh).
-- Cada bloque falla con una excepción si algo no se comporta como debe.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test'),
  ('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test'),
  ('00000000-0000-0000-0000-00000000000c', 'otra@empresa.test');

create or replace function pg_temp.como(u text, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u, false);
  perform set_config('request.jwt.claim.email', email, false);
end $$;

create or replace function pg_temp.debe_fallar(sql text, contiene text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'DEBÍA FALLAR: %', sql;
exception when others then
  if sqlerrm like 'DEBÍA FALLAR%' or position(contiene in sqlerrm) = 0 then raise; end if;
end $$;

-- ===== 1. Alta de empresa, invitación y roles =====
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
create temp table ctx as select public.crear_organizacion('Gofio Design', '78563258L', 'Juan') as org;
grant all on ctx to authenticated;
-- plan Jornada (gratis): una sola persona; el equipo de prueba se pasa a Pro equipo con 5 asientos (0032)
select pg_temp.debe_fallar($$select public.invitar((select org from ctx), 'x@gofio.test')$$, 'permite 1 persona');
reset role;
update organizaciones set plan_id = 'equipo', asientos = 5 where id = (select org from ctx);
set role authenticated;
do $$ declare v_org uuid := (select org from ctx); tok text;
begin
  tok := public.invitar(v_org, 'Empleado@gofio.test', 'empleado', 'Pepe');
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
  perform set_config('request.jwt.claim.email', 'empleado@gofio.test', false);
  if (select count(*) from public.mis_invitaciones()) <> 1 then raise exception 'mis_invitaciones'; end if;
  perform public.aceptar_invitacion(tok);
  if not public.es_miembro(v_org) then raise exception 'empleado no es miembro'; end if;
  if public.puede_gestionar(v_org) then raise exception 'empleado no debería gestionar'; end if;
end $$;

-- el empleado no puede crear clientes; el propietario sí
select pg_temp.debe_fallar($$insert into clientes (org_id, codigo, nombre) values ((select org from ctx), 'X', 'X')$$, 'row-level security');
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
insert into clientes (org_id, codigo, nombre, direccion, localidad, lat, lng)
  values ((select org from ctx), 'X2241917S', 'MARIA GABRIELLE WARNECKE', 'C/ Camino de la Cueva 22', 'Candelaria', 28.35, -16.37),
         ((select org from ctx), 'B00000000', 'OBRA EL JARDÍN', 'Calle Falsa 1', 'Güímar', 28.31, -16.41);

-- el propietario no puede subirse de plan ni activarse facturación
select pg_temp.debe_fallar($$update organizaciones set plan_id = 'gratis' where id = (select org from ctx)$$, 'suscripción');
select pg_temp.debe_fallar($$update organizaciones set asientos = 50 where id = (select org from ctx)$$, 'suscripción');
select pg_temp.debe_fallar($$update organizaciones set copia_auto = true where id = (select org from ctx)$$, 'suscripción');
select pg_temp.debe_fallar($$update organizaciones set tester_facturacion = true where id = (select org from ctx)$$, 'testers');
select pg_temp.debe_fallar($$update organizaciones set usa_facturacion = true where id = (select org from ctx)$$, 'testers');

-- ===== 2. Límite de asientos (Pro equipo con 5) =====
reset role;
insert into auth.users select ('00000000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid, 'u' || i || '@t' from generate_series(1, 5) i;
do $$ begin
  insert into miembros (org_id, user_id, rol) select (select org from ctx), ('00000000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid, 'empleado' from generate_series(1, 3) i;
  begin
    insert into miembros (org_id, user_id, rol) values ((select org from ctx), '00000000-0000-0000-0000-000000000104', 'empleado');
    raise exception 'DEBÍA FALLAR límite';
  exception when others then if sqlerrm not like '%permite 5%' then raise; end if;
  end;
  -- plan caducado: vuelve al límite del plan gratis (1 persona)
  delete from miembros where user_id::text like '00000000-0000-0000-0000-0000000001%';
  update organizaciones set plan_hasta = current_date - 1 where id = (select org from ctx);
  if public.limite_usuarios((select org from ctx)) <> 1 then raise exception 'plan caducado'; end if;
  begin
    insert into miembros (org_id, user_id, rol) values ((select org from ctx), '00000000-0000-0000-0000-000000000101', 'empleado');
    raise exception 'DEBÍA FALLAR caducado';
  exception when others then if sqlerrm not like '%permite 1 persona%' then raise; end if;
  end;
  update organizaciones set plan_hasta = null where id = (select org from ctx);
  if public.limite_usuarios((select org from ctx)) <> 5 then raise exception 'asientos'; end if;
  -- copia automática: solo con Pro equipo y el plan en vigor
  update organizaciones set copia_auto = true, backup_drive_carpeta = 'x' where id = (select org from ctx);
  if not public.copia_activa((select org from ctx)) or not exists (select 1 from v_copias_pendientes where org_id = (select org from ctx)) then raise exception 'copia activa'; end if;
  update organizaciones set plan_hasta = current_date - 1 where id = (select org from ctx);
  if public.copia_activa((select org from ctx)) then raise exception 'copia con plan caducado'; end if;
  update organizaciones set copia_auto = false, backup_drive_carpeta = null, plan_hasta = null where id = (select org from ctx);
end $$;

-- ===== 3. Jornada: fichajes con reglas de estado =====
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
select count(*) from public.fichar((select org from ctx), 'ENTRADA', 28.30, -16.40, 10, (select id from clientes where codigo = 'X2241917S'));
select pg_temp.debe_fallar($$select public.fichar((select org from ctx), 'ENTRADA')$$, 'Ya tienes');
select count(*) from public.fichar((select org from ctx), 'PAUSA');
select pg_temp.debe_fallar($$select public.fichar((select org from ctx), 'PAUSA')$$, 'No estás trabajando');
select count(*) from public.fichar((select org from ctx), 'REANUDAR');
select count(*) from public.fichar((select org from ctx), 'DESPLAZAMIENTO_INICIO', 28.35, -16.37, 8, (select id from clientes where codigo = 'B00000000'));
select count(*) from public.fichar((select org from ctx), 'DESPLAZAMIENTO_FIN', 28.31, -16.41, 8);
do $$ begin
  if (select count(*) from public.fichar((select org from ctx), 'SALIDA')) <> 1 then raise exception 'salida'; end if;
  if (select estado from public.estado_jornada((select org from ctx))) <> 'FUERA' then raise exception 'estado final'; end if;
end $$;
-- desplazamiento estando fuera => ENTRADA automática; salida con desplazamiento abierto => lo cierra
do $$ begin
  if (select count(*) from public.fichar((select org from ctx), 'DESPLAZAMIENTO_INICIO', null, null, null, (select id from clientes where codigo = 'X2241917S'))) <> 2 then raise exception 'auto entrada'; end if;
  if (select count(*) from public.fichar((select org from ctx), 'SALIDA')) <> 2 then raise exception 'auto cierre desplazamiento'; end if;
end $$;

-- inmutabilidad
-- con la app (RLS) no hay permiso de update/delete: la operación no afecta a ninguna fila
do $$ declare n int; begin
  update fichajes set nota = 'x'; get diagnostics n = row_count; if n <> 0 then raise exception 'update permitido'; end if;
  delete from fichajes; get diagnostics n = row_count; if n <> 0 then raise exception 'delete permitido'; end if;
end $$;
reset role;  -- y ni siquiera un administrador de la base de datos puede
select pg_temp.debe_fallar($$update fichajes set nota = 'x'$$, 'no se pueden modificar');
select pg_temp.debe_fallar($$delete from fichajes$$, 'no se pueden borrar');

-- cadena de huellas: cada fichaje apunta al anterior del mismo usuario
do $$ begin
  if exists (select 1 from (select huella_anterior, lag(huella) over (order by momento, id) prev from fichajes) x
             where x.huella_anterior is distinct from x.prev) then raise exception 'cadena rota'; end if;
end $$;

-- Colocar horas conocidas (solo para la prueba: se desactivan los triggers)
set session_replication_role = replica;
with o as (select id, row_number() over (order by momento, id) n from fichajes)
update fichajes f set momento = timestamptz '2026-09-21 08:00 Atlantic/Canary' + (case o.n
    when 1 then interval '0'            -- ENTRADA (cliente X)
    when 2 then interval '2 hours'      -- PAUSA 10:00
    when 3 then interval '2 hours 30 min' -- REANUDAR 10:30
    when 4 then interval '4 hours'      -- DESPLAZAMIENTO_INICIO 12:00 -> B
    when 5 then interval '4 hours 30 min' -- DESPLAZAMIENTO_FIN 12:30 (en B)
    when 6 then interval '8 hours'      -- SALIDA 16:00
    else interval '1 day' + o.n * interval '1 min' end)
from o where o.id = f.id;
set session_replication_role = origin;

set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
do $$ declare r record; begin
  select * into r from public.resumen_jornada((select org from ctx), '2026-09-21', '2026-09-21');
  -- 08:00-10:00 (120) + 10:30-16:00 (330) = 450 trabajo; 30 pausa; 30 desplazamiento
  if r.minutos_trabajo <> 450 or r.minutos_pausa <> 30 or r.minutos_desplazamiento <> 30 then
    raise exception 'resumen incorrecto: % % %', r.minutos_trabajo, r.minutos_pausa, r.minutos_desplazamiento; end if;
  if r.km_linea_recta not between 5 and 7 then raise exception 'km: %', r.km_linea_recta; end if;
end $$;
do $$ declare x int; b int; d int; begin
  select sum(minutos) filter (where tipo = 'TRABAJO' and cliente_id = (select id from clientes where codigo = 'X2241917S')),
         sum(minutos) filter (where tipo = 'TRABAJO' and cliente_id = (select id from clientes where codigo = 'B00000000')),
         sum(minutos) filter (where tipo = 'DESPLAZAMIENTO')
    into x, b, d from public.tramos_jornada((select org from ctx), '2026-09-21', '2026-09-21');
  -- X: 08-10 + 10:30-12:30 (el desplazamiento cuenta como trabajo del cliente de origen hasta llegar) = 240; B: 12:30-16:00 = 210
  if x <> 240 or b <> 210 or d <> 30 then raise exception 'tramos: X=% B=% D=%', x, b, d; end if;
end $$;

-- correcciones: el empleado pide, no se puede auto-aprobar, el propietario aprueba
do $$ declare c fichajes; begin
  c := public.solicitar_correccion((select org from ctx), 'SALIDA', timestamptz '2026-09-21 17:00 Atlantic/Canary', 'Olvidé fichar la salida real');
  begin perform public.revisar_correccion(c.id, true); raise exception 'DEBÍA FALLAR';
  exception when others then if sqlerrm = 'DEBÍA FALLAR' then raise; end if; end;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  perform public.revisar_correccion(c.id, true);
  if (select estado from fichajes where id = c.id) <> 'APROBADA' then raise exception 'no aprobada'; end if;
end $$;

-- ===== 4. Aislamiento entre empresas =====
select pg_temp.como('00000000-0000-0000-0000-00000000000c', 'otra@empresa.test');
do $$ begin
  if (select count(*) from fichajes) + (select count(*) from clientes) + (select count(*) from organizaciones) <> 0 then
    raise exception 'fuga de datos entre empresas'; end if;
end $$;
select pg_temp.debe_fallar($$select public.fichar((select org from ctx), 'ENTRADA')$$, 'Sin permiso');

-- ===== 5. Facturación solo para testers =====
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
select pg_temp.debe_fallar($$select public.emitir_factura((select org from ctx), (select id from clientes limit 1), current_date, '[{"descripcion":"x","cantidad":1,"pvp":10,"igic":7}]')$$, 'Sin permiso');
reset role;
update organizaciones set tester_facturacion = true, usa_facturacion = true where id = (select org from ctx);  -- lo hace Gofio Design
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');

-- maestros de facturación: upsert por código y precios idempotentes
select public.importar_maestros_facturacion((select org from ctx),
  '[{"codigo":"PROV","nombre":"Proveedor prueba"}]',
  '[{"codigo":"PROD","familia":"MATERIALES","descripcion":"Producto prueba","descripcion_factura":"Producto prueba","unidad":"ud","proveedor_codigo":"PROV","coste_ud":8,"pvp":12,"igic_pct":7,"activo":true}]',
  '[{"producto_codigo":"PROD","proveedor_codigo":"PROV","precio":7.5,"fecha":"2026-01-22"}]');
select public.importar_maestros_facturacion((select org from ctx),
  '[{"codigo":"PROV","nombre":"Proveedor actualizado"}]',
  '[{"codigo":"PROD","familia":"MATERIALES","descripcion":"Producto actualizado","descripcion_factura":"Producto","unidad":"ud","proveedor_codigo":"PROV","coste_ud":8,"pvp":13,"igic_pct":7,"activo":true}]',
  '[{"producto_codigo":"PROD","proveedor_codigo":"PROV","precio":7.5,"fecha":"2026-01-22"}]');
do $$ begin
  if (select count(*) from proveedores where codigo = 'PROV') <> 1 or
     (select nombre from proveedores where codigo = 'PROV') <> 'Proveedor actualizado' then raise exception 'upsert proveedor'; end if;
  if (select pvp from productos where codigo = 'PROD') <> 13 then raise exception 'upsert producto'; end if;
  if (select count(*) from precios_proveedor where precio = 7.5) <> 1 then raise exception 'precio duplicado'; end if;
  if (select mejor_precio from v_productos where codigo = 'PROD') <> 7.5 then raise exception 'mejor precio'; end if;
end $$;

-- histórico de la v7: la huella se conserva y la cadena continúa
select public.importar_historico_facturas((select org from ctx), $$[
 {"num":"EMIT25-0001","serie":"EMIT25","fecha":"2025-10-26","vencimiento":"2025-11-25","cliente_codigo":"X2241917S","cliente_nombre":"MARIA GABRIELLE WARNECKE",
  "base":708.75,"igic":49.61,"irpf_pct":25,"irpf":177.18,"total":581.18,"huella":"844f1cfd67bcddafcb7135a7931452a1866751d348dfa572bb54e65d227dc5e0",
  "lineas":[{"codigo":"1H-JARDIN","descripcion":"Horas de diseño de jardines","cantidad":47.25,"unidad":"h","pvp_ud":15,"base":708.75,"igic_pct":7,"igic":49.61}],
  "cobros":[{"fecha":"2025-10-29","importe":581.18}]},
 {"num":"EMIT26-0001","serie":"EMIT26","fecha":"2026-01-01","vencimiento":"2026-01-31","cliente_codigo":"X2241917S","cliente_nombre":"MARIA GABRIELLE WARNECKE",
  "base":506.25,"igic":35.44,"irpf_pct":15,"irpf":75.94,"total":465.75,"huella":"11e01548234ce3a4212d621dc585bc1291d3499823fc029b374ee3f505f65103",
  "cobros":[{"fecha":"2026-02-02","importe":465.75}]}
]$$::jsonb);
do $$ begin
  if (select huella_anterior from facturas where num = 'EMIT26-0001') is distinct from
     '844f1cfd67bcddafcb7135a7931452a1866751d348dfa572bb54e65d227dc5e0' then
    raise exception 'cadena importada no continúa';
  end if;
end $$;

-- horas pendientes del cliente B y factura con ellas
do $$ declare h jsonb; f facturas; begin
  select jsonb_agg(jsonb_build_object('user_id', user_id, 'dia', dia, 'tipo', tipo, 'minutos', minutos, 'km', km)) into h
    from public.horas_pendientes((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-01', '2026-09-30');
  if jsonb_array_length(h) <> 2 then raise exception 'horas pendientes: %', h; end if;
  -- mismas líneas que el borrador real de la v7: 75 € -5 % + 3,5 h a 30 €, IGIC 7 %, IRPF 15 %
  f := public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
        '[{"codigo":"1HTRANS","descripcion":"Transporte y primera hora","cantidad":1,"unidad":"ud","pvp":75,"dto":5,"igic":7,"coste":10.70},
          {"codigo":"1H-2PAX","descripcion":"Horas 2 personas","cantidad":3.5,"unidad":"h","pvp":30,"dto":0,"igic":7}]',
        15, null, null, null, null, null, null, h);
  if f.num <> 'EMIT26-0002' then raise exception 'numeración: %', f.num; end if;
  -- base 71,25 + 105 = 176,25 ; IGIC 12,34 ; IRPF 26,44 ; total 162,15
  if f.base <> 176.25 or f.igic <> 12.34 or f.irpf <> 26.44 or f.total <> 162.15 then
    raise exception 'totales: % % % %', f.base, f.igic, f.irpf, f.total; end if;
  if f.huella_anterior <> '11e01548234ce3a4212d621dc585bc1291d3499823fc029b374ee3f505f65103' then raise exception 'cadena v7 no continúa'; end if;
  if (select count(*) from public.horas_pendientes((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-01', '2026-09-30')) <> 0 then
    raise exception 'las horas deberían estar facturadas'; end if;
  begin
    perform public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
      '[{"descripcion":"x","cantidad":1,"pvp":1,"igic":7}]', 0, null, null, null, null, null, null, h);
    raise exception 'DEBÍA FALLAR doble facturación';
  exception when unique_violation then null; end;
  begin
    perform public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-01-01', '[{"descripcion":"x","cantidad":1,"pvp":1,"igic":7}]');
    raise exception 'DEBÍA FALLAR fecha anterior';
  exception when others then if sqlerrm not like '%anterior%' then raise; end if; end;
  -- la factura al 7 % no lleva aclaración de IGIC 0 %
  if f.emisor ? 'nota_igic' then raise exception 'nota IGIC en factura sin 0 %%'; end if;
end $$;

-- IGIC 0 %: la aclaración de Ajustes se congela en la factura
update organizaciones set config = config || '{"texto_exencion_igic":"Operación exenta de IGIC (prueba)"}' where id = (select org from ctx);
do $$ declare f facturas; begin
  f := public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
        '[{"descripcion":"Servicio exento","cantidad":1,"pvp":100,"igic":0}]', 0);
  if f.igic <> 0 or f.emisor->>'nota_igic' is distinct from 'Operación exenta de IGIC (prueba)' then
    raise exception 'nota IGIC 0 %%: % %', f.igic, f.emisor; end if;
end $$;

-- Categorías de factura (0014): producto → categoría por familia; línea → la suya, la del producto o la de su familia
insert into productos (org_id, codigo, familia, descripcion, unidad, pvp)
values ((select org from ctx), 'TACO', 'FIJACIONES Y ACCESORIOS', 'Taco', 'ud', 0.42);
do $$ declare f facturas; begin
  if (select categoria from productos where codigo = 'PROD') <> 'MATERIALES'
     or (select categoria from productos where codigo = 'TACO') <> 'PEQUEÑO MATERIAL'
     or (select categoria from v_productos where codigo = 'TACO') <> 'PEQUEÑO MATERIAL' then raise exception 'categoría de producto'; end if;
  f := public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
        jsonb_build_array(
          jsonb_build_object('descripcion', 'Material', 'cantidad', 2, 'pvp', 13, 'igic', 7, 'producto_id', (select id from productos where codigo = 'PROD')),
          '{"descripcion":"Hora","cantidad":3,"pvp":35,"igic":7,"familia":"MANO DE OBRA"}'::jsonb,
          '{"descripcion":"Desplazamiento","cantidad":1,"pvp":20,"igic":7,"familia":"MATERIALES","categoria":"TRANSPORTE"}'::jsonb),
        0, null, null, null, null, null, null, null, 'RESUMEN');
  if f.agrupacion <> 'RESUMEN' or f.base <> 151 then raise exception 'agrupación: % %', f.agrupacion, f.base; end if;
  if (select string_agg(categoria, ',' order by linea) from facturas_lineas where factura_id = f.id)
     <> 'MATERIALES,MANO DE OBRA,TRANSPORTE' then raise exception 'categoría de línea'; end if;
  if (select agrupacion from v_facturas where id = f.id) <> 'RESUMEN' then raise exception 'v_facturas sin agrupación'; end if;
end $$;
do $$
declare f facturas;
begin
  -- 0018: concepto único con el total; las líneas se guardan con su cantidad y precio
  f := public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
        '[{"descripcion":"Diseño","cantidad":2,"pvp":30,"igic":7},{"descripcion":"Maqueta","cantidad":1,"pvp":15,"igic":7}]',
        0, null, null, null, null, null, null, null, 'TOTAL', '  Servicios de diseño  ');
  if f.agrupacion <> 'TOTAL' or f.concepto <> 'Servicios de diseño' or f.base <> 75 then raise exception 'concepto TOTAL: % % %', f.agrupacion, f.concepto, f.base; end if;
  if (select count(*) from facturas_lineas where factura_id = f.id) <> 2 then raise exception 'TOTAL debe guardar las líneas'; end if;
  f := public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
        '[{"descripcion":"Diseño","cantidad":2,"pvp":30,"igic":7}]', 0, null, null, null, null, null, null, null, 'CONCEPTO');
  if f.agrupacion <> 'CONCEPTO' or f.concepto <> 'Diseño' then raise exception 'CONCEPTO: % %', f.agrupacion, f.concepto; end if;
  -- 0019: grupo de cada línea
  f := public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
        '[{"descripcion":"A","cantidad":1,"pvp":10,"igic":7,"grupo":"  Material  "},{"descripcion":"B","cantidad":1,"pvp":5,"igic":7,"grupo":""}]',
        0, null, null, null, null, null, null, null, 'CONCEPTO');
  if (select string_agg(coalesce(grupo, '-'), ',' order by linea) from facturas_lineas where factura_id = f.id) <> 'Material,-'
    or f.base <> 15 then raise exception 'grupo de línea'; end if;
end $$;
select pg_temp.debe_fallar($$select public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
  '[{"descripcion":"x","cantidad":1,"pvp":1,"igic":7}]', 0, null, null, null, null, null, null, null, 'OTRA')$$, 'facturas_agrupacion_check');
select pg_temp.debe_fallar($$select public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
  '[{"descripcion":"x","cantidad":1,"pvp":1,"igic":7,"categoria":"VARIOS"}]', 0)$$, 'facturas_lineas_categoria_check');

do $$
declare f facturas; g facturas; r facturas; h text;
begin
  -- 0020: corregir textos de una emitida sin tocar importes ni huella
  f := public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
        '[{"descripcion":"Transporte","cantidad":1,"pvp":30,"igic":7},{"descripcion":"Cable","cantidad":2,"pvp":5,"igic":7}]',
        0, 'Nota', null, null, null, null, null, null, 'CONCEPTO');
  h := f.huella;
  g := public.corregir_textos_factura(f.id, '[{"linea":1,"descripcion":" Desplazamiento al domicilio "},{"linea":2,"descripcion":"Cable","grupo":"Materiales"}]',
        null, '  Garantía 6 meses  ');
  if g.huella <> h or g.total <> f.total or g.observaciones <> 'Garantía 6 meses' or g.textos_corregidos_en is null then raise exception 'corregir textos: factura'; end if;
  if (select string_agg(descripcion || '/' || coalesce(grupo, '-'), ',' order by linea) from facturas_lineas where factura_id = f.id)
     <> 'Desplazamiento al domicilio/-,Cable/Materiales' then raise exception 'corregir textos: líneas'; end if;
  if (select textos_corregidos_en from v_facturas where id = f.id) is null then raise exception 'v_facturas sin textos_corregidos_en'; end if;
  begin perform public.corregir_textos_factura(f.id, '[{"linea":9,"descripcion":"x"}]'); raise exception 'línea inexistente aceptada';
  exception when others then if sqlerrm not like '%no existe%' then raise; end if; end;
  begin perform public.corregir_textos_factura(f.id, '[{"linea":1,"descripcion":"  "}]'); raise exception 'descripción vacía aceptada';
  exception when others then if sqlerrm not like '%descripción%' then raise; end if; end;
  -- 0021: orden de las líneas (solo presentación)
  g := public.corregir_textos_factura(f.id, '[{"linea":1,"descripcion":"Desplazamiento al domicilio","orden":2},{"linea":2,"descripcion":"Cable","grupo":"Materiales","orden":1}]',
        null, 'Garantía 6 meses');
  if (select string_agg(linea::text, ',' order by coalesce(orden, linea)) from facturas_lineas where factura_id = f.id) <> '2,1'
     or g.huella <> h then raise exception 'orden de líneas'; end if;
  -- rectificativa: nueva serie RECT y la original queda RECTIFICADA
  r := public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
        '[{"descripcion":"Desplazamiento al domicilio","cantidad":1,"pvp":25,"igic":7}]', 0, null, null, null, null, f.id, 'Precio del desplazamiento');
  if r.tipo_doc <> 'RECTIFICATIVA' or r.num not like 'RECT26-%' or r.rectifica_a <> f.id then raise exception 'rectificativa: %', r.num; end if;
  if (select estado_cobro from v_facturas where id = f.id) <> 'RECTIFICADA' then raise exception 'original no queda rectificada'; end if;
end $$;
-- 0022: registrar una factura anterior (emitida fuera de la app)
do $$ declare v_org uuid := (select org from ctx); c uuid := (select id from clientes where codigo = 'X2241917S'); f facturas;
  l jsonb := '[{"descripcion":"Diseño de jardín","cantidad":2,"pvp":100,"igic":7,"categoria":"MANO DE OBRA"},{"descripcion":"Plantas","cantidad":1,"pvp":50,"igic":7,"grupo":"Materiales"}]';
begin
  f := public.registrar_factura_anterior(v_org, c, ' emit25-2 ', '2025-11-10', l, 0, 'Pagada en mano', 'DETALLE', null, '2025-11-20');
  if f.num <> 'EMIT25-0002' or f.serie <> 'EMIT25' or f.estado <> 'HISTORICA' or f.total <> 267.50 or f.emitida_en::date <> '2025-11-10'
     or f.huella <> 'IMPORTADA-SIN-HUELLA' or f.cliente->>'nombre' <> 'MARIA GABRIELLE WARNECKE' then raise exception 'anterior: %', to_jsonb(f); end if;
  if (select count(*) from facturas_lineas where factura_id = f.id) <> 2
     or (select grupo from facturas_lineas where factura_id = f.id and linea = 2) <> 'Materiales' then raise exception 'líneas anteriores'; end if;
  if (select pendiente from v_facturas where id = f.id) <> 0 then raise exception 'cobro anterior'; end if;
  -- sin cobro queda pendiente
  f := public.registrar_factura_anterior(v_org, c, 'EMIT25-0003', '2025-12-01', l);
  if (select pendiente from v_facturas where id = f.id) <> f.total then raise exception 'anterior sin cobro'; end if;
  begin perform public.registrar_factura_anterior(v_org, c, 'EMIT25-0002', '2025-11-10', l); raise exception 'número repetido aceptado';
  exception when others then if sqlerrm not like '%Ya hay%' then raise; end if; end;
  begin perform public.registrar_factura_anterior(v_org, c, 'EMIT25-0009', '2026-01-10', l); raise exception 'año cambiado aceptado';
  exception when others then if sqlerrm not like '%año%' then raise; end if; end;
  begin perform public.registrar_factura_anterior(v_org, c, 'factura 7', '2025-11-10', l); raise exception 'formato aceptado';
  exception when others then if sqlerrm not like '%formato%' then raise; end if; end;
  -- la app ya emite desde la EMIT26-0002: no se puede registrar una igual o posterior
  begin perform public.registrar_factura_anterior(v_org, c, 'EMIT26-0099', '2026-01-10', l); raise exception 'número futuro aceptado';
  exception when others then if sqlerrm not like '%posterior%' then raise; end if; end;
end $$;
select pg_temp.debe_fallar($$update facturas set concepto = 'x'$$, 'rectificativa');
select pg_temp.debe_fallar($$update facturas set total = 1$$, 'rectificativa');
do $$ declare n int; begin delete from facturas; get diagnostics n = row_count; if n <> 0 then raise exception 'delete facturas'; end if; end $$;
do $$ begin
  if exists (select 1 from public.comprobar_integridad((select org from ctx)) where not ok) then raise exception 'integridad'; end if;
  if (select estado_cobro from v_facturas where num = 'EMIT26-0002') <> 'PENDIENTE' then raise exception 'estado cobro'; end if;
  if (select estado_cobro from v_facturas where num = 'EMIT25-0001') <> 'HISTORICA' then raise exception 'historica'; end if;
end $$;

-- el empleado no ve facturación
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
do $$ begin if (select count(*) from facturas) <> 0 then raise exception 'empleado ve facturas'; end if; end $$;

-- ===== 6. Copia de seguridad =====
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
do $$ declare c jsonb := public.copia_jornada((select org from ctx)); begin
  if jsonb_array_length(c->'fichajes') < 8 or c->>'formato' <> 'gofio-jornada/1' then raise exception 'copia'; end if;
end $$;


-- ===== 7. Seguridad (0007) =====
-- un empleado no puede descargar la copia de la empresa
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
select pg_temp.debe_fallar(format('select public.copia_jornada(%L)', (select org from ctx)), 'Sin permiso');
-- ni consultar el estado de otra persona
select pg_temp.debe_fallar(format('select * from public.estado_jornada(%L, %L)', (select org from ctx), '00000000-0000-0000-0000-00000000000a'), 'Sin permiso');
-- alguien de otra empresa tampoco ve el estado de nadie
select pg_temp.como('00000000-0000-0000-0000-00000000000c', 'otra@empresa.test');
select pg_temp.debe_fallar(format('select * from public.estado_jornada(%L)', (select org from ctx)), 'Sin permiso');
-- el propietario no se puede degradar ni desactivar desde la app
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
select pg_temp.debe_fallar(format($q$update miembros set rol = 'admin' where org_id = %L and user_id = '00000000-0000-0000-0000-00000000000a'$q$, (select org from ctx)), 'propietario');
select pg_temp.debe_fallar(format($q$update miembros set activo = false where org_id = %L and user_id = '00000000-0000-0000-0000-00000000000a'$q$, (select org from ctx)), 'propietario');
select pg_temp.debe_fallar(format($q$update miembros set rol = 'propietario' where org_id = %L and user_id = '00000000-0000-0000-0000-00000000000b'$q$, (select org from ctx)), 'propietario');

-- ===== 8. Asignar cliente a horas ya fichadas (0015) =====
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
create temp table entrada as select momento from public.fichar((select org from ctx), 'ENTRADA');  -- sin cliente
grant all on entrada to authenticated;
do $$ declare v_org uuid := (select org from ctx); m timestamptz := (select momento from entrada);
  x uuid := (select id from clientes where codigo = 'X2241917S'); c fichajes;
begin
  -- el empleado lo solicita: queda pendiente y no cambia nada todavía
  c := public.asignar_cliente(v_org, m, x);
  if c.estado <> 'PENDIENTE' or c.tipo <> 'CAMBIO_CLIENTE' then raise exception 'asignación del empleado: %', c.estado; end if;
  if (select t.cliente_id from public.tramos_jornada(v_org, current_date - 1, current_date + 1) t where t.fin is null) is not null then
    raise exception 'una asignación pendiente no debe contar'; end if;
  -- no puede asignar horas de otra persona
  begin perform public.asignar_cliente(v_org, m, x, '00000000-0000-0000-0000-00000000000a'); raise exception 'DEBÍA FALLAR';
  exception when others then if sqlerrm not like 'Sin permiso%' then raise; end if; end;
  -- el propietario la aplica directamente
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  c := public.asignar_cliente(v_org, m, x, '00000000-0000-0000-0000-00000000000b');
  if c.estado <> 'APROBADA' then raise exception 'asignación del propietario: %', c.estado; end if;
  if (select t.cliente_id from public.tramos_jornada(v_org, current_date - 1, current_date + 1, '00000000-0000-0000-0000-00000000000b') t
      where t.fin is null) is distinct from x then raise exception 'el tramo abierto no pasó al cliente X'; end if;
  -- no cuenta como corrección del horario
  if exists (select 1 from public.resumen_jornada(v_org, current_date - 1, current_date + 1, '00000000-0000-0000-0000-00000000000b') r
             where r.abierta and r.correcciones > 0) then raise exception 'la asignación cuenta como corrección'; end if;
end $$;
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
select pg_temp.debe_fallar(format($q$select public.asignar_cliente(%L, now() + interval '1 hour', (select id from clientes where codigo = 'X2241917S'))$q$, (select org from ctx)), 'futura');
select pg_temp.debe_fallar(format($q$select public.asignar_cliente(%L, timestamptz '2026-09-21 03:00 Atlantic/Canary', (select id from clientes where codigo = 'X2241917S'), '00000000-0000-0000-0000-00000000000b')$q$, (select org from ctx)), 'no hay trabajo');
-- las horas de un día ya facturado no se reasignan
select pg_temp.debe_fallar(format($q$select public.asignar_cliente(%L, timestamptz '2026-09-21 13:00 Atlantic/Canary', (select id from clientes where codigo = 'X2241917S'), '00000000-0000-0000-0000-00000000000b')$q$, (select org from ctx)), 'facturadas');

-- ===== 9. Proyectos (0016) =====
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
insert into proyectos (org_id, nombre, tipo, cliente_id) values
  ((select org from ctx), 'Reforma cocina', 'AJENO', (select id from clientes where codigo = 'X2241917S')),
  ((select org from ctx), 'Web propia', 'PROPIO', null),
  ((select org from ctx), 'Obra jardín', 'AJENO', (select id from clientes where codigo = 'B00000000'));
insert into proyectos (org_id, nombre, activo) values ((select org from ctx), 'Cerrado', false);
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
-- el empleado los ve pero no los crea
select pg_temp.debe_fallar($$insert into proyectos (org_id, nombre) values ((select org from ctx), 'X')$$, 'row-level security');
do $$ declare v_org uuid := (select org from ctx); f fichajes; t record;
  x uuid := (select id from clientes where codigo = 'X2241917S'); b uuid := (select id from clientes where codigo = 'B00000000');
  cocina uuid := (select id from proyectos where nombre = 'Reforma cocina'); web uuid := (select id from proyectos where nombre = 'Web propia');
begin
  if (select count(*) from proyectos) <> 4 then raise exception 'el empleado no ve los proyectos'; end if;
  -- (la jornada del empleado sigue abierta desde la sección 8)
  -- un proyecto con cliente pone también el cliente
  select * into f from public.fichar(v_org, 'CAMBIO_CLIENTE', p_proyecto => cocina);
  if f.cliente_id is distinct from x or f.proyecto_id is distinct from cocina then raise exception 'proyecto con cliente: % %', f.cliente_id, f.proyecto_id; end if;
  select * into t from public.tramos_jornada(v_org, current_date - 1, current_date + 1) where fin is null;
  if t.proyecto_id is distinct from cocina or t.cliente_id is distinct from x then raise exception 'tramo abierto sin el proyecto'; end if;
  -- un proyecto propio sin cliente vale por sí solo
  select * into f from public.fichar(v_org, 'CAMBIO_CLIENTE', p_proyecto => web);
  if f.cliente_id is not null or f.proyecto_id is distinct from web then raise exception 'proyecto propio'; end if;
  -- la pausa no se imputa al proyecto, y al reanudar se sigue en él
  perform public.fichar(v_org, 'PAUSA');
  perform public.fichar(v_org, 'REANUDAR');
  select * into t from public.tramos_jornada(v_org, current_date - 1, current_date + 1) where fin is null;
  if t.proyecto_id is distinct from web then raise exception 'al reanudar se pierde el proyecto'; end if;
end $$;
-- asignar a posteriori también admite proyecto (el empleado lo solicita; en otra transacción, para que now() sea posterior)
do $$ declare f fichajes; cocina uuid := (select id from proyectos where nombre = 'Reforma cocina'); begin
  f := public.asignar_cliente((select org from ctx), (select max(momento) from fichajes where tipo = 'REANUDAR' and origen = 'APP'), null, null, cocina);
  if f.estado <> 'PENDIENTE' or f.cliente_id is distinct from (select id from clientes where codigo = 'X2241917S')
     or f.proyecto_id is distinct from cocina then raise exception 'asignar proyecto'; end if;
end $$;
select pg_temp.debe_fallar($$select public.fichar((select org from ctx), 'CAMBIO_CLIENTE', p_proyecto => (select id from proyectos where nombre = 'Cerrado'))$$, 'cerrado');
select pg_temp.debe_fallar($$select public.fichar((select org from ctx), 'CAMBIO_CLIENTE', p_cliente => (select id from clientes where codigo = 'X2241917S'), p_proyecto => (select id from proyectos where nombre = 'Obra jardín'))$$, 'otro cliente');
select pg_temp.debe_fallar($$select public.fichar((select org from ctx), 'CAMBIO_CLIENTE')$$, 'Elige un cliente o un proyecto');
-- un proyecto con horas no se puede borrar (se cierra)
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
select pg_temp.debe_fallar($$delete from proyectos where nombre = 'Web propia'$$, 'foreign key');
-- otra empresa no ve los proyectos
select pg_temp.como('00000000-0000-0000-0000-00000000000c', 'otra@empresa.test');
do $$ begin if exists (select 1 from proyectos) then raise exception 'fuga de proyectos'; end if; end $$;
reset role;
-- la cadena de huellas sigue intacta con proyectos
do $$ begin
  if exists (select 1 from (select huella_anterior, lag(huella) over (partition by user_id order by momento, id) prev from fichajes) x
             where x.huella_anterior is distinct from x.prev) then raise exception 'cadena rota'; end if;
end $$;
set role authenticated;

-- ===== 10. Marcar fichajes como error (0017) =====
reset role;
create temp table hoy_b as select id from fichajes
  where user_id = '00000000-0000-0000-0000-00000000000b' and coalesce(momento_declarado, momento) > now() - interval '1 day';
grant all on hoy_b to authenticated;
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
-- el empleado no puede anular
select pg_temp.debe_fallar($$select public.anular_fichajes((select org from ctx), array(select id from hoy_b), 'prueba')$$, 'Sin permiso');
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
select pg_temp.debe_fallar($$select public.anular_fichajes((select org from ctx), array(select id from hoy_b), ' ')$$, 'motivo');
-- un día ya facturado no se toca
select pg_temp.debe_fallar($$select public.anular_fichajes((select org from ctx), array(select id from fichajes
  where user_id = '00000000-0000-0000-0000-00000000000b' and (coalesce(momento_declarado, momento) at time zone 'Atlantic/Canary')::date = '2026-09-21' limit 1), 'error')$$, 'facturado');
do $$ declare v_org uuid := (select org from ctx); n int; begin
  if (select estado from public.estado_jornada(v_org, '00000000-0000-0000-0000-00000000000b')) <> 'TRABAJANDO' then raise exception 'estado previo'; end if;
  n := public.anular_fichajes(v_org, array(select id from hoy_b), 'Fichajes de prueba');
  if n <> (select count(*) from hoy_b) then raise exception 'anulados: %', n; end if;
  -- repetir no duplica
  if public.anular_fichajes(v_org, array(select id from hoy_b), 'otra vez') <> 0 then raise exception 'anulación duplicada'; end if;
  -- dejan de contar: estado, tramos y resumen
  if (select estado from public.estado_jornada(v_org, '00000000-0000-0000-0000-00000000000b')) <> 'FUERA' then raise exception 'sigue trabajando'; end if;
  if exists (select 1 from public.tramos_jornada(v_org, current_date - 1, current_date + 1, '00000000-0000-0000-0000-00000000000b')) then raise exception 'tramos anulados'; end if;
  if exists (select 1 from public.resumen_jornada(v_org, current_date - 1, current_date + 1, '00000000-0000-0000-0000-00000000000b')) then raise exception 'resumen anulado'; end if;
  -- el original sigue ahí y la copia lleva las anulaciones
  if (select count(*) from fichajes where id in (select id from hoy_b)) <> (select count(*) from hoy_b) then raise exception 'se borró el original'; end if;
  if jsonb_array_length(public.copia_jornada(v_org)->'anulaciones') <> (select count(*) from hoy_b) then raise exception 'copia sin anulaciones'; end if;
end $$;
-- el empleado ve sus anulaciones y puede volver a fichar
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
do $$ begin
  if (select count(*) from fichajes_anulados) = 0 then raise exception 'el empleado no ve sus anulaciones'; end if;
  perform public.fichar((select org from ctx), 'ENTRADA');
end $$;
reset role;
select pg_temp.debe_fallar($$delete from fichajes_anulados$$, 'no se puede');
select pg_temp.debe_fallar($$update fichajes_anulados set motivo = 'x'$$, 'no se puede');
set role authenticated;

-- ===== 11. API de solo lectura con clave (0023) =====
reset role;
create temp table clave_api (clave text);
grant all on clave_api to authenticated, anon;
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
select pg_temp.debe_fallar($$select public.crear_clave_api((select org from ctx), 'Hoja')$$, 'propietario');
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
select pg_temp.debe_fallar($$select public.crear_clave_api((select org from ctx), ' ')$$, 'nombre');
insert into clave_api select public.crear_clave_api((select org from ctx), 'Hoja de horarios');
do $$ begin
  if (select clave from clave_api) !~ '^gj_[0-9a-f]{48}$' then raise exception 'formato de clave'; end if;
  if (select count(*) from api_claves) <> 1 or exists (select 1 from api_claves where huella like '%' || (select clave from clave_api) || '%')
    then raise exception 'la clave se guarda en claro'; end if;
end $$;
select pg_temp.debe_fallar($$insert into api_claves (org_id, nombre, prefijo, huella, creada_por) values ((select org from ctx), 'x', 'x', 'x', auth.uid())$$, 'permission denied');
-- un visitante sin sesión lee con la clave, y solo con ella
reset role;
select pg_temp.como('', '');
set role anon;
do $$ declare k text := (select clave from clave_api); n int; begin
  select count(*) into n from public.api_horarios(k, '2026-09-21', '2026-09-21');
  if n = 0 then raise exception 'api_horarios sin filas'; end if;
  if exists (select 1 from public.api_horarios(k, '2026-09-21', '2026-09-21') where persona is null or tipo is null) then raise exception 'api_horarios incompleto'; end if;
  if (select count(*) from public.api_resumen(k, '2026-09-21', '2026-09-21')) = 0 then raise exception 'api_resumen sin filas'; end if;
  if not exists (select 1 from public.api_facturas(k, '2025-01-01', '2025-12-31') where num = 'EMIT25-0001') then raise exception 'api_facturas'; end if;
  begin perform public.api_horarios('gj_falsa', '2026-09-21', '2026-09-21'); raise exception 'clave falsa aceptada';
  exception when others then if sqlerrm not like '%no válida%' then raise; end if; end;
  begin perform public.api_horarios(k, '2024-01-01', '2026-09-21'); raise exception 'periodo largo aceptado';
  exception when others then if sqlerrm not like '%un año%' then raise; end if; end;
end $$;
select pg_temp.debe_fallar($$select * from api_claves$$, 'permission denied');
-- revocada deja de servir
reset role;
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
set role authenticated;
select public.revocar_clave_api((select id from api_claves limit 1));
reset role;
select pg_temp.como('', '');
set role anon;
select pg_temp.debe_fallar(format('select * from public.api_horarios(%L, %L, %L)', (select clave from clave_api), '2026-09-21', '2026-09-21'), 'revocada');
reset role;
set role authenticated;

-- ===== 12. Superadministración (0024) =====
-- el propietario de una empresa no es superadmin
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
do $$ begin if public.es_superadmin() then raise exception 'propietario como superadmin'; end if; end $$;
select pg_temp.debe_fallar($$select * from public.sa_empresas()$$, 'superadministración');
select pg_temp.debe_fallar($$select public.sa_crear_empresa('Otra', 'x@y.es')$$, 'superadministración');
select pg_temp.debe_fallar($$select public.sa_anular_invitacion((select org from ctx))$$, 'superadministración');
select pg_temp.debe_fallar($$select * from superadmins$$, 'permission denied');
select pg_temp.debe_fallar($$insert into superadmins values (auth.uid())$$, 'permission denied');
-- se da de alta desde la consola SQL
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000aa', 'sa@gofio.test'), ('00000000-0000-0000-0000-0000000000ab', 'nueva@unidad.test');
insert into superadmins (user_id) values ('00000000-0000-0000-0000-0000000000aa');
create temp table unidad (id uuid); grant all on unidad to authenticated;
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-0000000000aa', 'sa@gofio.test');
select pg_temp.debe_fallar($$select public.sa_crear_empresa('Otra', 'no-es-email')$$, 'email');
select pg_temp.debe_fallar($$select public.sa_crear_empresa('Otra', 'a@b.es', null, 'oro')$$, 'Plan');
select pg_temp.debe_fallar($$select public.sa_crear_empresa('Otra', 'a@b.es', null, 'gratis', false, 1, true)$$, 'copia automática');
select pg_temp.debe_fallar($$select public.sa_crear_empresa('Otra', 'a@b.es', null, 'equipo', false, 0)$$, 'al menos 1');
insert into unidad select public.sa_crear_empresa('Unidad Norte', ' Nueva@Unidad.test ', 'B12345678', 'equipo', true, 3, true);
do $$ declare e record; begin
  if not public.es_superadmin() then raise exception 'superadmin'; end if;
  select * into e from public.sa_empresas() where id = (select id from unidad);
  if e.nombre <> 'Unidad Norte' or e.plan_id <> 'equipo' or e.asientos <> 3 or not e.copia_auto or not e.tester_facturacion or not e.usa_facturacion
     or e.invitacion_pendiente <> 'nueva@unidad.test' or e.usuarios <> 0 then raise exception 'unidad creada: %', to_jsonb(e); end if;
  if (select count(*) from public.sa_empresas()) < 2 then raise exception 'sa_empresas no ve todas'; end if;
  -- el superadmin no es miembro: no ve sus datos por la app
  if exists (select 1 from organizaciones where id = (select id from unidad)) then raise exception 'superadmin ve la unidad por RLS'; end if;
  perform public.sa_actualizar_empresa((select id from unidad), 'gratis', '2027-01-31', false);
  select * into e from public.sa_empresas() where id = (select id from unidad);
  if e.plan_id <> 'gratis' or e.plan_hasta <> '2027-01-31' or e.asientos <> 1 or e.copia_auto or e.tester_facturacion or e.usa_facturacion then raise exception 'actualizar: %', to_jsonb(e); end if;
end $$;
-- cambiar el email de la invitación del propietario y anularla (0026)
do $$ begin
  perform public.sa_invitar_propietario((select id from unidad), 'otra@unidad.test');
  if (select invitacion_pendiente from public.sa_empresas() where id = (select id from unidad)) <> 'otra@unidad.test' then raise exception 'cambiar invitación'; end if;
  perform public.sa_anular_invitacion((select id from unidad));
  if (select invitacion_pendiente from public.sa_empresas() where id = (select id from unidad)) is not null then raise exception 'anular invitación'; end if;
  perform public.sa_invitar_propietario((select id from unidad), 'Nueva@Unidad.test');
end $$;
select pg_temp.debe_fallar($$select public.sa_anular_invitacion((select id from organizaciones limit 1))$$, 'pendiente');
select pg_temp.debe_fallar($$select public.sa_invitar_propietario((select id from unidad), 'x')$$, 'email');
-- el futuro propietario entra con su email y acepta
select pg_temp.como('00000000-0000-0000-0000-0000000000ab', 'nueva@unidad.test');
do $$ declare t text; begin
  select token into t from public.mis_invitaciones() where org_nombre = 'Unidad Norte';
  if t is null then raise exception 'sin invitación'; end if;
  perform public.aceptar_invitacion(t, 'Nueva');
  if (select rol from miembros where org_id = (select id from unidad) and user_id = auth.uid()) <> 'propietario' then raise exception 'no es propietario'; end if;
end $$;
select pg_temp.como('00000000-0000-0000-0000-0000000000aa', 'sa@gofio.test');
do $$ begin
  if (select propietario from public.sa_empresas() where id = (select id from unidad)) <> 'nueva@unidad.test'
     or (select invitacion_pendiente from public.sa_empresas() where id = (select id from unidad)) is not null then raise exception 'propietario tras aceptar'; end if;
end $$;
-- no se puede dejar una unidad con menos asientos que personas activas (Gofio Design tiene 2)
select pg_temp.debe_fallar($$select public.sa_actualizar_empresa((select org from ctx), 'gratis')$$, 'personas activas');
select pg_temp.debe_fallar($$select public.sa_actualizar_empresa((select org from ctx), 'equipo', null, false, 1)$$, 'personas activas');
reset role;
set role authenticated;

-- ===== Asignar solo una parte de un tramo y notas de trabajo (0025) =====
-- un día pasado del empleado sin cliente: 08:00 a 14:00
reset role;
select public._insertar_fichaje((select org from ctx), '00000000-0000-0000-0000-00000000000b', 'ENTRADA', null, null, null, null, null,
  'RESPONSABLE', timestamptz '2026-09-10 08:00 Atlantic/Canary', null, 'prueba', 'APROBADA');
select public._insertar_fichaje((select org from ctx), '00000000-0000-0000-0000-00000000000b', 'SALIDA', null, null, null, null, null,
  'RESPONSABLE', timestamptz '2026-09-10 14:00 Atlantic/Canary', null, 'prueba', 'APROBADA');
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
do $$ declare v_org uuid := (select org from ctx); b uuid := '00000000-0000-0000-0000-00000000000b';
  x uuid := (select id from clientes where codigo = 'X2241917S'); r text;
begin
  -- de 09:00 a 11:00 al cliente X: se deja «sin asignar» desde las 11:00 y se asigna X desde las 09:00
  perform public.asignar_cliente(v_org, timestamptz '2026-09-10 11:00 Atlantic/Canary', null, b);
  perform public.asignar_cliente(v_org, timestamptz '2026-09-10 09:00 Atlantic/Canary', x, b);
  select string_agg(to_char(t.inicio at time zone 'Atlantic/Canary', 'HH24:MI') || '-' || to_char(t.fin at time zone 'Atlantic/Canary', 'HH24:MI')
                    || '=' || coalesce((select codigo from clientes where id = t.cliente_id), '-'), ' ' order by t.inicio) into r
  from public.tramos_jornada(v_org, '2026-09-10', '2026-09-10', b) t where t.tipo = 'TRABAJO';
  if r <> '08:00-09:00=- 09:00-11:00=X2241917S 11:00-14:00=-' then raise exception 'tramo dividido: %', r; end if;
  -- la jornada sigue siendo de 6 horas
  if (select minutos_trabajo from public.resumen_jornada(v_org, '2026-09-10', '2026-09-10', b)) <> 360 then raise exception 'cambió la jornada'; end if;
  -- el propietario escribe la nota del tramo del empleado
  insert into notas_tramo (org_id, user_id, inicio, texto, materiales)
  values (v_org, b, timestamptz '2026-09-10 09:00 Atlantic/Canary', 'Cambio de grifo', '[{"descripcion": "Grifo monomando", "cantidad": 1, "unidad": "ud"}]');
end $$;
-- el empleado ve y edita sus notas, pero no escribe las de otra persona
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
do $$ begin
  if (select texto from notas_tramo where inicio = timestamptz '2026-09-10 09:00 Atlantic/Canary') <> 'Cambio de grifo' then raise exception 'el empleado no ve su nota'; end if;
  update notas_tramo set texto = 'Cambio de grifo y latiguillos' where inicio = timestamptz '2026-09-10 09:00 Atlantic/Canary';
  if not found then raise exception 'el empleado no edita su nota'; end if;
end $$;
select pg_temp.debe_fallar($$insert into notas_tramo (org_id, user_id, inicio, texto) values ((select org from ctx), '00000000-0000-0000-0000-00000000000a', now(), 'x')$$, 'row-level security');
select pg_temp.debe_fallar($$insert into notas_tramo (org_id, user_id, inicio, materiales) values ((select org from ctx), '00000000-0000-0000-0000-00000000000b', now(), '{}')$$, 'check constraint');
-- otra empresa no ve las notas
select pg_temp.como('00000000-0000-0000-0000-00000000000c', 'otra@empresa.test');
do $$ begin if exists (select 1 from notas_tramo) then raise exception 'fuga de notas'; end if; end $$;
reset role;

-- ===== Fichar con código QR (0030) =====
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
insert into puntos_qr (org_id, nombre, cliente_id) values ((select org from ctx), 'Taller', (select id from clientes where codigo = 'B00000000'));
create temp table qr as select id, token from puntos_qr where nombre = 'Taller';
grant all on qr to authenticated;
-- el token lo pone el servidor: ni al crear ni después
select pg_temp.debe_fallar($$insert into puntos_qr (org_id, nombre, token) values ((select org from ctx), 'X', 'mio')$$, 'permission denied');
select pg_temp.debe_fallar($$update puntos_qr set token = 'mio' where nombre = 'Taller'$$, 'permission denied');
-- el empleado no ve ni crea puntos, pero sí resuelve el código que escanea
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
select pg_temp.debe_fallar($$insert into puntos_qr (org_id, nombre) values ((select org from ctx), 'X')$$, 'row-level security');
do $$ declare p record; f fichajes; begin
  if exists (select 1 from puntos_qr) then raise exception 'el empleado no debería ver los puntos'; end if;
  select * into p from public.punto_qr((select token from qr));
  if p.nombre <> 'Taller' then raise exception 'punto_qr'; end if;
  -- se deja la jornada cerrada para empezar con el QR
  if (select estado from public.estado_jornada((select org from ctx))) <> 'FUERA' then perform public.fichar((select org from ctx), 'SALIDA'); end if;
  select * into f from public.fichar((select org from ctx), 'ENTRADA', p_qr => (select token from qr));
  if f.punto_id is distinct from (select id from qr) or f.cliente_id is distinct from (select id from clientes where codigo = 'B00000000') then
    raise exception 'la entrada con QR no toma el punto y su cliente: %', row_to_json(f);
  end if;
  select * into f from public.fichar((select org from ctx), 'SALIDA', p_qr => (select token from qr));
  if f.punto_id is distinct from (select id from qr) then raise exception 'salida con QR'; end if;
end $$;
-- otra empresa no puede usar el código
select pg_temp.como('00000000-0000-0000-0000-00000000000c', 'otra@empresa.test');
select pg_temp.debe_fallar($$select * from public.punto_qr((select token from qr))$$, 'no es de tu empresa');
-- al cambiar el código, el anterior deja de valer
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
select pg_temp.debe_fallar($$select public.renovar_qr((select id from qr))$$, 'Sin permiso');
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
do $$ declare t text; begin
  t := public.renovar_qr((select id from qr));
  if t = (select token from qr) or length(t) <> 36 then raise exception 'renovar_qr'; end if;
end $$;
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
select pg_temp.debe_fallar($$select public.fichar((select org from ctx), 'ENTRADA', p_qr => (select token from qr))$$, 'ya no está activo');
-- un punto desactivado tampoco vale
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
update puntos_qr set activo = false where id = (select id from qr);
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
select pg_temp.debe_fallar($$select * from public.punto_qr((select token from puntos_qr limit 1))$$, 'ya no está activo');
reset role;

-- ===== Firma mensual del registro (0030) =====
-- un día de marzo de 2025 del empleado: 08:00 a 16:00
select public._insertar_fichaje((select org from ctx), '00000000-0000-0000-0000-00000000000b', 'ENTRADA', null, null, null, null, null,
  'RESPONSABLE', timestamptz '2025-03-03 08:00 Atlantic/Canary', null, 'prueba firma', 'APROBADA');
select public._insertar_fichaje((select org from ctx), '00000000-0000-0000-0000-00000000000b', 'SALIDA', null, null, null, null, null,
  'RESPONSABLE', timestamptz '2025-03-03 16:00 Atlantic/Canary', null, 'prueba firma', 'APROBADA');
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
create temp table reg as select public.registro_para_firmar((select org from ctx), '2025-03-15') as r;
grant all on reg to authenticated;
do $$ declare r jsonb := (select r from reg); begin
  if (r->>'dias')::int <> 1 or (r->>'minutos')::int <> 480 or not (r->>'cerrado')::boolean or r->'firma' <> 'null'::jsonb then
    raise exception 'registro_para_firmar: %', r;
  end if;
  if position('2025-03-03;08:00;16:00;8:00;0:00;0:00;2' in r->>'documento') = 0 or position('Total: 8:00 de trabajo en 1 día' in r->>'documento') = 0 then
    raise exception 'documento: %', r->>'documento';
  end if;
end $$;
-- sin haber verificado un código no se firma; con un código de hace más de 10 minutos tampoco
select pg_temp.debe_fallar($$select public.firmar_registro((select org from ctx), '2025-03-01', (select r->>'huella' from reg), 'EMAIL')$$, 'código');
select set_config('request.jwt.claims', jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', extract(epoch from now())::bigint - 3600)))::text, false);
select pg_temp.debe_fallar($$select public.firmar_registro((select org from ctx), '2025-03-01', (select r->>'huella' from reg), 'EMAIL')$$, 'código');
-- con un código recién verificado
select set_config('request.jwt.claims', jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', extract(epoch from now())::bigint - 30)))::text, false);
select pg_temp.debe_fallar($$select public.firmar_registro((select org from ctx), '2025-03-01', 'otra', 'EMAIL')$$, 'ha cambiado');
select pg_temp.debe_fallar($$select public.firmar_registro((select org from ctx), '2025-03-01', (select r->>'huella' from reg), 'SMS')$$, 'teléfono');
select pg_temp.debe_fallar(format('select public.firmar_registro(%L, %L, %L, %L)', (select org from ctx), date_trunc('month', now())::date, 'x', 'EMAIL'), 'terminados');
do $$ declare f firmas_registro; r jsonb; begin
  f := public.firmar_registro((select org from ctx), '2025-03-01', (select reg.r->>'huella' from reg), 'EMAIL');
  if f.metodo <> 'EMAIL' or f.destino <> 'empleado@gofio.test' or f.periodo <> '2025-03-01' then raise exception 'firma: %', row_to_json(f); end if;
  r := public.registro_para_firmar((select org from ctx), '2025-03-01');
  if not (r->>'vigente')::boolean then raise exception 'la firma debería estar vigente'; end if;
end $$;
select pg_temp.debe_fallar($$select public.firmar_registro((select org from ctx), '2025-03-01', (select r->>'huella' from reg), 'EMAIL')$$, 'Ya has firmado');
-- ni siquiera la base de datos con todos los permisos cambia o borra una firma
reset role;
select pg_temp.debe_fallar($$update firmas_registro set destino = 'x'$$, 'no se pueden modificar');
select pg_temp.debe_fallar($$delete from firmas_registro$$, 'no se pueden modificar');
set role authenticated;
select pg_temp.debe_fallar($$insert into firmas_registro (org_id, user_id, periodo, documento, huella, dias, minutos, metodo, destino)
  values ((select org from ctx), '00000000-0000-0000-0000-00000000000b', '2025-04-01', 'x', 'x', 1, 1, 'EMAIL', 'x')$$, 'row-level security');
select pg_temp.debe_fallar($$select * from public.estado_firmas((select org from ctx), '2025-03-01')$$, 'Sin permiso');
select set_config('request.jwt.claims', '', false);
-- un responsable aprueba una corrección de ese mes: la firma deja de estar vigente
reset role;
select public._insertar_fichaje((select org from ctx), '00000000-0000-0000-0000-00000000000b', 'ENTRADA', null, null, null, null, null,
  'RESPONSABLE', timestamptz '2025-03-04 09:00 Atlantic/Canary', null, 'prueba firma', 'APROBADA');
select public._insertar_fichaje((select org from ctx), '00000000-0000-0000-0000-00000000000b', 'SALIDA', null, null, null, null, null,
  'RESPONSABLE', timestamptz '2025-03-04 13:00 Atlantic/Canary', null, 'prueba firma', 'APROBADA');
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
do $$ declare e record; begin
  select * into e from public.estado_firmas((select org from ctx), '2025-03-01') where user_id = '00000000-0000-0000-0000-00000000000b';
  if e.dias <> 2 or e.metodo <> 'EMAIL' or e.vigente then raise exception 'estado_firmas tras la corrección: %', row_to_json(e); end if;
end $$;
-- se vuelve a firmar, esta vez con certificado (la firma CAdES lleva dentro el SHA-512 del documento)
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
truncate reg;
insert into reg select public.registro_para_firmar((select org from ctx), '2025-03-01');
select pg_temp.debe_fallar($$select public.firmar_registro_certificado((select org from ctx), '2025-03-01', (select r->>'huella' from reg), 'no es base64')$$, 'no es válido');
select pg_temp.debe_fallar(format('select public.firmar_registro_certificado(%L, %L, %L, %L)', (select org from ctx), '2025-03-01', (select r->>'huella' from reg),
  encode('\x30'::bytea || decode(repeat(md5('relleno'), 19), 'hex'), 'base64')), 'no es del registro');
do $$ declare doc bytea := convert_to((select r->>'documento' from reg), 'UTF8'); f firmas_registro; e record; begin
  f := public.firmar_registro_certificado((select org from ctx), '2025-03-01', (select r->>'huella' from reg),
    encode('\x3082'::bytea || decode(repeat(md5('antes'), 12), 'hex') || sha512(doc) || decode(repeat(md5('después'), 3), 'hex'), 'base64'));
  if f.metodo <> 'CERTIFICADO' or f.firma_cms is null or f.dias <> 2 then raise exception 'firma con certificado: %', row_to_json(f); end if;
  perform pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
  select * into e from public.estado_firmas((select org from ctx), '2025-03-01') where user_id = '00000000-0000-0000-0000-00000000000b';
  if e.metodo <> 'CERTIFICADO' or not e.vigente then raise exception 'estado_firmas tras firmar con certificado: %', row_to_json(e); end if;
end $$;
-- otra empresa no ve las firmas
select pg_temp.como('00000000-0000-0000-0000-00000000000c', 'otra@empresa.test');
do $$ begin if exists (select 1 from firmas_registro) then raise exception 'fuga de firmas'; end if; end $$;
reset role;

-- ===== 0027. Tiempo personal: privado de cada persona =====
select pg_temp.como('00000000-0000-0000-0000-00000000000b', 'empleado@gofio.test');
set role authenticated;
insert into tareas_personales (nombre, orden) values ('Cocinar', 1), ('Tender la ropa', 2);
insert into tiempos_personales (tarea_id, inicio) select id, now() - interval '20 minutes' from tareas_personales where nombre = 'Cocinar';
-- solo un cronómetro en marcha
select pg_temp.debe_fallar($$insert into tiempos_personales (tarea_id) select id from tareas_personales where nombre = 'Tender la ropa'$$, 'duplicate key');
update tiempos_personales set fin = now() where fin is null;
insert into tiempos_personales (tarea_id) select id from tareas_personales where nombre = 'Tender la ropa';
do $$ begin if (select count(*) from tiempos_personales) <> 2 then raise exception 'la persona no ve sus tiempos'; end if; end $$;
-- el propietario de su empresa no ve nada, ni puede apuntar en una tarea ajena
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
set role authenticated;
do $$ begin if exists (select 1 from tareas_personales) or exists (select 1 from tiempos_personales) then raise exception 'fuga de tiempo personal'; end if; end $$;
select pg_temp.debe_fallar($$insert into tareas_personales (user_id, nombre) values ('00000000-0000-0000-0000-00000000000b', 'x')$$, 'row-level security');
reset role;
create temp table tarea_ajena as select id from tareas_personales where nombre = 'Cocinar';
grant select on tarea_ajena to authenticated;
set role authenticated;
select pg_temp.debe_fallar($$insert into tiempos_personales (tarea_id) select id from tarea_ajena$$, 'row-level security');
reset role;

-- ===== 0029. Eliminar y dar de baja unidades =====
select pg_temp.como('00000000-0000-0000-0000-0000000000aa', 'sa@gofio.test');
set role authenticated;
do $$ begin
  if (select con_registros from public.sa_empresas() where id = (select id from unidad)) then raise exception 'Unidad Norte no tiene registros'; end if;
  if not (select con_registros from public.sa_empresas() where id = (select org from ctx)) then raise exception 'la empresa de pruebas sí tiene registros'; end if;
end $$;
-- una unidad sin empezar se elimina ya, confirmando con su nombre
select pg_temp.debe_fallar($$select public.sa_eliminar_unidad((select id from unidad), 'Otra')$$, 'nombre exacto');
select public.sa_eliminar_unidad((select id from unidad), ' unidad norte ');
do $$ begin if exists (select 1 from public.sa_empresas() where id = (select id from unidad)) then raise exception 'no se eliminó'; end if; end $$;
-- con fichajes y facturas hay que darla de baja primero
select pg_temp.debe_fallar($$select public.sa_eliminar_unidad((select org from ctx), 'Gofio Design')$$, 'dala de baja');
-- solo el superadmin
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
select pg_temp.debe_fallar($$select public.sa_dar_de_baja((select org from ctx))$$, 'superadministración');
select pg_temp.debe_fallar($$select public.sa_copia_unidad((select org from ctx))$$, 'superadministración');
select pg_temp.como('00000000-0000-0000-0000-0000000000aa', 'sa@gofio.test');
do $$ declare v date; begin
  v := public.sa_dar_de_baja((select org from ctx), 'Cerró el negocio');
  -- hay facturas de 2026: 6 años desde el cierre de ese ejercicio
  if v < date '2033-01-01' then raise exception 'plazo de conservación: %', v; end if;
  if (select eliminar_desde from public.sa_empresas() where id = (select org from ctx)) <> v then raise exception 'eliminar_desde'; end if;
  if jsonb_array_length(public.sa_copia_unidad((select org from ctx))->'fichajes') = 0
     or jsonb_array_length(public.sa_copia_unidad((select org from ctx))->'facturas') = 0 then raise exception 'copia de la unidad'; end if;
end $$;
select pg_temp.debe_fallar($$select public.sa_dar_de_baja((select org from ctx))$$, 'ya está de baja');
select pg_temp.debe_fallar($$select public.sa_eliminar_unidad((select org from ctx), 'Gofio Design')$$, 'conservar sus datos hasta');
-- de baja, sus miembros no entran
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
do $$ begin
  if public.es_miembro((select org from ctx)) or exists (select 1 from clientes) or exists (select 1 from miembros) then raise exception 'unidad de baja accesible'; end if;
end $$;
select pg_temp.debe_fallar($$select public.fichar((select org from ctx), 'ENTRADA')$$, 'Sin permiso');
-- reactivar devuelve el acceso
select pg_temp.como('00000000-0000-0000-0000-0000000000aa', 'sa@gofio.test');
select public.sa_reactivar((select org from ctx));
select pg_temp.debe_fallar($$select public.sa_reactivar((select org from ctx))$$, 'no está de baja');
select pg_temp.como('00000000-0000-0000-0000-00000000000a', 'propietario@gofio.test');
do $$ begin if not public.es_miembro((select org from ctx)) then raise exception 'reactivar'; end if; end $$;
-- los fichajes siguen sin poder borrarse
reset role;
select pg_temp.debe_fallar($$delete from fichajes$$, 'registro legal');
select pg_temp.debe_fallar($$delete from facturas$$, 'rectificativa');
select pg_temp.debe_fallar($$delete from facturas_lineas$$, 'no se pueden cambiar');
-- baja otra vez y, con el plazo cumplido (se simula moviendo los datos 10 años atrás), se elimina todo
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-0000000000aa', 'sa@gofio.test');
select public.sa_dar_de_baja((select org from ctx));
reset role;
alter table fichajes disable trigger user;
update fichajes set momento = momento - interval '10 years', momento_declarado = momento_declarado - interval '10 years' where org_id = (select org from ctx);
alter table fichajes enable trigger user;
alter table facturas disable trigger user;
update facturas set fecha = fecha - interval '10 years' where org_id = (select org from ctx);
alter table facturas enable trigger user;
update gastos set fecha = fecha - interval '10 years' where org_id = (select org from ctx);
update organizaciones set eliminar_desde = current_date where id = (select org from ctx);
set role authenticated;
select pg_temp.como('00000000-0000-0000-0000-0000000000aa', 'sa@gofio.test');
select public.sa_eliminar_unidad((select org from ctx), 'Gofio Design');
reset role;
do $$ begin
  if exists (select 1 from organizaciones where id = (select org from ctx)) or exists (select 1 from fichajes where org_id = (select org from ctx))
     or exists (select 1 from facturas where org_id = (select org from ctx)) then raise exception 'no se eliminó todo'; end if;
  if coalesce(current_setting('gofio.purga_unidad', true), '') <> '' then raise exception 'la purga quedó abierta'; end if;
end $$;

-- un visitante SIN sesión (anon) no puede ejecutar ninguna función
reset role;
select pg_temp.como('', '');
grant select on ctx to anon;
set role anon;
select pg_temp.debe_fallar(format('select public.copia_jornada(%L)', (select org from ctx)), 'permission denied');
select pg_temp.debe_fallar(format('select * from public.estado_jornada(%L, %L)', (select org from ctx), '00000000-0000-0000-0000-00000000000a'), 'permission denied');
select pg_temp.debe_fallar($$select * from public.mis_invitaciones()$$, 'permission denied');
reset role;
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
               and p.proname not in ('api_horarios', 'api_resumen', 'api_facturas')) then
    raise exception 'anon puede ejecutar funciones de public';
  end if;
end $$;

-- toda función de public lleva search_path fijo (linter de Supabase, 0028)
do $$ declare v text; begin
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  if v is not null then raise exception 'funciones sin search_path: %', v; end if;
end $$;
-- el trigger del límite de usuarios no se llama por la API
do $$ begin
  if has_function_privilege('authenticated', 'public.comprobar_limite_usuarios()', 'execute') then
    raise exception 'authenticated puede ejecutar comprobar_limite_usuarios';
  end if;
end $$;

select 'TODAS LAS PRUEBAS OK' as resultado;
