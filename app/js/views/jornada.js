import { api } from '../api.js';
import { h, accion, aviso, dialogo, hora, fecha, hoyISO, sumarDias, posicion, preferencia } from '../ui.js';
import { estadoActual, accionesPosibles, tramos, totales, fmtMin, fmtReloj, diaLocal, TIPOS, momentoLocal, cambiosParaParte, notaDeTramo, resumenNota, instante } from '../lib/jornada.js';
import { navegarUrl, tieneDestino, direccionCompleta } from '../lib/mapas.js';
import { editar as editarCliente } from './clientes.js';
import { editar as editarProyecto } from './proyectos.js';

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
  const [clientes, proyectos, fichajes, semana, fichajesDia, notas, productos] = await Promise.all([
    api.clientes(app.org),
    api.proyectos(app.org).catch(() => []),
    api.fichajes(app.org, { desde: sumarDias(hoy, -1), hasta: hoy, user: app.e.user_id }),
    api.resumen(app.org, sumarDias(hoy, -6), hoy, app.e.user_id).catch(() => []),
    dia === hoy ? null : api.fichajes(app.org, { desde: dia, hasta: dia, user: app.e.user_id }),
    api.notasTramo(app.org, dia, dia, app.e.user_id).catch(() => []),
    api.productos(app.org).catch(() => []),   // solo quien ve facturación; si no, materiales a mano
  ]);
  const cli = id => clientes.find(c => c.id === id);
  const pro = id => proyectos.find(p => p.id === id);
  // Qué se está haciendo en un tramo: «Proyecto · Cliente», o solo uno de los dos
  const enQue = (cId, pId) => [pro(pId) && '📁 ' + pro(pId).nombre, cli(cId)?.nombre].filter(Boolean).join(' · ');
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
    st.estado !== 'FUERA' && !st.desplazamiento ? h('div.cliente-actual', 'En: ', st.cliente_id || st.proyecto_id ? h('strong', enQue(st.cliente_id, st.proyecto_id) || '—') : h('span.ayuda', 'sin asignar')) : null,
    st.desplazamiento ? h('div.desplazamiento',
      h('div', '🚗 De camino a ', h('strong', destinoActual?.nombre || 'destino sin indicar'), h('span.ayuda', ' · desde ' + hora(st.desplazamiento.desde, app.tz))),
      destinoActual && tieneDestino(destinoActual) ? h('div.fila-botones',
        h('a.btn', { href: navegarUrl(destinoActual, 'waze'), target: '_blank', rel: 'noopener' }, 'Abrir Waze'),
        h('a.btn', { href: navegarUrl(destinoActual, 'maps'), target: '_blank', rel: 'noopener' }, 'Abrir Maps')) : null) : null,
    h('div.botones-fichar', acciones.map(tipo => botonFichar(app, tipo, clientes, proyectos, st))));

  // ---------- línea de tiempo del día (hoy o uno anterior) ----------
  const delDia = (fichajesDia || fichajes).filter(f => diaLocal(Date.parse(f.momento_declarado || f.momento), app.tz) === dia);
  const trs = tramos(delDia, dia === hoy ? Date.now() : null).map(t => ({ ...t, user_id: app.e.user_id, dia }));
  const recargar = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
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
      h('span.que', t.tipo === 'TRABAJO' ? (enQue(t.cliente_id, t.proyecto_id) || 'Sin asignar') : t.tipo === 'PAUSA' ? 'Pausa' : '🚗 Hacia ' + (cli(t.cliente_id)?.nombre || 'destino'),
        t.tipo === 'TRABAJO' ? h('button.btn.enlace.asignar', { type: 'button', onclick: async e => { if (await asignarTramo(app, clientes, proyectos, t, e.currentTarget)) recargar(); } },
          t.cliente_id || t.proyecto_id ? 'Cambiar' : 'Asignar cliente o proyecto') : null,
        t.tipo === 'TRABAJO' ? h('button.btn.enlace.asignar', { type: 'button', onclick: async () => { if (await editarNotaTramo(app, t, notaDeTramo(notas, t), productos)) recargar(); } },
          notaDeTramo(notas, t) ? '📝 Nota' : '📝 Añadir nota') : null,
        t.tipo === 'TRABAJO' && notaDeTramo(notas, t) ? h('small.nota-tramo', resumenNota(notaDeTramo(notas, t))) : null),
      h('span.dur', fmtMin(t.minutos) + (t.km ? ` · ${t.km.toLocaleString('es-ES')} km` : ''))))) : h('p.vacio', dia === hoy ? 'Todavía no has fichado hoy.' : 'Sin fichajes este día.'),
    trs.length ? h('div.totales',
      h('div', h('small', 'Trabajo'), h('strong', fmtMin(tot.trabajo))),
      h('div', h('small', 'Pausas'), h('strong', fmtMin(tot.pausa))),
      h('div', h('small', 'Desplazamientos'), h('strong', fmtMin(tot.desplazamiento)))) : null,
    delDia.filter(f => f.anulado).map(f => h('div.ayuda.correccion', `Marcado como error: ${TIPOS[f.tipo]} de las ${hora(f.momento_declarado || f.momento, app.tz)} — ${f.anulado.motivo}`)),
    delDia.filter(f => !f.anulado && f.origen && f.origen !== 'APP' && (f.tipo !== 'CAMBIO_CLIENTE' || f.estado === 'PENDIENTE')).map(f => h('div.ayuda.correccion',
      f.tipo === 'CAMBIO_CLIENTE' ? `Asignación pendiente de aprobar: ${enQue(f.cliente_id, f.proyecto_id) || 'cliente'} desde las ${hora(f.momento_declarado, app.tz)}`
        : `Corrección ${f.estado?.toLowerCase()}: ${TIPOS[f.tipo]} a las ${hora(f.momento_declarado, app.tz)} — ${f.motivo}`)),
    h('button.btn.enlace', { onclick: () => correccion(app) }, '¿Te olvidaste de fichar? Solicitar corrección'),
    puedeCrearClientes(app.rol) && delDia.some(f => !f.anulado) ? h('button.btn.enlace', { onclick: () => marcarErrores(app, delDia, { clientes, proyectos }) }, 'Marcar fichajes de este día como error') : null);

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
  if (app.nfc) { const etiqueta = app.nfc; app.nfc = null; queueMicrotask(() => preguntarNfc(raiz, st, etiqueta)); }
  return raiz;
}

