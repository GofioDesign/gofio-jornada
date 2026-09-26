// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcular, irpfCliente } from '../app/js/lib/factura.js';

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
