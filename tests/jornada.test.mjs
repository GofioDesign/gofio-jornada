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

test('asignar cliente a posteriori: se aplica desde la hora declarada y no cambia el total', () => {
  const sinCliente = [{ tipo: 'ENTRADA', momento: h('08:00') }, { tipo: 'PAUSA', momento: h('10:00') },
    { tipo: 'REANUDAR', momento: h('10:30') }, { tipo: 'SALIDA', momento: h('14:00') }];
  const asignada = { tipo: 'CAMBIO_CLIENTE', cliente_id: 'X', momento: h('18:00'), momento_declarado: h('08:00'), origen: 'RESPONSABLE', estado: 'APROBADA' };
  const otra = { tipo: 'CAMBIO_CLIENTE', cliente_id: 'B', momento: h('18:05'), momento_declarado: h('10:30'), origen: 'RESPONSABLE', estado: 'APROBADA' };
  const pendiente = { ...otra, cliente_id: 'Z', momento: h('18:10'), origen: 'CORRECCION', estado: 'PENDIENTE' };
  const s = totales(tramos([...sinCliente, asignada, otra, pendiente]));
  assert.equal(s.trabajo, 120 + 210);
  assert.deepEqual(s.porCliente, { X: 120, B: 210 });
  // aunque lleguen desordenadas, la asignación va después de la ENTRADA de la misma hora
  assert.deepEqual(totales(tramos([asignada, ...sinCliente])).porCliente, { X: 330 });
});

test('proyectos: las horas van al proyecto (y a su cliente); la pausa no, y al reanudar se sigue en él', () => {
  const tr = tramos([
    { tipo: 'ENTRADA', momento: h('08:00'), cliente_id: 'X', proyecto_id: 'P1' },
    { tipo: 'PAUSA', momento: h('10:00') }, { tipo: 'REANUDAR', momento: h('10:30') },
    { tipo: 'CAMBIO_CLIENTE', momento: h('12:00'), proyecto_id: 'P2' },
    { tipo: 'SALIDA', momento: h('13:00') }]);
  const s = totales(tr);
  assert.deepEqual(s.porProyecto, { P1: 210, P2: 60 });
  assert.deepEqual(s.porCliente, { X: 210, '': 60 });
  assert.equal(tr.find(x => x.tipo === 'PAUSA').proyecto_id, null);
  assert.equal(estadoActual([{ tipo: 'ENTRADA', momento: h('08:00'), proyecto_id: 'P1' }]).proyecto_id, 'P1');
});