// Etiqueta NFC (p. ej. en el soporte del coche): al acercar el móvil se abre la app con ?nfc=… y pregunta qué fichar.
// Las opciones son los mismos botones de la tarjeta de estado; elegir una es como pulsarlo.
async function preguntarNfc(raiz, st, etiqueta) {
  const botones = [...raiz.querySelectorAll('.botones-fichar button[data-tipo]')]
    .sort((a, b) => (b.dataset.tipo === 'SALIDA') - (a.dataset.tipo === 'SALIDA'));
  if (!botones.length) return;
  const titulo = st.estado === 'FUERA' ? '¿Empiezas la jornada?' : st.desplazamiento ? '¿Has llegado?' : '¿Has terminado?';
  const tipo = await dialogo(titulo, h('p.ayuda', `Etiqueta «${etiqueta}». Elige qué quieres fichar.`),
    [...botones.map(b => ({ texto: b.textContent, valor: b.dataset.tipo, clase: b.dataset.tipo === botones[0].dataset.tipo ? 'primario' : '' })),
      { texto: st.estado === 'FUERA' ? 'Ahora no' : 'Sigo trabajando', valor: null }]);
  const btn = tipo && raiz.querySelector(`.botones-fichar button[data-tipo="${tipo}"]`);
  if (!btn) return;
  if (tipo === 'SALIDA') btn.dataset.confirmado = '1';   // ya lo ha confirmado en el diálogo
  btn.click();
}

