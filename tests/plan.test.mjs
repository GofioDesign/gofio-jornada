import assert from 'node:assert/strict';
import test from 'node:test';
import { limiteUsuarios, copiaActiva, cuotaMensual } from '../app/js/lib/plan.js';

const JORNADA = { id: 'gratis', nombre: 'Jornada', max_usuarios: 1, por_asientos: false, precio_mes_eur: 0, precio_asiento_mes_eur: 0 };
const EQUIPO = { id: 'equipo', nombre: 'Jornada Pro equipo', max_usuarios: null, por_asientos: true, precio_mes_eur: 0, precio_asiento_mes_eur: 4 };
const EXTRAS = [{ id: 'copia_auto', nombre: 'Copia automática', precio_mes_eur: 0, precio_asiento_mes_eur: 1.5 },
                { id: 'facturacion', nombre: 'Facturación', precio_mes_eur: 9, precio_asiento_mes_eur: 0 }];

test('Jornada es para una persona; Pro equipo, una por asiento', () => {
  assert.equal(limiteUsuarios({ plan_id: 'gratis' }, JORNADA, '2026-10-11'), 1);
  assert.equal(limiteUsuarios({ plan_id: 'equipo', asientos: 7 }, EQUIPO, '2026-10-11'), 7);
});

test('con el plan caducado vuelve a una persona y sin copia automática', () => {
  const org = { plan_id: 'equipo', asientos: 7, copia_auto: true, plan_hasta: '2026-10-10' };
  assert.equal(limiteUsuarios(org, EQUIPO, '2026-10-11'), 1);
  assert.equal(copiaActiva(org, EQUIPO, '2026-10-11'), false);
  assert.equal(copiaActiva({ ...org, plan_hasta: null }, EQUIPO, '2026-10-11'), true);
  assert.equal(copiaActiva({ copia_auto: true }, JORNADA, '2026-10-11'), false);
});

test('la cuota suma asientos, copia por todos los asientos y facturación', () => {
  const c = cuotaMensual({ plan_id: 'equipo', asientos: 5, copia_auto: true, tester_facturacion: true }, EQUIPO, EXTRAS);
  assert.deepEqual(c.lineas.map(l => l.importe), [20, 7.5, 9]);
  assert.equal(c.total, 36.5);
  assert.equal(c.lineas[1].concepto, 'Copia automática · 5 asientos');
  assert.equal(cuotaMensual({ plan_id: 'gratis' }, JORNADA, EXTRAS).total, 0);
});
