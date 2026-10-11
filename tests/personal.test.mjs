// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { totalesPorTarea, cronometro, minutosDe, clientesDesdeCSV, diaLocal, usaPersonal, usaProfesional } from '../app/js/lib/personal.js';
import { parseCSV, toCSV } from '../app/js/lib/csv.js';

test('totales por tarea, con el cronómetro en marcha hasta ahora', () => {
  const ahora = Date.parse('2026-10-11T10:00:00Z');
  const tiempos = [
    { tarea_id: 'cocinar', inicio: '2026-10-11T08:00:00Z', fin: '2026-10-11T08:45:00Z' },
    { tarea_id: 'ropa', inicio: '2026-10-11T09:00:00Z', fin: '2026-10-11T09:10:00Z' },
    { tarea_id: 'cocinar', inicio: '2026-10-11T09:30:00Z', fin: null },
  ];
  assert.deepEqual(totalesPorTarea(tiempos, ahora), [{ tarea_id: 'cocinar', minutos: 75 }, { tarea_id: 'ropa', minutos: 10 }]);
  assert.equal(minutosDe(tiempos[2], ahora), 30);
  assert.equal(cronometro('2026-10-11T08:58:55Z', ahora), '01:01:05');
});

test('día local en Canarias', () => {
  assert.equal(diaLocal('2026-10-11T23:30:00Z', 'Atlantic/Canary'), '2026-10-12');
  assert.equal(diaLocal('2026-10-11T22:30:00Z', 'Atlantic/Canary'), '2026-10-11');
});

test('usos del sondeo', () => {
  assert.equal(usaPersonal('ambos'), true);
  assert.equal(usaPersonal('indeciso'), false);
  assert.equal(usaProfesional('personal'), false);
  assert.equal(usaProfesional(null), true);
});

test('clientes desde CSV: cabeceras flexibles, NIF provisional y repetidos', () => {
  const csv = 'Nombre;NIF/CIF;Tipo;Correo;Teléfono;Población\nCasa María;12.345.678-z;Particular;m@x.es;600;Güímar\nNorte SL;;empresa;;;\n;B1;;;;\nOtra;12345678Z;;;;\nYa estaba;X1;;;;';
  const { clientes, errores } = clientesDesdeCSV(parseCSV(csv), [{ codigo: 'x1' }]);
  assert.deepEqual(clientes.map(c => [c.nombre, c.codigo, c.tipo]), [['Casa María', '12345678Z', 'PARTICULAR'], ['Norte SL', 'SIN-NIF-1', 'EMPRESA']]);
  assert.equal(clientes[0].email, 'm@x.es');
  assert.equal(clientes[0].localidad, 'Güímar');
  assert.equal(errores.length, 3);
  assert.match(errores[0], /Línea 4: falta el nombre/);
});

test('la plantilla que se descarga se vuelve a leer', () => {
  const texto = toCSV([{ nombre: 'A', nif: 'B00000000', tipo: 'empresa' }], ['nombre', 'nif', 'tipo']);
  assert.deepEqual(clientesDesdeCSV(parseCSV(texto)).clientes, [{ nombre: 'A', codigo: 'B00000000', tipo: 'EMPRESA' }]);
});

test('tareas propias separadas por comas', async () => {
  const { separarTareas } = await import('../app/js/lib/personal.js');
  assert.deepEqual(separarTareas(' planchar,  regar las   plantas; Planchar,\npasear al perro, ,'), ['Planchar', 'Regar las plantas', 'Pasear al perro']);
  assert.deepEqual(separarTareas(''), []);
});

test('nombre de la tarea personal a partir del proyecto', async () => {
  const { tareaDesdeProyecto } = await import('../app/js/lib/personal.js');
  assert.equal(tareaDesdeProyecto('Hogar - tender ropa'), 'Tender ropa');
  assert.equal(tareaDesdeProyecto('Casa: lavar loza'), 'Lavar loza');
  assert.equal(tareaDesdeProyecto('Gimnasio'), 'Gimnasio');
});
