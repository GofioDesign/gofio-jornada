import { api, DEMO } from './api.js';
import { h, montar, aviso, preferencia, puedeVerEquipo, puedeGestionar } from './ui.js';
import { vistaLogin, vistaAlta } from './views/acceso.js';
import { vistaJornada } from './views/jornada.js';
import { vistaClientes, vistaCliente } from './views/clientes.js';
import { vistaProyectos, vistaProyecto } from './views/proyectos.js';
import { vistaEquipo } from './views/equipo.js';
import { vistaTiempos } from './views/tiempos.js';
import { vistaAjustes } from './views/ajustes.js';
import { vistaFacturacion } from './views/facturacion.js';
import { vistaAdmin } from './views/admin.js';
import { vistaPersonal } from './views/personal.js';
import { usaPersonal } from './lib/personal.js';
import { ESPACIOS, espaciosDisponibles, espacioActivo, menuDe, colorEspacio } from './lib/espacios.js';

const $vista = document.getElementById('vista');
const $menu = document.getElementById('menu');
const $empresa = document.getElementById('empresa');
const $espacios = document.getElementById('espacios');

export const app = {
  empresas: [], org: null,
  get e() { return this.empresas.find(x => x.id === this.org); },
  get rol() { return this.e?.rol; },
  get uso() { return this.e?.config?.uso || null; },   // sondeo inicial: personal, profesional, ambos o indeciso
  get miTiempo() { return usaPersonal(this.uso) || preferencia('mi-tiempo') === 'si'; },
  get tz() { return this.e?.config?.zona_horaria || 'Atlantic/Canary'; },
  get espacios() { return espaciosDisponibles(this.uso, this.miTiempo); },   // Personal y/o Pro (los botones de abajo)
  get facturacion() { return !!(this.e?.tester_facturacion && this.e?.usa_facturacion && ['propietario', 'admin', 'gestoria'].includes(this.rol)); },
  async recargar() { await cargarEmpresas(); router(); },
};

// ?nfc=coche: la app se abrió desde una etiqueta NFC. Se quita de la URL y la Jornada pregunta qué fichar.
const parametros = new URLSearchParams(location.search);
if (parametros.has('nfc')) {
  app.nfc = (parametros.get('nfc') || 'NFC').slice(0, 40);
  const resto = location.search.slice(1).split('&').filter(x => x && !/^nfc(=|$)/.test(x)).join('&');
  history.replaceState(null, '', location.pathname + (resto ? '?' + resto : '') + '#/');
}
// ?qr=<token>: se ha escaneado el código QR de un punto de fichaje (o una etiqueta NFC con esa dirección).
if (parametros.has('qr')) {
  const token = parametros.get('qr') || '';
  if (/^[0-9a-f]{16,64}$/i.test(token)) app.qr = token.toLowerCase();
  const resto = location.search.slice(1).split('&').filter(x => x && !/^qr(=|$)/.test(x)).join('&');
  history.replaceState(null, '', location.pathname + (resto ? '?' + resto : '') + '#/');
}

async function cargarEmpresas() {
  app.empresas = await api.misEmpresas();
  app.superadmin = await api.esSuperadmin().catch(() => false);
  const guardada = preferencia('org');
  app.org = app.empresas.some(e => e.id === guardada) ? guardada : app.empresas[0]?.id || null;
}

function pintarCabecera(modoSA = false) {
  document.body.classList.toggle('modo-sa', modoSA);
  if (modoSA) { montar($empresa, h('span.etiqueta.sa', 'Superadministración')); return; }
  if (!app.e) { $empresa.replaceChildren(); return; }
  const sel = app.empresas.length > 1
    ? h('select.selector-empresa', { 'aria-label': 'Empresa', onchange: e => { preferencia('org', e.target.value); app.org = e.target.value; router(); } },
        app.empresas.map(x => h('option', { value: x.id, selected: x.id === app.org }, x.nombre)))
    : h('span', app.e.nombre);
  montar($empresa, sel, DEMO ? h('span.etiqueta.demo', 'DEMO') : null);
}

function pintarMenu(ruta, modoSA = false) {
  // Modo superadmin: gestión de la plataforma, aparte del menú de la empresa
  const espacio = modoSA ? null : espacioActivo(app.espacios, ruta, preferencia('espacio'));
  if (espacio) preferencia('espacio', espacio);
  document.querySelector('.marca')?.setAttribute('href', ESPACIOS[espacio]?.inicio || '#/');
  pintarColor(modoSA ? null : espacio);
  const items = modoSA ? [
    ['#/sa', 'Licencias', 'equipo'],
    app.e && ['#/', 'Volver a mi empresa', 'reloj'],
  ].filter(Boolean) : menuDe(espacio, { uso: app.uso, verEquipo: puedeVerEquipo(app.rol), facturacion: app.facturacion });
  $menu.hidden = false;
  montar($menu, items.map(([href, txt, ic]) => h('a', { href, class: (ruta === href || (href !== '#/' && ruta.startsWith(href))) ? 'activo' : '' },
    h('span.icono.' + ic, { 'aria-hidden': 'true' }), h('span', txt))));
  $menu.querySelector('.activo')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // en el móvil el menú se desliza de lado
  pintarEspacios(modoSA ? [] : app.espacios, espacio);
}

