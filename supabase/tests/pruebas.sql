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
select pg_temp.debe_fallar($$update organizaciones set plan_id = 'pro' where id = (select org from ctx)$$, 'suscripción');
select pg_temp.debe_fallar($$update organizaciones set tester_facturacion = true where id = (select org from ctx)$$, 'testers');
select pg_temp.debe_fallar($$update organizaciones set usa_facturacion = true where id = (select org from ctx)$$, 'testers');

-- ===== 2. Límite del plan gratis (5 usuarios) =====
reset role;
insert into auth.users select ('00000000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid, 'u' || i || '@t' from generate_series(1, 5) i;
do $$ begin
  insert into miembros (org_id, user_id, rol) select (select org from ctx), ('00000000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid, 'empleado' from generate_series(1, 3) i;
  begin
    insert into miembros (org_id, user_id, rol) values ((select org from ctx), '00000000-0000-0000-0000-000000000104', 'empleado');
    raise exception 'DEBÍA FALLAR límite';
  exception when others then if sqlerrm not like '%permite 5%' then raise; end if;
  end;
  delete from miembros where user_id::text like '00000000-0000-0000-0000-0000000001%';
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
select pg_temp.debe_fallar($$select public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
  '[{"descripcion":"x","cantidad":1,"pvp":1,"igic":7}]', 0, null, null, null, null, null, null, null, 'OTRA')$$, 'facturas_agrupacion_check');
select pg_temp.debe_fallar($$select public.emitir_factura((select org from ctx), (select id from clientes where codigo = 'B00000000'), '2026-09-24',
  '[{"descripcion":"x","cantidad":1,"pvp":1,"igic":7,"categoria":"VARIOS"}]', 0)$$, 'facturas_lineas_categoria_check');

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
select pg_temp.debe_fallar(format($q$select public.asignar_cliente(%L, now() - interval '1 min', null)$q$, (select org from ctx)), 'Elige un cliente');

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
             where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')) then
    raise exception 'anon puede ejecutar funciones de public';
  end if;
end $$;

select 'TODAS LAS PRUEBAS OK' as resultado;
