import { api } from '../api.js';
import { h, accion, aviso, dialogo, hora, fecha, hoyISO, sumarDias, posicion, preferencia } from '../ui.js';
import { estadoActual, accionesPosibles, tramos, totales, fmtMin, fmtReloj, diaLocal, TIPOS } from '../lib/jornada.js';
import { navegarUrl, tieneDestino, direccionCompleta } from '../lib/mapas.js';
import { editar as editarCliente } from './clientes.js';

const puedeCrearClientes = rol => ['propietario', 'admin', 'responsable'].includes(rol);

// GPS: se reutiliza una posición reciente para que fichar sea instantáneo
let ultimaPos = null, vigilando = false;
function vigilarGPS() {
  if (vigilando || !navigator.geolocation) return; vigilando = true;
  navigator.geolocation.watchPosition(p => { ultimaPos = { lat: p.coords.latitude, lng: p.coords.longitude, precision: Math.round(p.coords.accuracy), t: Date.now() }; },
    () => { vigilando = false; }, { enableHighAccuracy: true, maximumAge: 60000 });
}
async function gps(app) {
  if (app.e.config?.jornada_geolocalizar === false) return {};
  if (ultimaPos && Date.now() - ultimaPos.t < 120000) return ultimaPos;
  const p = await posicion(5000);
  if (p) { ultimaPos = { ...p, t: Date.now() }; vigilarGPS(); }
  return p || {};
}

let reloj;
let diaVista = null;   // día que se muestra en la línea de tiempo (null = hoy)

