// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { tramos, totales, estadoActual, accionesPosibles, fmtMin } from '../app/js/lib/jornada.js';
import { wazeUrl, mapsUrl, direccionCompleta, distanciaKm } from '../app/js/lib/mapas.js';
import { toCSV, parseCSV, numES } from '../app/js/lib/csv.js';

const h = s => `2026-09-21T${s}:00+01:00`;
// Mismo día que la prueba SQL (supabase/tests/pruebas.sql)
const dia = [
  { tipo: 'ENTRADA', momento: h('08:00'), cliente_id: 'X', lat: 28.30, lng: -16.40 },
  { tipo: 'PAUSA', momento: h('10:00') },
  { tipo: 'REANUDAR', momento: h('10:30') },
  { tipo: 'DESPLAZAMIENTO_INICIO', momento: h('12:00'), cliente_id: 'B', lat: 28.35, lng: -16.37 },
  { tipo: 'DESPLAZAMIENTO_FIN', momento: h('12:30'), lat: 28.31, lng: -16.41 },
  { tipo: 'SALIDA', momento: h('16:00') },
];

test('tramos y totales coinciden con la función SQL', () => {
  const tr = tramos(dia);
  const s = totales(tr);
  assert.equal(s.trabajo, 450);
  assert.equal(s.pausa, 30);
  assert.equal(s.desplazamiento, 30);
  assert.equal(s.porCliente.X, 240);
  assert.equal(s.porCliente.B, 210);
  assert.ok(s.km > 5 && s.km < 7);
});

test('correcciones: solo cuentan las aprobadas, con su hora declarada', () => {
  const tr = tramos([...dia.slice(0, 5),
    { tipo: 'SALIDA', momento: h('18:00'), momento_declarado: h('17:00'), origen: 'CORRECCION', estado: 'APROBADA' },
    { tipo: 'SALIDA', momento: h('18:05'), momento_declarado: h('19:00'), origen: 'CORRECCION', estado: 'PENDIENTE' }]);
  assert.equal(totales(tr).trabajo, 120 + 390);
});

test('jornada abierta cuenta hasta ahora', () => {
  const tr = tramos(dia.slice(0, 3), new Date(h('11:00')).getTime());
  assert.equal(totales(tr).trabajo, 150);
});

test('estado y acciones posibles', () => {
  assert.deepEqual(accionesPosibles(estadoActual([])), ['ENTRADA', 'DESPLAZAMIENTO_INICIO']);
  const st = estadoActual(dia.slice(0, 4));
  assert.equal(st.estado, 'TRABAJANDO');
  assert.equal(st.desplazamiento.cliente_id, 'B');
  assert.deepEqual(accionesPosibles(st), ['DESPLAZAMIENTO_FIN', 'SALIDA']);
  assert.equal(estadoActual(dia.slice(0, 5)).cliente_id, 'B');
  assert.equal(estadoActual(dia).estado, 'FUERA');
  assert.equal(fmtMin(450), '7 h 30 min');
});

test('enlaces de Waze y Google Maps', () => {
  const c = { direccion: 'C/ Camino de la Cueva 22', cp: '38530', localidad: 'Cuevecitas', provincia: 'S/C de Tenerife' };
  assert.equal(direccionCompleta(c), 'C/ Camino de la Cueva 22, 38530 Cuevecitas, S/C de Tenerife');
  assert.match(wazeUrl(c), /^https:\/\/waze\.com\/ul\?q=C%2F%20Camino.*&navigate=yes$/);
  assert.equal(wazeUrl({ ...c, lat: 28.35, lng: -16.37 }), 'https://waze.com/ul?ll=28.350000,-16.370000&navigate=yes');
  assert.equal(mapsUrl({ lat: 28.35, lng: -16.37 }), 'https://www.google.com/maps/dir/?api=1&destination=28.350000,-16.370000&travelmode=driving');
  assert.equal(distanciaKm({ lat: 28.35, lng: -16.37 }, { lat: 28.35, lng: -16.37 }), 0);
});

test('CSV compatible con Excel/Sheets en español', () => {
  const csv = toCSV([{ a: 'x;y', b: 'dijo "hola"', c: 1.5 }]);
  assert.ok(csv.startsWith('﻿a;b;c\r\n'));
  assert.ok(csv.includes('"x;y";"dijo ""hola""";1,5'));
  const rows = parseCSV('NUM,TOTAL,NOTA\nEMIT26-0001,"465,75 €","a, b"\n');
  assert.deepEqual(rows, [{ NUM: 'EMIT26-0001', TOTAL: '465,75 €', NOTA: 'a, b' }]);
  assert.equal(numES('1.234,56 €'), 1234.56);
  assert.equal(numES('15,00%'), 15);
  assert.equal(numES(''), null);
});

test('un día pasado sin salida no suma horas abiertas', () => {
  assert.equal(totales(tramos(dia.slice(0, 3), null)).trabajo, 120);
});