// Color principal del espacio (Ajustes › Colores de los espacios). Con el verde de serie se deja el tema tal cual.
function pintarColor(espacio) {
  const color = colorEspacio(espacio, espacio && preferencia('color-' + espacio));
  const propio = color !== ESPACIOS.pro.color;
  document.body.toggleAttribute('data-color', propio);
  if (propio) document.body.style.setProperty('--color-espacio', color); else document.body.style.removeProperty('--color-espacio');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

// Botones de abajo: cambian de espacio y, con él, las secciones de la cabecera. Solo salen si hay más de uno.
function pintarEspacios(disponibles, activo) {
  const ver = disponibles.length > 1;
  $espacios.hidden = !ver;
  document.body.classList.toggle('con-espacios', ver);
  if (!ver) return $espacios.replaceChildren();
  montar($espacios, disponibles.map(id => h('button', {
    type: 'button', class: id === activo ? 'activo' : '', 'aria-pressed': String(id === activo),
    onclick: () => {
      if (id === activo) return;
      preferencia('espacio', id);
      location.hash = ESPACIOS[id].inicio;
    },
  }, h('span.icono.' + ESPACIOS[id].icono, { 'aria-hidden': 'true' }), h('span', ESPACIOS[id].nombre))));
}

let entrado = false;   // la primera vista de la sesión abre el último espacio usado

async function router() {
  const ruta = location.hash || '#/';
  try {
    const sesion = await api.sesion();
    if (!sesion) { $menu.hidden = true; pintarEspacios([]); $empresa.replaceChildren(); return montar($vista, await vistaLogin()); }
    if (!app.empresas.length) await cargarEmpresas();
    if (ruta.startsWith('#/sa') && app.superadmin) {
      pintarCabecera(true); pintarMenu('#/sa', true);
      montar($vista, await vistaAdmin(app)); $vista.focus?.(); return;
    }
    if (!app.e) { pintarCabecera(); $menu.hidden = true; pintarEspacios([]); return montar($vista, await vistaAlta(app)); }
    // Se entra por el espacio de la última vez (o por «Mi tiempo» si el uso es solo personal),
    // salvo si se abrió desde una etiqueta NFC o un QR, que preguntan en la Jornada
    if (ruta === '#/' && !app.nfc && !app.qr && !app.espacios.includes('pro')) { location.replace('#/personal'); return; }
    if (!entrado) {
      entrado = true;
      if (ruta === '#/' && !app.nfc && !app.qr && app.espacios.includes('personal') && preferencia('espacio') === 'personal') { location.replace('#/personal'); return; }
    }
    pintarCabecera(); pintarMenu(ruta);
    const [, seccion, id, sub] = ruta.replace(/^#\/?/, '#/').split('/');
    let v;
    switch (seccion) {
      case 'clientes': v = id ? await vistaCliente(app, id) : await vistaClientes(app); break;
      case 'proyectos': v = id ? await vistaProyecto(app, id) : await vistaProyectos(app); break;
      case 'equipo': v = puedeVerEquipo(app.rol) ? await vistaEquipo(app) : null; break;
      case 'personal': v = await vistaPersonal(app); break;
      case 'tiempos': v = puedeVerEquipo(app.rol) ? await vistaTiempos(app) : null; break;
      case 'ajustes': v = await vistaAjustes(app, id); break;
      case 'admin': location.replace('#/sa'); return;   // antigua dirección del panel
      case 'facturacion': v = app.facturacion ? await vistaFacturacion(app, id, sub) : null; break;
      default: v = await vistaJornada(app);
    }
    montar($vista, v || h('p.vacio', 'No tienes acceso a esta sección.'));
    $vista.focus?.();
  } catch (e) {
    console.error(e);
    montar($vista, h('div.tarjeta', h('h2', 'No se ha podido cargar'), h('p', e.message), h('button.btn', { onclick: () => location.reload() }, 'Reintentar')));
  }
}

window.addEventListener('hashchange', router);
api.alCambiarSesion(async s => { if (s) { app.empresas = []; } router(); });
router();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
export { puedeGestionar, aviso };