export async function vistaJornada(app) {
  clearInterval(reloj);
  const hoy = hoyISO(app.tz);
  const dia = diaVista && diaVista < hoy ? diaVista : hoy;
  const [clientes, fichajes, semana, fichajesDia] = await Promise.all([
    api.clientes(app.org),
    api.fichajes(app.org, { desde: sumarDias(hoy, -1), hasta: hoy, user: app.e.user_id }),
    api.resumen(app.org, sumarDias(hoy, -6), hoy, app.e.user_id).catch(() => []),
    dia === hoy ? null : api.fichajes(app.org, { desde: dia, hasta: dia, user: app.e.user_id }),
  ]);
  const cli = id => clientes.find(c => c.id === id);
  const st = estadoActual(fichajes);
  const deHoy = fichajes.filter(f => diaLocal(Date.parse(f.momento_declarado || f.momento), app.tz) === hoy);
  const acciones = accionesPosibles(st);

  const raiz = h('section.pila');
  // Tiempo trabajado hoy en ms (el tramo abierto cuenta hasta ahora)
  const msTrabajo = () => tramos(deHoy).filter(t => t.tipo === 'TRABAJO').reduce((s, t) => s + ((t.fin ?? Date.now()) - t.inicio), 0);

  // ---------- tarjeta de estado ----------
  const etiquetas = { FUERA: 'Fuera de jornada', TRABAJANDO: 'Trabajando', PAUSA: 'En pausa' };
  const relojEl = h('div.reloj', fmtReloj(msTrabajo()));
  if (st.estado === 'TRABAJANDO') {
    reloj = setInterval(() => { if (!document.body.contains(relojEl)) return clearInterval(reloj); relojEl.textContent = fmtReloj(msTrabajo()); }, 1000);
  }

  const destinoActual = st.desplazamiento ? cli(st.desplazamiento.cliente_id) : null;
  const tarjeta = h('div.tarjeta.estado.' + st.estado.toLowerCase(),
    h('div.estado-cab', h('span.punto'), h('strong', etiquetas[st.estado]), st.desde ? h('span.ayuda', ' desde ' + hora(st.desde, app.tz)) : null),
    relojEl,
    h('div.ayuda', 'trabajado hoy'),
    st.estado !== 'FUERA' && !st.desplazamiento ? h('div.cliente-actual', 'Cliente: ', st.cliente_id ? h('strong', cli(st.cliente_id)?.nombre || '—') : h('span.ayuda', 'sin asignar')) : null,
    st.desplazamiento ? h('div.desplazamiento',
      h('div', '🚗 De camino a ', h('strong', destinoActual?.nombre || 'destino sin indicar'), h('span.ayuda', ' · desde ' + hora(st.desplazamiento.desde, app.tz))),
      destinoActual && tieneDestino(destinoActual) ? h('div.fila-botones',
        h('a.btn', { href: navegarUrl(destinoActual, 'waze'), target: '_blank', rel: 'noopener' }, 'Abrir Waze'),
        h('a.btn', { href: navegarUrl(destinoActual, 'maps'), target: '_blank', rel: 'noopener' }, 'Abrir Maps')) : null) : null,
    h('div.botones-fichar', acciones.map(tipo => botonFichar(app, tipo, clientes, st))));

  // ---------- línea de tiempo del día (hoy o uno anterior) ----------
  const delDia = (fichajesDia || fichajes).filter(f => diaLocal(Date.parse(f.momento_declarado || f.momento), app.tz) === dia);
  const trs = tramos(delDia, dia === hoy ? Date.now() : null);
  const tot = totales(trs);
  const irA = d => { diaVista = d; window.dispatchEvent(new HashChangeEvent('hashchange')); };
  const lineaTiempo = h('div.tarjeta',
    h('div.cab',
      h('h2', dia === hoy ? 'Hoy' : fecha(dia)),
      h('div.nav-dia',
        h('button.btn.mini', { type: 'button', 'aria-label': 'Día anterior', onclick: () => irA(sumarDias(dia, -1)) }, '‹'),
        dia !== hoy ? h('button.btn.mini', { type: 'button', onclick: () => irA(null) }, 'Hoy') : null,
        h('button.btn.mini', { type: 'button', 'aria-label': 'Día siguiente', disabled: dia === hoy, onclick: () => irA(sumarDias(dia, 1)) }, '›'))),
    trs.length ? h('ol.linea-tiempo', trs.map(t => h('li.' + t.tipo.toLowerCase(),
      h('span.horas', hora(t.inicio, app.tz) + ' – ' + (t.fin ? hora(t.fin, app.tz) : 'ahora')),
      h('span.que', t.tipo === 'TRABAJO' ? (cli(t.cliente_id)?.nombre || 'Sin cliente') : t.tipo === 'PAUSA' ? 'Pausa' : '🚗 Hacia ' + (cli(t.cliente_id)?.nombre || 'destino'),
        t.tipo === 'TRABAJO' ? h('button.btn.enlace.asignar', { type: 'button', onclick: e => asignarTramo(app, clientes, t, e.currentTarget) },
          t.cliente_id ? 'Cambiar cliente' : 'Asignar cliente') : null),
      h('span.dur', fmtMin(t.minutos) + (t.km ? ` · ${t.km.toLocaleString('es-ES')} km` : ''))))) : h('p.vacio', dia === hoy ? 'Todavía no has fichado hoy.' : 'Sin fichajes este día.'),
    trs.length ? h('div.totales',
      h('div', h('small', 'Trabajo'), h('strong', fmtMin(tot.trabajo))),
      h('div', h('small', 'Pausas'), h('strong', fmtMin(tot.pausa))),
      h('div', h('small', 'Desplazamientos'), h('strong', fmtMin(tot.desplazamiento)))) : null,
    delDia.filter(f => f.origen && f.origen !== 'APP' && (f.tipo !== 'CAMBIO_CLIENTE' || f.estado === 'PENDIENTE')).map(f => h('div.ayuda.correccion',
      f.tipo === 'CAMBIO_CLIENTE' ? `Asignación pendiente de aprobar: ${cli(f.cliente_id)?.nombre || 'cliente'} desde las ${hora(f.momento_declarado, app.tz)}`
        : `Corrección ${f.estado?.toLowerCase()}: ${TIPOS[f.tipo]} a las ${hora(f.momento_declarado, app.tz)} — ${f.motivo}`)),
    h('button.btn.enlace', { onclick: () => correccion(app) }, '¿Te olvidaste de fichar? Solicitar corrección'));

  // ---------- semana ----------
  const horasDia = Number(app.e.config?.jornada_horas_dia) || 8;
  const semanaEl = h('div.tarjeta',
    h('h2', 'Últimos 7 días'),
    semana.length ? h('table.tabla',
      h('thead', h('tr', h('th', 'Día'), h('th', 'Entrada'), h('th', 'Trabajo'), h('th', 'Desplaz.'))),
      h('tbody', semana.slice().reverse().map(r => h('tr.enlace', { title: 'Ver el día', onclick: () => irA(r.dia) },
        h('td', fecha(r.dia)), h('td', hora(r.primera_entrada, app.tz)),
        h('td', { class: r.minutos_trabajo > horasDia * 60 ? 'exceso' : '' }, fmtMin(r.minutos_trabajo), r.abierta ? ' ⏱' : ''),
        h('td', fmtMin(r.minutos_desplazamiento)))))) : h('p.vacio', 'Sin registros esta semana.'),
    semana.length ? h('p.ayuda', 'Total semana: ', h('strong', fmtMin(semana.reduce((s, r) => s + r.minutos_trabajo, 0)))) : null);

  raiz.append(tarjeta, lineaTiempo, semanaEl);
  return raiz;
}

