import assert from 'node:assert/strict';
import test from 'node:test';
import { codigoDuplicado, costeUnitario, datosPrecio, margenObjetivo } from '../app/js/lib/precios.js';

test('convierte el precio de un paquete a coste por unidad de venta', () => {
  assert.equal(costeUnitario(20, 100), 0.2);
  assert.equal(costeUnitario(8.6734, 1), 8.6734);
});

test('genera un código temporal libre al duplicar', () => {
  assert.equal(codigoDuplicado('CAJA', ['CAJA', 'CAJA (1)', 'CAJA (2)']), 'CAJA (3)');
  assert.equal(codigoDuplicado('CAJA (1)', ['CAJA', 'CAJA (1)']), 'CAJA (2)');
});

test('calcula el PVP ideal a partir del margen objetivo', () => {
  const d = datosPrecio(40, 100, { margen_ideal: 0.6 }, 'MATERIALES');
  assert.equal(d.ideal, 64);
  assert.equal(d.margen, 1.5);
  assert.equal(d.cumple, true);
});

test('el margen de familia prevalece sobre el general', () => {
  const config = { margen_ideal: 0.6, 'margen_ideal_mano de obra': 0.7 };
  assert.equal(margenObjetivo(config, 'MANO DE OBRA'), 0.7);
  assert.equal(datosPrecio(30, 90, config, 'MANO DE OBRA').ideal, 51);
});

test('admite márgenes superiores al cien por cien', () => {
  const d = datosPrecio(10, 30, { margen_ideal: 2 }, 'MATERIALES');
  assert.equal(d.ideal, 30);
  assert.equal(d.margen, 2);
  assert.equal(d.cumple, true);
});

test('sin coste no inventa un precio ideal', () => {
  assert.deepEqual(datosPrecio(0, 35, {}, 'SERVICIOS'), { objetivo: 0.6, ideal: null, margen: null, cumple: false });
});
