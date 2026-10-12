import assert from 'node:assert/strict';
import test from 'node:test';
import { espaciosDisponibles, espacioDeRuta, espacioActivo, menuDe } from '../app/js/lib/espacios.js';

test('espacios según el sondeo', () => {
  assert.deepEqual(espaciosDisponibles('ambos'), ['personal', 'pro']);
  assert.deepEqual(espaciosDisponibles('personal'), ['personal']);
  assert.deepEqual(espaciosDisponibles('profesional'), ['pro']);
  assert.deepEqual(espaciosDisponibles(null), ['pro']);
  assert.deepEqual(espaciosDisponibles('profesional', true), ['personal', 'pro']);
});

test('espacio de cada ruta', () => {
  assert.equal(espacioDeRuta('#/'), 'pro');
  assert.equal(espacioDeRuta('#/clientes/123'), 'pro');
  assert.equal(espacioDeRuta('#/personal'), 'personal');
  assert.equal(espacioDeRuta('#/ajustes'), null);
});

test('espacio activo: ruta, luego el último elegido', () => {
  const ambos = ['personal', 'pro'];
  assert.equal(espacioActivo(ambos, '#/proyectos', 'personal'), 'pro');
  assert.equal(espacioActivo(ambos, '#/ajustes', 'personal'), 'personal');
  assert.equal(espacioActivo(ambos, '#/ajustes', null), 'personal');
  assert.equal(espacioActivo(['personal'], '#/jornada', 'pro'), 'personal');
});

test('menú de la cabecera de cada espacio', () => {
  const hrefs = (e, o) => menuDe(e, o).map(x => x[0]);
  assert.deepEqual(hrefs('personal', { uso: 'ambos' }), ['#/personal', '#/ajustes']);
  assert.deepEqual(hrefs('personal', { uso: 'personal' }), ['#/personal', '#/jornada', '#/ajustes']);
  assert.deepEqual(hrefs('pro', { uso: 'ambos' }), ['#/', '#/clientes', '#/proyectos', '#/ajustes']);
  assert.deepEqual(hrefs('pro', { verEquipo: true, facturacion: true }), ['#/', '#/clientes', '#/proyectos', '#/equipo', '#/tiempos', '#/facturacion', '#/ajustes']);
});