function botonFichar(app, tipo, clientes, proyectos, st) {
  const sinCliente = !st.cliente_id && !st.proyecto_id;
  const textos = {
    ENTRADA: ['Iniciar jornada', 'primario'], PAUSA: ['Pausa', ''], REANUDAR: ['Reanudar', 'primario'], SALIDA: ['Finalizar jornada', 'peligro'],
    DESPLAZAMIENTO_INICIO: ['🚗 Salir hacia un cliente', ''], DESPLAZAMIENTO_FIN: ['📍 He llegado', 'primario'], CAMBIO_CLIENTE: sinCliente ? ['Elegir cliente o proyecto', 'primario'] : ['Cambiar de cliente o proyecto', 'enlace'],
  };
  const [txt, clase] = textos[tipo];
  return h('button.btn' + (clase ? '.' + clase : ''), {
    type: 'button', 'data-tipo': tipo,
    onclick: async e => {
      const btn = e.currentTarget;
      let cliente_id = null, proyecto_id = null;
      if (tipo === 'ENTRADA' || tipo === 'CAMBIO_CLIENTE' || tipo === 'DESPLAZAMIENTO_INICIO') {
        const r = await elegirCliente(app, clientes, tipo, { proyectos: tipo === 'DESPLAZAMIENTO_INICIO' ? null : proyectos });
        if (r === null) return;
        ({ cliente_id, proyecto_id } = r);
        if (tipo === 'CAMBIO_CLIENTE' && !cliente_id && !proyecto_id) return aviso('Elige un cliente o un proyecto', 'error');
      }
      if (tipo === 'SALIDA' && !btn.dataset.confirmado && !confirm('¿Finalizar la jornada de hoy?')) return;
      delete btn.dataset.confirmado;
      await accion(btn, async () => {
        const pos = await gps(app);
        await api.fichar(app.org, tipo, { ...pos, cliente_id, proyecto_id });
        if (tipo === 'DESPLAZAMIENTO_FIN' && st.desplazamiento?.cliente_id && pos.lat) ofrecerGuardarUbicacion(clientes.find(c => c.id === st.desplazamiento.cliente_id), pos);
        aviso({ ENTRADA: 'Jornada iniciada', PAUSA: 'Pausa registrada', REANUDAR: 'De vuelta al trabajo', SALIDA: 'Jornada finalizada', DESPLAZAMIENTO_INICIO: 'Desplazamiento iniciado', DESPLAZAMIENTO_FIN: 'Llegada registrada', CAMBIO_CLIENTE: 'Cambio registrado' }[tipo], 'ok');
        location.hash === '#/' || location.hash === '' ? window.dispatchEvent(new HashChangeEvent('hashchange')) : (location.hash = '#/');
      });
    },
  }, txt);
}

/**
 * Selector de cliente (y de proyecto, si se pasan proyectos) con búsqueda.
 * Devuelve {cliente_id, proyecto_id} o null si se cancela.
 */
