import assert from 'node:assert/strict';
import test from 'node:test';
import { datosPrecio, margenObjetivo } from '../app/js/lib/precios.js';

test('calcula el PVP ideal a partir del margen objetivo', () => {
  const d = datosPrecio(40, 100, { margen_ideal: 0.6 }, 'MATERIALES');
  assert.equal(d.ideal, 100);
  assert.equal(d.margen, 0.6);
  assert.equal(d.cumple, true);
});

test('el margen de familia prevalece sobre el general', () => {
  const config = { margen_ideal: 0.6, 'margen_ideal_mano de obra': 0.7 };
  assert.equal(margenObjetivo(config, 'MANO DE OBRA'), 0.7);
  assert.equal(datosPrecio(30, 90, config, 'MANO DE OBRA').ideal, 100);
});

test('sin coste no inventa un precio ideal', () => {
  assert.deepEqual(datosPrecio(0, 35, {}, 'SERVICIOS'), { objetivo: 0.6, ideal: null, margen: null, cumple: false });
});
