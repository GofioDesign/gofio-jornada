// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { diaSemana, horarioDe, previstoDia, previstoPeriodo, textoDia, errorHorario, fmtDiferencia } from '../app/js/lib/horario.js';

// Empresa: lunes a viernes 08:00–13:00 y 15:00–18:00. Ana: solo lunes 09:00–14:00.
const empresa = [1, 2, 3, 4, 5].flatMap(d => [{ user_id: null, dia_semana: d, inicio: '15:00:00', fin: '18:00:00' }, { user_id: null, dia_semana: d, inicio: '08:00:00', fin: '13:00:00' }]);
const horarios = [...empresa, { user_id: 'ana', dia_semana: 1, inicio: '09:00', fin: '14:00' }];

test('día de la semana: lunes 1, domingo 7', () => {
  assert.equal(diaSemana('2026-10-12'), 1);
  assert.equal(diaSemana('2026-10-11'), 7);
});

test('cada persona usa su horario o, si no tiene, el de la empresa', () => {
  assert.equal(horarioDe(horarios, 'pepe').length, 10);
  assert.deepEqual(horarioDe(horarios, 'ana').map(x => x.inicio), ['09:00']);
  assert.equal(previstoDia(horarioDe(horarios, 'pepe'), '2026-10-12'), 8 * 60);
  assert.equal(previstoDia(horarioDe(horarios, 'ana'), '2026-10-13'), 0);   // martes: Ana no trabaja
});

test('horas previstas de un periodo', () => {
  assert.equal(previstoPeriodo(empresa, '2026-10-05', '2026-10-11'), 40 * 60);   // semana completa
  assert.equal(previstoPeriodo(empresa, '2026-10-10', '2026-10-11'), 0);         // fin de semana
  assert.equal(previstoPeriodo(horarioDe(horarios, 'ana'), '2026-10-01', '2026-10-31'), 4 * 5 * 60);   // 4 lunes
});

test('texto del día', () => {
  assert.equal(textoDia(empresa, 1), '08:00–13:00 y 15:00–18:00');
  assert.equal(textoDia(empresa, 6), '');
});

test('errores al guardar', () => {
  assert.equal(errorHorario(empresa), null);
  assert.match(errorHorario([{ dia_semana: 2, inicio: '10:00', fin: '09:00' }]), /Martes.*acabar después/);
  assert.match(errorHorario([{ dia_semana: 1, inicio: '08:00', fin: '13:00' }, { dia_semana: 1, inicio: '12:30', fin: '14:00' }]), /Lunes.*solapan/);
  assert.match(errorHorario([{ dia_semana: 3, inicio: '', fin: '14:00' }]), /falta una hora/);
});

test('diferencia con signo', () => {
  assert.equal(fmtDiferencia(65), '+1 h 05 min');
  assert.equal(fmtDiferencia(-30), '−0 h 30 min');
  assert.equal(fmtDiferencia(0), '0 h 00 min');
});