export async function elegirCliente(app, clientes, tipo, { titulo, proyectos = null, extra = null } = {}) {
  const conProyectos = !!proyectos;
  const buscar = h('input', { type: 'search', placeholder: conProyectos ? 'Buscar proyecto o cliente…' : 'Buscar cliente…', 'aria-label': 'Buscar' });
  let elegido = null;   // 'c:<id>' o 'p:<id>'
  const navPref = preferencia('nav') || 'waze';
  const abrirNav = h('select', { 'aria-label': 'Abrir navegación' },
    h('option', { value: 'waze', selected: navPref === 'waze' }, 'y abrir Waze'),
    h('option', { value: 'maps', selected: navPref === 'maps' }, 'y abrir Google Maps'),
    h('option', { value: 'no', selected: navPref === 'no' }, 'sin abrir navegación'));
  const lista = h('div.lista-clientes');
  const puedeCrear = puedeCrearClientes(app.rol);
  const nombreCli = id => clientes.find(c => c.id === id)?.nombre;
  const opcion = (clave, titulo, detalle) => h('label.opcion',
    h('input', { type: 'radio', name: 'cli', value: clave, checked: elegido === clave, onchange: () => { elegido = clave; } }),
    h('span', h('strong', titulo), h('small', detalle)));
  const pintar = () => {
    const q = buscar.value.toLowerCase();
    const activos = clientes.filter(c => c.activo !== false);
    const pros = conProyectos ? proyectos.filter(p => p.activo !== false && (p.nombre + ' ' + (nombreCli(p.cliente_id) || '')).toLowerCase().includes(q)).slice(0, 30) : [];
    const clis = activos.filter(c => (c.nombre + ' ' + (c.localidad || '') + ' ' + (c.municipio || '')).toLowerCase().includes(q)).slice(0, 50);
    const vacio = !activos.length && !(proyectos || []).some(p => p.activo !== false);
    lista.replaceChildren(...(pros.length || clis.length ? [
      pros.length ? h('small.grupo', 'Proyectos') : '',
      ...pros.map(p => opcion('p:' + p.id, '📁 ' + p.nombre, nombreCli(p.cliente_id) || (p.tipo === 'AJENO' ? 'Proyecto ajeno' : 'Proyecto propio'))),
      pros.length && clis.length ? h('small.grupo', 'Clientes') : '',
      ...clis.map(c => opcion('c:' + c.id, c.nombre, direccionCompleta(c) || 'sin dirección')),
    ] : [h('p.vacio', !vacio ? 'Nada coincide con la búsqueda.'
          : puedeCrear ? 'Aún no hay clientes. Crea el primero aquí abajo.' : 'Aún no hay clientes. Pide a tu responsable que los dé de alta.')]));
  };
  // Alta rápida sin salir del fichaje: lo nuevo queda elegido
  const nuevoCli = puedeCrear ? h('button.btn.enlace', { type: 'button', onclick: async () => {
    const c = await editarCliente(app, { nombre: buscar.value.trim() }, { recargar: false });
    if (!c) return;
    clientes.push(c); clientes.sort((a, b) => a.nombre.localeCompare(b.nombre));
    elegido = 'c:' + c.id; buscar.value = ''; pintar();
  } }, '+ Nuevo cliente') : null;
  const nuevoPro = puedeCrear && conProyectos ? h('button.btn.enlace', { type: 'button', onclick: async () => {
    const p = await editarProyecto(app, { nombre: buscar.value.trim() }, clientes, { recargar: false });
    if (!p) return;
    proyectos.push(p); proyectos.sort((a, b) => a.nombre.localeCompare(b.nombre));
    elegido = 'p:' + p.id; buscar.value = ''; pintar();
  } }, '+ Nuevo proyecto') : null;
  buscar.addEventListener('input', pintar); pintar();
  const titulos = conProyectos
    ? { ENTRADA: '¿En qué empiezas?', CAMBIO_CLIENTE: '¿En qué trabajas ahora?' }
    : { ENTRADA: '¿Para qué cliente empiezas?', CAMBIO_CLIENTE: '¿Para qué cliente trabajas ahora?', DESPLAZAMIENTO_INICIO: '¿A dónde vas?' };
  const queElegir = conProyectos ? 'un proyecto o un cliente' : 'un cliente';
  const ok = await dialogo(titulo || titulos[tipo], [extra, buscar, lista, h('div.fila-botones', nuevoPro, nuevoCli), tipo === 'DESPLAZAMIENTO_INICIO' ? abrirNav : null], [
    { texto: 'Cancelar', valor: false },
    tipo === 'ENTRADA' ? { texto: conProyectos ? 'Sin asignar' : 'Sin cliente', valor: 'sin' } : null,
    { texto: tipo === 'DESPLAZAMIENTO_INICIO' ? 'Salir' : 'Aceptar', clase: 'primario', valor: () => {
      if (!elegido && tipo !== 'DESPLAZAMIENTO_INICIO') {
        aviso(tipo === 'ENTRADA' ? `Elige ${queElegir} o pulsa «${conProyectos ? 'Sin asignar' : 'Sin cliente'}»` : `Elige ${queElegir}`, 'error'); return undefined;
      }
      if (tipo === 'DESPLAZAMIENTO_INICIO') {
        // Se abre aquí, dentro del toque, para que el navegador no bloquee la ventana
        preferencia('nav', abrirNav.value);
        const c = clientes.find(x => 'c:' + x.id === elegido);
        if (c && abrirNav.value !== 'no' && tieneDestino(c)) window.open(navegarUrl(c, abrirNav.value), '_blank', 'noopener');
      }
      return 'ok';
    } },
  ].filter(Boolean));
  if (!ok) return null;
  if (ok === 'sin' || !elegido) return { cliente_id: null, proyecto_id: null };
  const [clase, id] = elegido.split(':');
  if (clase === 'p') return { cliente_id: proyectos.find(p => p.id === id)?.cliente_id || null, proyecto_id: id };
  return { cliente_id: id, proyecto_id: null };
}

/**
 * Asigna (o cambia) el cliente o proyecto de un tramo de trabajo ya fichado: entero o solo una parte (de tal hora a tal hora).
 * Las horas fichadas no cambian: se registran cambios de cliente a posteriori. Devuelve true si se asignó algo.
 * opciones: { user } para asignar el tramo de otra persona (responsables), { titulo } para el diálogo.
 */
