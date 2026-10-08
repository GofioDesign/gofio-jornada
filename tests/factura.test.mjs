// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcular, irpfCliente, categoriaDeFamilia, categoriaDe, porCategoria, resumenPorCategoria, totalPorIgic, conceptoDe, porConcepto } from '../app/js/lib/factura.js';

test('calcular: mismos totales que la prueba SQL de emitir_factura', () => {
  // 75 € -5 % + 3,5 h a 30 €, IGIC 7 %, IRPF 15 % (supabase/tests/pruebas.sql)
  const r = calcular([
    { cantidad: 1, pvp: 75, dto: 5, igic: 7 },
    { cantidad: 3.5, pvp: 30, dto: 0, igic: 7 },
  ], 15);
  assert.deepEqual([r.base, r.igic, r.irpf, r.total], [176.25, 12.34, 26.44, 162.15]);
  assert.deepEqual(r.lineas.map(l => l.base), [71.25, 105]);
});

test('calcular: IGIC agrupado por tipo, incluido el 0 %', () => {
  const r = calcular([
    { cantidad: 12.5, pvp: 35, igic: 7 },
    { cantidad: 4, pvp: 25, dto: 10, igic: 7 },
    { cantidad: 1, pvp: 40, igic: 0 },
  ], 15);
  assert.deepEqual(r.igic_desglose, [{ pct: 0, base: 40, cuota: 0 }, { pct: 7, base: 527.5, cuota: 36.93 }]);
  assert.deepEqual([r.base, r.igic, r.irpf, r.total], [567.5, 36.93, 85.13, 519.3]);
});

test('calcular: sin líneas o con campos vacíos da cero', () => {
  assert.equal(calcular([]).total, 0);
  assert.equal(calcular([{ descripcion: 'x', cantidad: '', pvp: '' }]).total, 0);
});

test('irpfCliente', () => {
  assert.equal(irpfCliente({ aplica_irpf: false, irpf_pct: 15 }, { irpf_defecto: 15 }), 0);
  assert.equal(irpfCliente({ aplica_irpf: true, irpf_pct: null }, { irpf_defecto: 7 }), 7);
  assert.equal(irpfCliente({ aplica_irpf: true, irpf_pct: 19 }, { irpf_defecto: 15 }), 19);
});

test('categorías: familias de la hoja v7 y valor explícito de la línea', () => {
  assert.equal(categoriaDeFamilia('FIJACIONES Y ACCESORIOS'), 'PEQUEÑO MATERIAL');
  assert.equal(categoriaDeFamilia('mano de obra'), 'MANO DE OBRA');
  assert.equal(categoriaDeFamilia('DISEÑO'), 'MANO DE OBRA');
  assert.equal(categoriaDeFamilia(''), 'OTROS');
  assert.equal(categoriaDe({ familia: 'MATERIALES', categoria: 'TRANSPORTE' }), 'TRANSPORTE');
  assert.equal(categoriaDe({ familia: 'MATERIALES', categoria: 'XX' }), 'MATERIALES');
});

test('agrupar por categoría: orden fijo, subtotales exactos y resumen por tipo de IGIC', () => {
  const ls = [
    { descripcion: 'Taco', base: 0.1, igic_pct: 7, familia: 'FIJACIONES Y ACCESORIOS' },
    { descripcion: 'Hora', base: 105, igic_pct: 7, categoria: 'MANO DE OBRA' },
    { descripcion: 'Taco 2', base: 0.2, igic_pct: 7, categoria: 'PEQUEÑO MATERIAL' },
    { descripcion: 'Cable', base: 42, igic_pct: 7, familia: 'MATERIALES' },
    { descripcion: 'Exento', base: 10, igic_pct: 0, familia: 'MATERIALES' },
  ];
  const g = porCategoria(ls);
  assert.deepEqual(g.map(x => [x.categoria, x.base]), [['MANO DE OBRA', 105], ['MATERIALES', 52], ['PEQUEÑO MATERIAL', 0.3]]);
  assert.deepEqual(resumenPorCategoria(ls).map(x => [x.categoria, x.igic_pct, x.base]),
    [['MANO DE OBRA', 7, 105], ['MATERIALES', 0, 10], ['MATERIALES', 7, 42], ['PEQUEÑO MATERIAL', 7, 0.3]]);
});

test('totalPorIgic y conceptoDe: un solo concepto con el total (agrupación TOTAL)', () => {
  const ls = [
    { descripcion: 'Diseño', base: 0.1, igic_pct: 7 }, { descripcion: 'Maquetación', base: 0.2, igic_pct: 7 },
    { descripcion: 'Libro', base: 40, igic_pct: 0 },
  ];
  assert.deepEqual(totalPorIgic(ls), [{ igic_pct: 0, base: 40 }, { igic_pct: 7, base: 0.3 }]);   // céntimos exactos
  assert.equal(conceptoDe('  Servicios de septiembre ', ls), 'Servicios de septiembre');
  assert.equal(conceptoDe('', ls), 'Diseño · Maquetación · Libro');
  assert.equal(conceptoDe('x'.repeat(300), ls).length, 250);
});