function botonFichar(app, tipo, clientes, st) {
  const sinCliente = !st.cliente_id;
  const textos = {
    ENTRADA: ['Iniciar jornada', 'primario'], PAUSA: ['Pausa', ''], REANUDAR: ['Reanudar', 'primario'], SALIDA: ['Finalizar jornada', 'peligro'],
    DESPLAZAMIENTO_INICIO: ['🚗 Salir hacia un cliente', ''], DESPLAZAMIENTO_FIN: ['📍 He llegado', 'primario'], CAMBIO_CLIENTE: sinCliente ? ['Elegir cliente', 'primario'] : ['Cambiar de cliente', 'enlace'],
  };
  const [txt, clase] = textos[tipo];
  return h('button.btn' + (clase ? '.' + clase : ''), {
    type: 'button', 'data-tipo': tipo,
    onclick: async e => {
      const btn = e.currentTarget;
      let cliente_id = null;
      if (tipo === 'ENTRADA' || tipo === 'CAMBIO_CLIENTE' || tipo === 'DESPLAZAMIENTO_INICIO') {
        const r = await elegirCliente(app, clientes, tipo);
        if (r === null) return;
        cliente_id = r.cliente_id;
        if (tipo === 'CAMBIO_CLIENTE' && !cliente_id) return aviso('Elige un cliente', 'error');
      }
      if (tipo === 'SALIDA' && !confirm('¿Finalizar la jornada de hoy?')) return;
      await accion(btn, async () => {
        const pos = await gps(app);
        await api.fichar(app.org, tipo, { ...pos, cliente_id });
        if (tipo === 'DESPLAZAMIENTO_FIN' && st.desplazamiento?.cliente_id && pos.lat) ofrecerGuardarUbicacion(clientes.find(c => c.id === st.desplazamiento.cliente_id), pos);
        aviso({ ENTRADA: 'Jornada iniciada', PAUSA: 'Pausa registrada', REANUDAR: 'De vuelta al trabajo', SALIDA: 'Jornada finalizada', DESPLAZAMIENTO_INICIO: 'Desplazamiento iniciado', DESPLAZAMIENTO_FIN: 'Llegada registrada', CAMBIO_CLIENTE: 'Cliente cambiado' }[tipo], 'ok');
        location.hash === '#/' || location.hash === '' ? window.dispatchEvent(new HashChangeEvent('hashchange')) : (location.hash = '#/');
      });
    },
  }, txt);
}

/** Selector de cliente con búsqueda. Devuelve {cliente_id} o null si se cancela. */
async function elegirCliente(app, clientes, tipo, titulo) {
  const buscar = h('input', { type: 'search', placeholder: 'Buscar cliente…', 'aria-label': 'Buscar cliente' });
  let elegido = null;
  const navPref = preferencia('nav') || 'waze';
  const abrirNav = h('select', { 'aria-label': 'Abrir navegación' },
    h('option', { value: 'waze', selected: navPref === 'waze' }, 'y abrir Waze'),
    h('option', { value: 'maps', selected: navPref === 'maps' }, 'y abrir Google Maps'),
    h('option', { value: 'no', selected: navPref === 'no' }, 'sin abrir navegación'));
  const lista = h('div.lista-clientes');
  const puedeCrear = puedeCrearClientes(app.rol);
  const pintar = () => {
    const q = buscar.value.toLowerCase();
    const activos = clientes.filter(c => c.activo !== false);
    const r = activos.filter(c => (c.nombre + ' ' + (c.localidad || '') + ' ' + (c.municipio || '')).toLowerCase().includes(q)).slice(0, 50);
    lista.replaceChildren(...(r.length ? r.map(c => h('label.opcion', h('input', { type: 'radio', name: 'cli', value: c.id, checked: elegido === c.id, onchange: () => { elegido = c.id; } }),
        h('span', h('strong', c.nombre), h('small', direccionCompleta(c) || 'sin dirección'))))
      : [h('p.vacio', activos.length ? 'Ningún cliente coincide con la búsqueda.'
          : puedeCrear ? 'Aún no hay clientes. Crea el primero aquí abajo.' : 'Aún no hay clientes. Pide a tu responsable que los dé de alta.')]));
  };
  // Alta rápida sin salir del fichaje: el cliente nuevo queda elegido
  const nuevo = puedeCrear ? h('button.btn.enlace', { type: 'button', onclick: async () => {
    const c = await editarCliente(app, { nombre: buscar.value.trim() }, { recargar: false });
    if (!c) return;
    clientes.push(c); clientes.sort((a, b) => a.nombre.localeCompare(b.nombre));
    elegido = c.id; buscar.value = ''; pintar();
  } }, '+ Nuevo cliente') : null;
  buscar.addEventListener('input', pintar); pintar();
  const titulos = { ENTRADA: '¿Para qué cliente empiezas?', CAMBIO_CLIENTE: '¿Para qué cliente trabajas ahora?', DESPLAZAMIENTO_INICIO: '¿A dónde vas?' };
  const ok = await dialogo(titulo || titulos[tipo], [buscar, lista, nuevo, tipo === 'DESPLAZAMIENTO_INICIO' ? abrirNav : null], [
    { texto: 'Cancelar', valor: false },
    tipo === 'ENTRADA' ? { texto: 'Sin cliente', valor: 'sin' } : null,
    { texto: tipo === 'DESPLAZAMIENTO_INICIO' ? 'Salir' : 'Aceptar', clase: 'primario', valor: () => {
      if (!elegido && tipo !== 'DESPLAZAMIENTO_INICIO') { aviso(tipo === 'ENTRADA' ? 'Elige un cliente o pulsa «Sin cliente»' : 'Elige un cliente', 'error'); return undefined; }
      if (tipo === 'DESPLAZAMIENTO_INICIO') {
        // Se abre aquí, dentro del toque, para que el navegador no bloquee la ventana
        preferencia('nav', abrirNav.value);
        const c = clientes.find(x => x.id === elegido);
        if (c && abrirNav.value !== 'no' && tieneDestino(c)) window.open(navegarUrl(c, abrirNav.value), '_blank', 'noopener');
      }
      return 'ok';
    } },
  ].filter(Boolean));
  if (!ok) return null;
  if (ok === 'sin') return { cliente_id: null };
  return { cliente_id: elegido };
}

