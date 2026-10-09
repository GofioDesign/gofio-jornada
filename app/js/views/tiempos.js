// TIEMPOS: a qué cliente o proyecto se dedicó el tiempo fichado. Es aparte del registro de jornada (Equipo):
// asignar un tramo no cambia las horas de entrada y salida, solo dice en qué se trabajó.
import { api } from '../api.js';
import { h, montar, accion, aviso, hora, fecha, hoyISO, sumarDias } from '../ui.js';
import { fmtMin, filasHorarios, COLUMNAS_HORARIOS, tiempoPorDestino, notaDeTramo, resumenNota } from '../lib/jornada.js';
import { asignarTramo, editarNotaTramo } from './jornada.js';
import { toCSV, descargar } from '../lib/csv.js';

export async function vistaTiempos(app) {
  const hoy = hoyISO(app.tz);
  const [miembros, clientes, proyectos, productos] = await Promise.all([
    api.miembros(app.org), api.clientes(app.org), api.proyectos(app.org).catch(() => []), api.productos(app.org).catch(() => []),
  ]);
  const nombre = id => miembros.find(m => m.user_id === id)?.nombre || 'Sin nombre';
  const cli = id => clientes.find(c => c.id === id)?.nombre;
  const pro = id => proyectos.find(p => p.id === id)?.nombre;
  const enQue = t => [pro(t.proyecto_id) && '📁 ' + pro(t.proyecto_id), cli(t.cliente_id)].filter(Boolean).join(' · ');

  const desde = h('input', { type: 'date', value: hoy.slice(0, 8) + '01', 'aria-label': 'Desde' });
  const hasta = h('input', { type: 'date', value: hoy, 'aria-label': 'Hasta' });
  const persona = h('select', { 'aria-label': 'Persona' }, h('option', { value: '' }, 'Todo el equipo'), miembros.map(m => h('option', { value: m.user_id }, m.nombre || m.user_id)));
  const soloSin = h('input', { type: 'checkbox', checked: true });
  const resumenEl = h('div'), tramosEl = h('div');
  let trs = [];

  const asignar = async (t, btn) => {
    if (await asignarTramo(app, clientes, proyectos, t, btn, { user: t.user_id,
      titulo: `${nombre(t.user_id)} · ${fecha(t.dia)} de ${hora(t.inicio, app.tz)} a ${t.fin ? hora(t.fin, app.tz) : 'ahora'}` })) await cargar();
  };
  const nota = async t => { if (await editarNotaTramo(app, t, notaDeTramo(notas, t), productos)) await cargar(); };

  const pintar = () => {
    const filas = tiempoPorDestino(trs);
    const total = filas.reduce((s, f) => s + f.minutos, 0);
    montar(resumenEl, filas.length ? h('table.tabla',
      h('thead', h('tr', h('th', 'Cliente o proyecto'), h('th', 'Personas'), h('th.num', 'Horas'), h('th.num', '%'))),
      h('tbody', filas.map(f => h('tr',
        h('td', f.sinAsignar ? h('em', 'Sin asignar') : enQue(f)), h('td', f.personas.map(nombre).join(', ')),
        h('td.num', fmtMin(f.minutos)), h('td.num', total ? Math.round(f.minutos * 100 / total) + ' %' : '')))),
      h('tfoot', h('tr', h('td', { colSpan: 2 }, 'Total trabajado'), h('td.num', fmtMin(total)), h('td'))))
      : h('p.vacio', 'Sin tiempo trabajado en ese periodo.'));
    const lista = trs.filter(t => !soloSin.checked || (!t.cliente_id && !t.proyecto_id))
      .sort((a, b) => b.dia.localeCompare(a.dia) || String(a.inicio).localeCompare(String(b.inicio)));
    montar(tramosEl, lista.length ? h('div.lista', lista.map(t => h('div.item',
        h('div', h('strong', `${fecha(t.dia)} · ${nombre(t.user_id)}`),
          h('small', `${hora(t.inicio, app.tz)} – ${t.fin ? hora(t.fin, app.tz) : 'ahora'} · ${fmtMin(t.minutos)} · ${enQue(t) || 'sin asignar'}`),
          notaDeTramo(notas, t) ? h('small.nota-tramo', '📝 ' + resumenNota(notaDeTramo(notas, t))) : null),
        h('div.fila-botones',
          h('button.btn.mini', { onclick: e => asignar(t, e.currentTarget) }, t.cliente_id || t.proyecto_id ? 'Cambiar' : 'Asignar'),
          h('button.btn.mini', { onclick: () => nota(t) }, notaDeTramo(notas, t) ? 'Nota' : '+ Nota')))))
      : h('p.vacio', soloSin.checked ? 'No hay tramos sin asignar en ese periodo. 👍' : 'Sin tramos de trabajo en ese periodo.'));
  };
  let notas = [];
  const cargar = async () => {
    [trs, notas] = await Promise.all([
      api.tramos(app.org, desde.value, hasta.value, persona.value || null).then(x => x.filter(t => t.tipo === 'TRABAJO')),
      api.notasTramo(app.org, desde.value, hasta.value, persona.value || null).catch(() => []),
    ]);
    pintar();
  };
  [desde, hasta, persona].forEach(x => x.addEventListener('change', () => accion(null, cargar)));
  soloSin.addEventListener('change', pintar);
  await cargar();

  // Horarios detallados: cada tramo con su hora de inicio y fin, cliente y proyecto
  const exportarHorarios = h('button.btn', {
    onclick: e => accion(e.currentTarget, async () => {
      const todos = await api.tramos(app.org, desde.value, hasta.value, persona.value || null);
      if (!todos.length) throw new Error('No hay horarios en ese periodo.');
      descargar(`horarios_${desde.value}_${hasta.value}.csv`, toCSV(filasHorarios(todos, {
        persona: nombre, nif: u => miembros.find(m => m.user_id === u)?.nif, cliente: cli, proyecto: pro, hora: x => hora(x, app.tz) }), COLUMNAS_HORARIOS));
      await api.registrarExportacion(app.org, 'MANUAL_CSV', `horarios ${desde.value}..${hasta.value}`).catch(() => { });
    }),
  }, 'Descargar horarios (CSV)');

  return h('section.pila',
    h('h1', 'Tiempos'),
    h('p.ayuda', 'En qué cliente o proyecto se ha trabajado. Asignar un tramo no cambia el registro de jornada (Equipo): las horas de entrada y salida siguen siendo las fichadas.'),
    h('div.filtros', desde, hasta, persona, exportarHorarios),
    h('div.tarjeta', h('h2', 'Horas por cliente y proyecto'), resumenEl),
    h('div.tarjeta', h('h2', 'Tramos'), h('p.ayuda', 'Asigna cliente o proyecto a un tramo entero o solo a una parte (de tal hora a tal hora), y añade una nota con las tareas y los materiales.'),
      h('label.check', soloSin, ' Solo sin asignar'), tramosEl));
}
