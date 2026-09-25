import { api } from '../api.js';
import { h, accion, aviso, hora, fecha, hoyISO, sumarDias, ROLES } from '../ui.js';
import { estadoActual, fmtMin, diaLocal, TIPOS } from '../lib/jornada.js';
import { toCSV, descargar } from '../lib/csv.js';

export async function vistaEquipo(app) {
  const hoy = hoyISO(app.tz);
  const [miembros, clientes, fichajesHoy, pendientes] = await Promise.all([
    api.miembros(app.org), api.clientes(app.org),
    api.fichajes(app.org, { desde: sumarDias(hoy, -1), hasta: hoy }), api.correccionesPendientes(app.org),
  ]);
  const nombre = id => miembros.find(m => m.user_id === id)?.nombre || 'Sin nombre';
  const cli = id => clientes.find(c => c.id === id)?.nombre;

  // ---------- ahora mismo ----------
  const ahora = h('div.tarjeta', h('h2', 'Ahora mismo'),
    h('ul.lista-equipo', miembros.filter(m => m.activo).map(m => {
      const st = estadoActual(fichajesHoy.filter(f => f.user_id === m.user_id));
      const txt = st.estado === 'FUERA' ? 'Fuera' : st.estado === 'PAUSA' ? 'En pausa' : st.desplazamiento ? `🚗 Hacia ${cli(st.desplazamiento.cliente_id) || 'destino'}` : `Trabajando${st.cliente_id ? ' · ' + cli(st.cliente_id) : ''}`;
      return h('li', h('span.punto.' + st.estado.toLowerCase()), h('strong', m.nombre || '—'), h('span.ayuda', txt + (st.desde ? ' · desde ' + hora(st.desde, app.tz) : '')));
    })));

  // ---------- correcciones ----------
  const correcciones = pendientes.length ? h('div.tarjeta.destacada', h('h2', `Correcciones pendientes (${pendientes.length})`),
    pendientes.map(f => h('div.fila',
      h('div', h('strong', nombre(f.user_id)), h('div', `${TIPOS[f.tipo]} · ${fecha(diaLocal(Date.parse(f.momento_declarado), app.tz))} a las ${hora(f.momento_declarado, app.tz)}`), h('small.ayuda', f.motivo)),
      h('div.fila-botones',
        h('button.btn', { onclick: e => accion(e.currentTarget, async () => { await api.revisarCorreccion(f.id, false); aviso('Rechazada'); window.dispatchEvent(new HashChangeEvent('hashchange')); }) }, 'Rechazar'),
        h('button.btn.primario', { onclick: e => accion(e.currentTarget, async () => { await api.revisarCorreccion(f.id, true); aviso('Aprobada', 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange')); }) }, 'Aprobar'))))) : null;

  // ---------- informe ----------
  const desde = h('input', { type: 'date', value: hoy.slice(0, 8) + '01', 'aria-label': 'Desde' });
  const hasta = h('input', { type: 'date', value: hoy, 'aria-label': 'Hasta' });
  const persona = h('select', { 'aria-label': 'Persona' }, h('option', { value: '' }, 'Todo el equipo'), miembros.map(m => h('option', { value: m.user_id }, m.nombre || m.user_id)));
  const tabla = h('div');
  let filas = [];
  const cargar = async () => {
    filas = await api.resumen(app.org, desde.value, hasta.value, persona.value || null);
    const porPersona = {};
    filas.forEach(r => { const p = porPersona[r.user_id] = porPersona[r.user_id] || { dias: 0, t: 0, p: 0, d: 0, km: 0 }; p.dias++; p.t += r.minutos_trabajo; p.p += r.minutos_pausa; p.d += r.minutos_desplazamiento; p.km += Number(r.km_linea_recta) || 0; });
    tabla.replaceChildren(
      Object.keys(porPersona).length ? h('table.tabla',
        h('thead', h('tr', h('th', 'Persona'), h('th', 'Días'), h('th', 'Trabajo'), h('th', 'Pausas'), h('th', 'Desplaz.'), h('th', 'Km'))),
        h('tbody', Object.entries(porPersona).map(([u, p]) => h('tr', h('td', nombre(u)), h('td', p.dias), h('td', fmtMin(p.t)), h('td', fmtMin(p.p)), h('td', fmtMin(p.d)), h('td', p.km.toLocaleString('es-ES', { maximumFractionDigits: 1 })))))) : h('p.vacio', 'Sin registros en ese periodo.'),
      filas.length ? h('details', h('summary', 'Ver por días'), h('table.tabla',
        h('thead', h('tr', h('th', 'Día'), h('th', 'Persona'), h('th', 'Entrada'), h('th', 'Salida'), h('th', 'Trabajo'))),
        h('tbody', filas.map(r => h('tr', h('td', fecha(r.dia)), h('td', r.nombre || nombre(r.user_id)), h('td', hora(r.primera_entrada, app.tz)), h('td', r.abierta ? 'abierta' : hora(r.ultima_salida, app.tz)), h('td', fmtMin(r.minutos_trabajo), r.correcciones ? ' *' : '')))))) : null);
  };
  [desde, hasta, persona].forEach(x => x.addEventListener('change', () => accion(null, cargar)));
  await cargar();

  const exportar = h('button.btn', {
    onclick: e => accion(e.currentTarget, async () => {
      const csv = toCSV(filas.map(r => ({
        Persona: r.nombre || nombre(r.user_id), NIF: miembros.find(m => m.user_id === r.user_id)?.nif || '', Fecha: r.dia,
        Entrada: r.primera_entrada ? hora(r.primera_entrada, app.tz) : '', Salida: !r.abierta && r.ultima_salida ? hora(r.ultima_salida, app.tz) : '',
        'Horas trabajo': Math.round(r.minutos_trabajo / 6) / 10, 'Minutos pausa': r.minutos_pausa, 'Minutos desplazamiento': r.minutos_desplazamiento,
        'Km línea recta': Number(r.km_linea_recta) || 0, Correcciones: r.correcciones,
      })), ['Persona', 'NIF', 'Fecha', 'Entrada', 'Salida', 'Horas trabajo', 'Minutos pausa', 'Minutos desplazamiento', 'Km línea recta', 'Correcciones']);
      descargar(`registro-jornada_${desde.value}_${hasta.value}.csv`, csv);
      await api.registrarExportacion(app.org, 'MANUAL_CSV', `${desde.value}..${hasta.value}`).catch(() => { });
    }),
  }, 'Descargar registro (CSV)');

  return h('section.pila',
    h('h1', 'Equipo'),
    correcciones, ahora,
    h('div.tarjeta', h('h2', 'Registro de jornada'),
      h('div.filtros', desde, hasta, persona, exportar), tabla,
      h('p.ayuda', '* Incluye correcciones aprobadas. El registro se conserva 4 años y no se puede borrar ni modificar.')),
    h('p.ayuda', 'Roles: ', Object.values(ROLES).join(' · '), '. Gestiona usuarios en Ajustes.'));
}