export async function asignarTramo(app, clientes, proyectos, t, btn, { user = null, titulo = null } = {}) {
  const ini = instante(t.inicio), fin = t.fin ? instante(t.fin) : Date.now();
  const dia = t.dia || diaLocal(ini, app.tz);
  const hIni = hora(ini, app.tz), hFin = hora(fin, app.tz);
  const desde = h('input', { type: 'time', value: hIni, 'aria-label': 'Desde' });
  const hasta = h('input', { type: 'time', value: hFin, 'aria-label': 'Hasta' });
  const rango = h('div.rango-tramo',
    h('small.ayuda', 'Parte del tramo que asignas (por defecto, entero):'),
    h('div.fila-botones', h('label', 'De ', desde), h('label', ' a ', hasta)));
  const r = await elegirCliente(app, clientes, 'ASIGNAR', { proyectos, extra: rango,
    titulo: titulo || `¿En qué trabajaste de ${hIni} a ${t.fin ? hFin : 'ahora'}?` });
  if (!r || (!r.cliente_id && !r.proyecto_id)) return false;
  // Sin tocar las horas, se usa el instante exacto del tramo (los fichajes llevan segundos)
  const d = desde.value === hIni ? ini : momentoLocal(dia, desde.value, app.tz);
  const a = hasta.value === hFin ? fin : momentoLocal(dia, hasta.value, app.tz);
  const entero = d === ini && a === fin;
  if (entero && r.cliente_id === t.cliente_id && (r.proyecto_id || null) === (t.proyecto_id || null)) return false;
  const res = await accion(btn, async () => {
    const cambios = cambiosParaParte(t, d, a, r);
    let ultimo;
    for (const c of cambios) ultimo = await api.asignarCliente(app.org, new Date(c.momento).toISOString(), c.proyecto_id ? null : c.cliente_id, c.proyecto_id, user);
    return ultimo;
  });
  if (!res) return false;
  aviso(res?.estado === 'PENDIENTE' ? 'Asignación enviada; la aprobará tu responsable' : entero ? 'Asignado' : `Asignado de ${desde.value} a ${hasta.value}`, 'ok');
  return true;
}

/** Nota de un tramo de trabajo: tareas realizadas y materiales usados. Devuelve true si se guardó. */
export async function editarNotaTramo(app, t, nota, productos = []) {
  const texto = h('textarea', { rows: 3, placeholder: 'Qué se hizo: tareas, incidencias…', 'aria-label': 'Tareas realizadas' }, nota?.texto || '');
  texto.value = nota?.texto || '';
  const idLista = 'mat-productos';
  const sugerencias = h('datalist', { id: idLista }, productos.map(p => h('option', { value: p.descripcion || p.codigo }, p.codigo)));
  const filas = h('div.materiales');
  const fila = (m = {}) => {
    const desc = h('input', { list: idLista, value: m.descripcion || '', placeholder: 'Material', 'aria-label': 'Material' });
    const cant = h('input', { type: 'number', step: 'any', min: 0, value: m.cantidad ?? '', placeholder: 'Cant.', 'aria-label': 'Cantidad' });
    const ud = h('input', { value: m.unidad || '', placeholder: 'ud', 'aria-label': 'Unidad', maxLength: 10 });
    const el = h('div.material', desc, cant, ud, h('button.btn.mini', { type: 'button', 'aria-label': 'Quitar', onclick: () => el.remove() }, '✕'));
    // al elegir un producto del catálogo se pone su unidad
    desc.addEventListener('change', () => { const p = productos.find(x => (x.descripcion || x.codigo) === desc.value); if (p && !ud.value) ud.value = p.unidad || ''; });
    el.leer = () => {
      const p = productos.find(x => (x.descripcion || x.codigo) === desc.value.trim());
      return desc.value.trim() ? { descripcion: desc.value.trim(), cantidad: cant.value === '' ? null : Number(cant.value), unidad: ud.value.trim() || null, producto_id: p?.id || null } : null;
    };
    filas.append(el);
  };
  (nota?.materiales?.length ? nota.materiales : [{}]).forEach(fila);
  const desdeHasta = `${hora(t.inicio, app.tz)} – ${t.fin ? hora(t.fin, app.tz) : 'ahora'}`;
  const ok = await dialogo(`Nota del tramo ${desdeHasta}`, [
    h('label', 'Tareas realizadas'), texto,
    h('label', 'Materiales usados'), filas, sugerencias,
    h('button.btn.enlace', { type: 'button', onclick: () => fila() }, '+ Añadir material'),
  ], [
    { texto: 'Cancelar', valor: false },
    { texto: 'Guardar', clase: 'primario', valor: async () => {
      const materiales = [...filas.children].map(el => el.leer()).filter(Boolean);
      const r = await accion(null, async () => { await api.guardarNotaTramo(app.org, { user_id: t.user_id, inicio: new Date(t.inicio).toISOString(), texto: texto.value.trim(), materiales }); return true; });
      return r ? true : undefined;
    } },
  ]);
  if (ok) aviso('Nota guardada', 'ok');
  return !!ok;
}

