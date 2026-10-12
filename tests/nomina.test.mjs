// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { preciosHora, mesDe } from '../app/js/lib/nomina.js';

const tr = (dia, minutos, extra = {}) => ({ tipo: 'TRABAJO', cliente_id: 'E', user_id: 'yo', dia, minutos, fin: dia + 'T18:00:00Z', ...extra });

test('precio hora de cada nómina con las horas de ese mes', () => {
  const tramos = [
    tr('2026-09-01', 480), tr('2026-09-02', 480),
    tr('2026-09-03', 60, { cliente_id: 'OTRO' }),          // otro cliente: no cuenta
    tr('2026-09-04', 60, { user_id: 'otra' }),             // otra persona: no cuenta
    tr('2026-09-05', 30, { tipo: 'DESPLAZAMIENTO' }),      // desplazamiento: ya va dentro de la jornada
    tr('2026-09-06', 60, { fin: null }),                   // tramo en curso: no cuenta
    tr('2026-10-01', 600),
  ];
  const nominas = [
    { id: 1, cliente_id: 'E', mes: '2026-09-01', bruto: 320, neto: 256 },
    { id: 2, cliente_id: 'E', mes: '2026-10-01', bruto: null, neto: 150 },
    { id: 3, cliente_id: 'E', mes: '2026-08-01', bruto: 1000, neto: null },
    { id: 4, cliente_id: 'OTRO', mes: '2026-09-01', bruto: 1, neto: 1 },
  ];
  const r = preciosHora(nominas, tramos, 'E', 'yo');
  assert.deepEqual(r.map(n => n.id), [2, 1, 3]);   // del mes más reciente al más antiguo
  assert.deepEqual(r.map(n => [n.minutos, n.bruto_hora, n.neto_hora]), [[600, null, 15], [960, 20, 16], [0, null, null]]);
});

test('mes de una fecha', () => {
  assert.equal(mesDe('2026-09-30'), '2026-09');
});