test('los fichajes marcados como error no cuentan', () => {
  const anulado = { motivo: 'Fichaje de prueba' };
  const tr = tramos([...dia.slice(0, 4), { ...dia[4], anulado }, { ...dia[5] }]);
  assert.equal(totales(tr).porCliente.B, undefined);   // sin la llegada, no hay tramo en B
  assert.equal(estadoActual([{ tipo: 'ENTRADA', momento: h('08:00'), anulado }]).estado, 'FUERA');
  assert.equal(totales(tramos(dia.map(f => ({ ...f, anulado })))).trabajo, 0);
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

test('filasHorarios: una fila por tramo, ordenadas por persona, día y hora', async () => {
  const { filasHorarios, COLUMNAS_HORARIOS } = await import('../app/js/lib/jornada.js');
  const nombres = { a: 'Ana', b: 'Berto' };
  const filas = filasHorarios([
    { user_id: 'b', dia: '2026-10-01', tipo: 'TRABAJO', inicio: '2026-10-01T08:00:00Z', fin: '2026-10-01T09:30:00Z', minutos: 90, cliente_id: 'c1', proyecto_id: null, km: null },
    { user_id: 'a', dia: '2026-10-02', tipo: 'DESPLAZAMIENTO', inicio: '2026-10-02T07:40:00Z', fin: '2026-10-02T08:00:00Z', minutos: 20, cliente_id: null, proyecto_id: 'p1', km: 12.3 },
    { user_id: 'a', dia: '2026-10-02', tipo: 'TRABAJO', inicio: '2026-10-02T08:00:00Z', fin: null, minutos: 45, cliente_id: null, proyecto_id: null, km: 0 },
  ], { persona: u => nombres[u], nif: u => u === 'a' ? '1A' : null, cliente: id => id === 'c1' ? 'Casa María' : undefined,
       proyecto: id => id === 'p1' ? 'Jardín' : undefined, hora: x => x.slice(11, 16) });
  assert.deepEqual(filas.map(f => [f.Persona, f.Tipo, f.Inicio, f.Fin]), [['Ana', 'Desplazamiento', '07:40', '08:00'], ['Ana', 'Trabajo', '08:00', ''], ['Berto', 'Trabajo', '08:00', '09:30']]);
  assert.deepEqual(filas[0], { Persona: 'Ana', NIF: '1A', Fecha: '2026-10-02', Tipo: 'Desplazamiento', Inicio: '07:40', Fin: '08:00', Minutos: 20, Horas: 0.3, Cliente: '', Proyecto: 'Jardín', 'Km línea recta': 12.3 });
  assert.equal(filas[2].Horas, 1.5); assert.equal(filas[2].Cliente, 'Casa María');
  assert.deepEqual(Object.keys(filas[0]), COLUMNAS_HORARIOS);
});

test('tiempo por cliente o proyecto, con lo sin asignar al final', async () => {
  const { tiempoPorDestino } = await import('../app/js/lib/jornada.js');
  const r = tiempoPorDestino([
    { tipo: 'TRABAJO', user_id: 'a', cliente_id: 'c1', minutos: 60 },
    { tipo: 'TRABAJO', user_id: 'b', cliente_id: 'c1', minutos: 30 },
    { tipo: 'TRABAJO', user_id: 'a', cliente_id: 'c1', proyecto_id: 'p1', minutos: 120 },
    { tipo: 'TRABAJO', user_id: 'a', minutos: 500 },
    { tipo: 'PAUSA', user_id: 'a', minutos: 15 },
  ]);
  assert.deepEqual(r.map(f => [f.proyecto_id || f.cliente_id || '-', f.minutos, f.personas.length]), [['p1', 120, 1], ['c1', 90, 2], ['-', 500, 1]]);
});

test('hora local de la empresa a instante, también en horario de verano', async () => {
  const { momentoLocal } = await import('../app/js/lib/jornada.js');
  assert.equal(new Date(momentoLocal('2026-09-10', '09:00', 'Atlantic/Canary')).toISOString(), '2026-09-10T08:00:00.000Z');
  assert.equal(new Date(momentoLocal('2026-01-10', '09:00', 'Atlantic/Canary')).toISOString(), '2026-01-10T09:00:00.000Z');
  assert.equal(new Date(momentoLocal('2026-07-01', '23:30', 'Europe/Madrid')).toISOString(), '2026-07-01T21:30:00.000Z');
});

test('asignar solo una parte de un tramo', async () => {
  const { cambiosParaParte } = await import('../app/js/lib/jornada.js');
  const t = { inicio: '2026-09-10T07:00:00Z', fin: '2026-09-10T13:00:00Z', cliente_id: 'A', proyecto_id: null };
  const ms = s => Date.parse('2026-09-10T' + s + ':00Z');
  // en medio: se vuelve a A al final y se asigna B al principio de la parte
  assert.deepEqual(cambiosParaParte(t, ms('08:00'), ms('10:00'), { cliente_id: 'B' }),
    [{ momento: ms('10:00'), cliente_id: 'A', proyecto_id: null }, { momento: ms('08:00'), cliente_id: 'B', proyecto_id: null }]);
  // hasta el final del tramo: un solo cambio
  assert.equal(cambiosParaParte(t, ms('08:00'), ms('13:00'), { proyecto_id: 'P' }).length, 1);
  assert.throws(() => cambiosParaParte(t, ms('06:00'), ms('10:00'), { cliente_id: 'B' }));
  assert.throws(() => cambiosParaParte(t, ms('10:00'), ms('09:00'), { cliente_id: 'B' }));
});