/** Asigna (o cambia) el cliente de un tramo de trabajo ya fichado, desde su inicio. */
async function asignarTramo(app, clientes, t, btn) {
  const desde = hora(t.inicio, app.tz), hasta = t.fin ? hora(t.fin, app.tz) : 'ahora';
  const r = await elegirCliente(app, clientes, 'ASIGNAR', `¿Para qué cliente fue el trabajo de ${desde} a ${hasta}?`);
  if (!r?.cliente_id || r.cliente_id === t.cliente_id) return;
  const res = await accion(btn, () => api.asignarCliente(app.org, new Date(t.inicio).toISOString(), r.cliente_id));
  if (!res) return;
  aviso(res?.estado === 'PENDIENTE' ? 'Asignación enviada; la aprobará tu responsable' : 'Cliente asignado', 'ok');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

async function ofrecerGuardarUbicacion(c, pos) {
  if (!c || (c.lat && c.lng)) return;
  const si = await dialogo('¿Guardar la ubicación?', h('p', `${c.nombre} no tiene ubicación GPS. ¿Guardamos este punto para que Waze/Maps lleven justo aquí la próxima vez?`),
    [{ texto: 'No', valor: false }, { texto: 'Guardar', clase: 'primario', valor: true }]);
  if (si) accion(null, async () => { await api.fijarUbicacion(c.id, pos.lat, pos.lng); aviso('Ubicación guardada', 'ok'); });
}

async function correccion(app) {
  const tipo = h('select', { id: 'c-tipo' }, ['SALIDA', 'ENTRADA', 'PAUSA', 'REANUDAR'].map(t => h('option', { value: t }, TIPOS[t])));
  const cuando = h('input', { type: 'datetime-local', id: 'c-cuando', required: true, max: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) });
  const motivo = h('textarea', { id: 'c-motivo', rows: 2, placeholder: 'Ej.: olvidé fichar la salida' });
  await dialogo('Solicitar corrección', [
    h('p.ayuda', 'El registro original no se modifica. Tu responsable revisará la corrección.'),
    h('label', { for: 'c-tipo' }, 'Qué'), tipo, h('label', { for: 'c-cuando' }, 'Cuándo'), cuando, h('label', { for: 'c-motivo' }, 'Motivo'), motivo,
  ], [{ texto: 'Cancelar', valor: false }, {
    texto: 'Enviar', clase: 'primario', valor: async () => {
      if (!cuando.value || !motivo.value.trim()) { aviso('Indica cuándo y el motivo', 'error'); return undefined; }
      const r = await accion(null, async () => { await api.solicitarCorreccion(app.org, tipo.value, new Date(cuando.value).toISOString(), motivo.value.trim()); return true; });
      if (r) { aviso('Corrección enviada', 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange')); return true; }
      return undefined;
    },
  }]);
}