test('porConcepto: suma las líneas con el mismo grupo e IGIC y deja sueltas las demás', () => {
  const ls = [
    { descripcion: 'Transporte urgente', base: 20, igic_pct: 7, grupo: 'Desplazamiento' },
    { descripcion: 'Plus urgencia', base: 20, igic_pct: 7 },
    { descripcion: 'Zona 2', base: 30, igic_pct: 7, grupo: ' Desplazamiento ' },
    { descripcion: 'Cable', base: 0.1, igic_pct: 7, grupo: 'Materiales' },
    { descripcion: 'Conector', base: 0.2, igic_pct: 7, grupo: 'Materiales' },
    { descripcion: 'Libro', base: 5, igic_pct: 0, grupo: 'Materiales' },
  ];
  assert.deepEqual(porConcepto(ls).map(r => [r.concepto, r.igic_pct, r.base]),
    [['Desplazamiento', 7, 50], ['Plus urgencia', 7, 20], ['Materiales', 7, 0.3], ['Materiales', 0, 5]]);
});

test('plantillasObs: iniciales si no hay, las guardadas si las hay (aunque sea lista vacía)', async () => {
  const { plantillasObs, OBSERVACIONES_INICIALES } = await import('../app/js/lib/factura.js');
  assert.equal(plantillasObs({}).length, OBSERVACIONES_INICIALES.length);
  assert.deepEqual(plantillasObs({ observaciones_plantillas: [] }), []);
  assert.deepEqual(plantillasObs({ observaciones_plantillas: [{ titulo: 'A', texto: 'x' }, { titulo: 'vacía', texto: ' ' }] }), [{ titulo: 'A', texto: 'x' }]);
});

test('anadirObs: separa con línea en blanco y no repite', async () => {
  const { anadirObs } = await import('../app/js/lib/factura.js');
  assert.equal(anadirObs('', 'Hola'), 'Hola');
  assert.equal(anadirObs('Uno\n', 'Dos'), 'Uno\n\nDos');
  assert.equal(anadirObs('Uno\n\nDos', 'Dos'), 'Uno\n\nDos');
});

test('borradorRectificativo: copia líneas en orden, con precio, grupo y referencia a la original', async () => {
  const { borradorRectificativo, motivoRectificativa } = await import('../app/js/lib/factura.js');
  const f = { id: 'f1', num: 'EMIT26-0004', fecha: '2026-10-08', irpf_pct: 0, agrupacion: 'CONCEPTO', observaciones: 'Nota',
    lineas: [{ linea: 2, descripcion: 'Cable', cantidad: '2', unidad: 'm', pvp_ud: '5.00', dto_pct: '0', igic_pct: '7.00', grupo: 'Materiales', familia: 'MATERIAL ELECTRICO' },
             { linea: 1, descripcion: 'Desplazamiento', cantidad: '1', pvp_ud: '30.00', dto_pct: '10', igic_pct: '7.00', grupo: null }] };
  const b = borradorRectificativo(f, '2026-10-09');
  assert.deepEqual(b.lineas.map(l => [l.descripcion, l.cantidad, l.pvp, l.dto, l.igic, l.grupo]),
    [['Desplazamiento', 1, 30, 10, 7, ''], ['Cable', 2, 5, 0, 7, 'Materiales']]);
  assert.equal(b.fecha, '2026-10-09'); assert.equal(b.concepto, null);
  assert.deepEqual(b.rectifica, { id: 'f1', num: 'EMIT26-0004', fecha: '2026-10-08' });
  assert.equal(motivoRectificativa(b.rectifica, ' Precio mal '), 'Rectifica la factura EMIT26-0004 de 08/10/2026. Precio mal');
});

test('urlWeb y urlWhatsApp', async () => {
  const { urlWeb, urlWhatsApp } = await import('../app/js/lib/factura.js');
  assert.equal(urlWeb('gofiodesign.eu'), 'https://gofiodesign.eu');
  assert.equal(urlWeb('http://x.es'), 'http://x.es');
  assert.equal(urlWeb(''), null);
  assert.equal(urlWhatsApp('622 33 44 55'), 'https://wa.me/34622334455');
  assert.equal(urlWhatsApp('+34 622-33-44-55'), 'https://wa.me/34622334455');
  assert.equal(urlWhatsApp('0049 151 2345678'), 'https://wa.me/491512345678');
  assert.equal(urlWhatsApp('12'), null);
});

test('ordenLineas: usa «orden» si existe y si no el número de línea', async () => {
  const { ordenLineas, borradorRectificativo } = await import('../app/js/lib/factura.js');
  const ls = [{ linea: 1, orden: 3 }, { linea: 2, orden: 1 }, { linea: 3, orden: 2 }];
  assert.deepEqual(ordenLineas(ls).map(l => l.linea), [2, 3, 1]);
  assert.deepEqual(ordenLineas([{ linea: 2 }, { linea: 1 }]).map(l => l.linea), [1, 2]);
  assert.deepEqual(borradorRectificativo({ lineas: ls.map(l => ({ ...l, descripcion: 'L' + l.linea, cantidad: 1, pvp_ud: 1 })) }, '2026-10-09').lineas.map(l => l.descripcion), ['L2', 'L3', 'L1']);
});
