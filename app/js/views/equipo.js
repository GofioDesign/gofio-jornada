import { api } from '../api.js';
import { h, montar, accion, aviso, hora, fecha, hoyISO, sumarDias, ROLES } from '../ui.js';
import { estadoActual, fmtMin, diaLocal, TIPOS } from '../lib/jornada.js';
import { marcarErrores } from './jornada.js';
import { toCSV, descargar } from '../lib/csv.js';
import { descargarFirma } from './firma.js';
import { mesesCerrados, nombreMes, METODOS } from '../lib/firma.js';
import { horarioDe, previstoDia, previstoPeriodo, fmtDiferencia } from '../lib/horario.js';

export async function vistaEquipo(app) {
  const hoy = hoyISO(app.tz);
  const [miembros, clientes, proyectos, fichajesHoy, pendientes, puntos] = await Promise.all([
    api.miembros(app.org), api.clientes(app.org), api.proyectos(app.org).catch(() => []),
    api.fichajes(app.org, { desde: sumarDias(hoy, -1), hasta: hoy }), api.correccionesPendientes(app.org),
    api.puntosQr(app.org).catch(() => []),
  ]);
  const horarios = await api.horarios(app.org).catch(() => []);
  const nombre = id => miembros.find(m => m.user_id === id)?.nombre || 'Sin nombre';
  const cli = id => clientes.find(c => c.id === id)?.nombre;

  // ---------- ahora mismo ----------
  const ahora = h('div.tarjeta', h('h2', 'Ahora mismo'),
    h('ul.lista-equipo', miembros.filter(m => m.activo).map(m => {
      const suyos = fichajesHoy.filter(f => f.user_id === m.user_id);
      const st = estadoActual(suyos);
      const txt = st.estado === 'FUERA' ? 'Fuera' : st.estado === 'PAUSA' ? 'En pausa' : st.desplazamiento ? `🚗 Hacia ${cli(st.desplazamiento.cliente_id) || 'destino'}` : `Trabajando${st.cliente_id ? ' · ' + cli(st.cliente_id) : ''}`;
      // Último fichaje con código QR: dónde se fichó
      const qr = puntos.find(p => p.id === suyos.filter(f => f.origen === 'APP').at(-1)?.punto_id);
      return h('li', h('span.punto.' + st.estado.toLowerCase()), h('strong', m.nombre || '—'), h('span.ayuda', txt + (st.desde ? ' · desde ' + hora(st.desde, app.tz) : '') + (qr ? ' · 📷 ' + qr.nombre : '')));
    })));

  // ---------- correcciones ----------
  const correcciones = pendientes.length ? h('div.tarjeta.destacada', h('h2', `Correcciones pendientes (${pendientes.length})`),
    pendientes.map(f => h('div.fila',
      h('div', h('strong', nombre(f.user_id)), h('div', `${TIPOS[f.tipo]}${f.tipo === 'CAMBIO_CLIENTE' ? ' ' + (cli(f.cliente_id) || 'cliente') : ''} · ${fecha(diaLocal(Date.parse(f.momento_declarado), app.tz))} a las ${hora(f.momento_declarado, app.tz)}`), h('small.ayuda', f.motivo)),
      h('div.fila-botones',
        h('button.btn', { onclick: e => accion(e.currentTarget, async () => { await api.revisarCorreccion(f.id, false); aviso('Rechazada'); window.dispatchEvent(new HashChangeEvent('hashchange')); }) }, 'Rechazar'),
        h('button.btn.primario', { onclick: e => accion(e.currentTarget, async () => { await api.revisarCorreccion(f.id, true); aviso('Aprobada', 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange')); }) }, 'Aprobar'))))) : null;

  // ---------- fichajes del equipo: marcar errores (asignar clientes y proyectos está en Tiempos) ----------
  const fDesde = h('input', { type: 'date', value: sumarDias(hoy, -7), 'aria-label': 'Desde' });
  const fHasta = h('input', { type: 'date', value: hoy, 'aria-label': 'Hasta' });
  const fPersona = h('select', { 'aria-label': 'Persona' }, h('option', { value: '' }, 'Todo el equipo'), miembros.map(m => h('option', { value: m.user_id }, m.nombre || m.user_id)));
  const fTabla = h('div');
  const errores = async (r, btn) => {
    const fs = await accion(btn, () => api.fichajes(app.org, { desde: r.dia, hasta: r.dia, user: r.user_id }));
    if (!fs) return;
    await marcarErrores(app, fs.filter(f => diaLocal(Date.parse(f.momento_declarado || f.momento), app.tz) === r.dia),
      { clientes, proyectos, persona: `${nombre(r.user_id)} · ${fecha(r.dia)}` });
  };
  const cargarFichajes = async () => {
    const dias = (await api.resumen(app.org, fDesde.value, fHasta.value, fPersona.value || null))
      .sort((a, b) => b.dia.localeCompare(a.dia) || nombre(a.user_id).localeCompare(nombre(b.user_id)));
    montar(fTabla, dias.length ? h('div.lista', dias.map(r => h('div.item',
        h('div', h('strong', `${fecha(r.dia)} · ${r.nombre || nombre(r.user_id)}`),
          h('small', `${hora(r.primera_entrada, app.tz)} – ${r.abierta ? 'abierta' : hora(r.ultima_salida, app.tz)} · ${fmtMin(r.minutos_trabajo)} de trabajo`)),
        h('button.btn.mini', { title: 'Marcar fichajes de este día como error', onclick: e => errores(r, e.currentTarget) }, 'Error…'))))
      : h('p.vacio', 'Sin fichajes en ese periodo.'));
  };
  [fDesde, fHasta, fPersona].forEach(x => x.addEventListener('change', () => accion(null, cargarFichajes)));
  await cargarFichajes();
  const fichajesEquipo = h('div.tarjeta', h('h2', 'Fichajes del equipo'),
    h('p.ayuda', 'Marca como error los fichajes de prueba o duplicados. Para decir en qué cliente o proyecto se trabajó, ve a ', h('a', { href: '#/tiempos' }, 'Tiempos'), '.'),
    h('div.filtros', fDesde, fHasta, fPersona), fTabla);

  // ---------- informe ----------
  const desde = h('input', { type: 'date', value: hoy.slice(0, 8) + '01', 'aria-label': 'Desde' });
  const hasta = h('input', { type: 'date', value: hoy, 'aria-label': 'Hasta' });
  const persona = h('select', { 'aria-label': 'Persona' }, h('option', { value: '' }, 'Todo el equipo'), miembros.map(m => h('option', { value: m.user_id }, m.nombre || m.user_id)));
  const tabla = h('div');
  let filas = [];
  // Horas previstas según el horario de cada persona, hasta hoy como mucho (los días que faltan aún no se pueden haber trabajado)
  const conHorario = horarios.length > 0;
  const previstoDe = (u, ini, fin) => previstoPeriodo(horarioDe(horarios, u), ini, fin < hoy ? fin : hoy);
  const previstoEnDia = r => previstoDia(horarioDe(horarios, r.user_id), r.dia);
  const cargar = async () => {
    filas = await api.resumen(app.org, desde.value, hasta.value, persona.value || null);
    const porPersona = {};
    const fila = u => porPersona[u] = porPersona[u] || { dias: 0, t: 0, p: 0, d: 0, km: 0 };
    filas.forEach(r => { const p = fila(r.user_id); p.dias++; p.t += r.minutos_trabajo; p.p += r.minutos_pausa; p.d += r.minutos_desplazamiento; p.km += Number(r.km_linea_recta) || 0; });
    // quien tenía que trabajar y no ha fichado también sale, con 0 horas
    if (conHorario) miembros.filter(m => m.activo && (!persona.value || m.user_id === persona.value) && previstoDe(m.user_id, desde.value, hasta.value) > 0).forEach(m => fila(m.user_id));
    const dif = (t, prev) => h('td', { class: t - prev < 0 ? 'falta' : '' }, fmtDiferencia(t - prev));
    montar(tabla,
      Object.keys(porPersona).length ? h('table.tabla',
        h('thead', h('tr', h('th', 'Persona'), h('th', 'Días'), h('th', 'Trabajo'), conHorario ? [h('th', 'Previsto'), h('th', 'Diferencia')] : null, h('th', 'Pausas'), h('th', 'Desplaz.'), h('th', 'Km'))),
        h('tbody', Object.entries(porPersona).map(([u, p]) => { const prev = previstoDe(u, desde.value, hasta.value); return h('tr', h('td', nombre(u)), h('td', p.dias), h('td', fmtMin(p.t)),
          conHorario ? [h('td', fmtMin(prev)), dif(p.t, prev)] : null,
          h('td', fmtMin(p.p)), h('td', fmtMin(p.d)), h('td', p.km.toLocaleString('es-ES', { maximumFractionDigits: 1 }))); }))) : h('p.vacio', 'Sin registros en ese periodo.'),
      filas.length ? h('details', h('summary', 'Ver por días'), h('table.tabla',
        h('thead', h('tr', h('th', 'Día'), h('th', 'Persona'), h('th', 'Entrada'), h('th', 'Salida'), h('th', 'Trabajo'), conHorario ? h('th', 'Previsto') : null)),
        h('tbody', filas.map(r => h('tr', h('td', fecha(r.dia)), h('td', r.nombre || nombre(r.user_id)), h('td', hora(r.primera_entrada, app.tz)), h('td', r.abierta ? 'abierta' : hora(r.ultima_salida, app.tz)), h('td', fmtMin(r.minutos_trabajo), r.correcciones ? ' *' : ''),
          conHorario ? h('td', fmtMin(previstoEnDia(r))) : null))))) : null);
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
        ...(conHorario ? { 'Horas previstas': Math.round(previstoEnDia(r) / 6) / 10 } : {}),
      })), ['Persona', 'NIF', 'Fecha', 'Entrada', 'Salida', 'Horas trabajo', ...(conHorario ? ['Horas previstas'] : []), 'Minutos pausa', 'Minutos desplazamiento', 'Km línea recta', 'Correcciones']);
      descargar(`registro-jornada_${desde.value}_${hasta.value}.csv`, csv);
      await api.registrarExportacion(app.org, 'MANUAL_CSV', `${desde.value}..${hasta.value}`).catch(() => { });
    }),
  }, 'Descargar registro (CSV)');

  // ---------- firmas del registro ----------
  const mesFirma = h('select', { 'aria-label': 'Mes' }, mesesCerrados(hoy, 12).map(p => h('option', { value: p }, nombreMes(p))));
  const tablaFirmas = h('div');
  const cargarFirmas = async () => {
    const filas = await api.estadoFirmas(app.org, mesFirma.value);
    montar(tablaFirmas, filas.length ? h('div.lista', filas.map(r => h('div.item',
        h('div', h('strong', r.nombre || nombre(r.user_id)),
          h('small', `${r.dias} ${r.dias === 1 ? 'día' : 'días'} · ${fmtMin(r.minutos)} · `,
            r.vigente ? h('span.ok-firma', `✓ firmado el ${new Date(r.firmado_en).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: app.tz })} con ${METODOS[r.metodo]}`)
              : r.firma_id ? h('span.aviso-firma', 'cambió después de firmar') : 'pendiente de firmar')),
        r.firma_id ? h('div.fila-botones',
          h('button.btn.mini', { title: 'Documento firmado y datos de la firma', onclick: e => accion(e.currentTarget, () => descargarFirma(r.firma_id, r.nombre || nombre(r.user_id), { tz: app.tz })) }, 'Justificante'),
          h('button.btn.mini', { title: 'Abrir el justificante para imprimirlo o guardarlo en PDF', onclick: e => accion(e.currentTarget, () => descargarFirma(r.firma_id, r.nombre || nombre(r.user_id), { tz: app.tz, imprimir: true })) }, 'Imprimir'),
          r.metodo === 'CERTIFICADO' ? h('button.btn.mini', { title: 'Firma electrónica CAdES', onclick: e => accion(e.currentTarget, () => descargarFirma(r.firma_id, r.nombre || nombre(r.user_id), { cms: true })) }, '.csig') : null) : null)))
      : h('p.vacio', 'Nadie tiene jornadas en ese mes.'));
  };
  mesFirma.addEventListener('change', () => accion(null, cargarFirmas));
  await cargarFirmas();
  const firmas = h('div.tarjeta', h('h2', 'Firmas del registro'),
    h('p.ayuda', 'Cada persona firma su registro de cada mes desde la app: con un código por correo o SMS, o con su certificado digital. Si después se aprueba una corrección de ese mes, la firma deja de valer y se le pide que vuelva a firmar.'),
    h('div.filtros', mesFirma), tablaFirmas);

  return h('section.pila',
    h('h1', 'Equipo'),
    correcciones, ahora, fichajesEquipo, firmas,
    h('div.tarjeta', h('h2', 'Registro de jornada'),
      h('div.filtros', desde, hasta, persona, exportar), tabla,
      h('p.ayuda', 'Una fila por persona y día: entrada, salida, pausas y desplazamientos. Los horarios por cliente y proyecto se descargan en ', h('a', { href: '#/tiempos' }, 'Tiempos'), '.'),
      conHorario ? h('p.ayuda', 'Previsto: lo que marca el horario de trabajo de cada persona, hasta hoy. Se cambia en ', h('a', { href: '#/ajustes/horario' }, 'Ajustes'), '.')
        : h('p.ayuda', 'Pon un horario de trabajo en ', h('a', { href: '#/ajustes/horario' }, 'Ajustes'), ' para ver las horas previstas junto a las trabajadas.'),
      h('p.ayuda', '* Incluye correcciones aprobadas. El registro se conserva 4 años y no se puede borrar ni modificar.')),
    h('p.ayuda', 'Roles: ', Object.values(ROLES).join(' · '), '. Gestiona usuarios en Ajustes.'));
}