async function ofrecerGuardarUbicacion(c, pos) {
  if (!c || (c.lat && c.lng)) return;
  const si = await dialogo('¿Guardar la ubicación?', h('p', `${c.nombre} no tiene ubicación GPS. ¿Guardamos este punto para que Waze/Maps lleven justo aquí la próxima vez?`),
    [{ texto: 'No', valor: false }, { texto: 'Guardar', clase: 'primario', valor: true }]);
  if (si) accion(null, async () => { await api.fijarUbicacion(c.id, pos.lat, pos.lng); aviso('Ubicación guardada', 'ok'); });
}

/**
 * Marca como error (anula) fichajes de un día: pruebas, duplicados... El original no se borra.
 * Solo propietario, admin y responsable. Devuelve true si se anuló algo.
 */
export async function marcarErrores(app, fichajes, { clientes = [], proyectos = [], persona = null } = {}) {
  const en = f => [proyectos.find(p => p.id === f.proyecto_id)?.nombre, clientes.find(c => c.id === f.cliente_id)?.nombre].filter(Boolean).join(' · ');
  const vivos = fichajes.filter(f => !f.anulado)
    .sort((a, b) => Date.parse(a.momento_declarado || a.momento) - Date.parse(b.momento_declarado || b.momento));
  const marcados = new Set();
  const lista = h('div.lista-clientes', vivos.map(f => h('label.opcion',
    h('input', { type: 'checkbox', onchange: e => { e.target.checked ? marcados.add(f.id) : marcados.delete(f.id); } }),
    h('span', h('strong', `${hora(f.momento_declarado || f.momento, app.tz)} · ${TIPOS[f.tipo]}`),
      h('small', [en(f), f.origen && f.origen !== 'APP' ? 'corrección' : null].filter(Boolean).join(' · ') || ' ')))));
  const todos = h('button.btn.enlace', { type: 'button', onclick: () => { lista.querySelectorAll('input').forEach((i, n) => { i.checked = true; marcados.add(vivos[n].id); }); } }, 'Marcar todos');
  const motivo = h('input', { id: 'e-motivo', value: 'Fichaje de prueba' });
  const r = await dialogo(persona ? `Marcar como error · ${persona}` : 'Marcar fichajes como error', [
    h('p.ayuda', 'Los fichajes marcados dejan de contar en horas, informes y facturación. No se borran: quedan anotados con el motivo, como exige el registro de jornada.'),
    lista, todos, h('label', { for: 'e-motivo' }, 'Motivo'), motivo,
  ], [{ texto: 'Cancelar', valor: false }, {
    texto: 'Marcar como error', clase: 'peligro', valor: async () => {
      if (!marcados.size) { aviso('Marca algún fichaje', 'error'); return undefined; }
      if (!motivo.value.trim()) { aviso('Indica el motivo', 'error'); return undefined; }
      const n = await accion(null, () => api.anularFichajes(app.org, [...marcados], motivo.value.trim()));
      if (n === undefined) return undefined;
      aviso(`${n} fichaje${n === 1 ? '' : 's'} marcado${n === 1 ? '' : 's'} como error`, 'ok');
      return true;
    },
  }]);
  if (r) window.dispatchEvent(new HashChangeEvent('hashchange'));
  return !!r;
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
