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

const $vista = document.getElementById('vista');
const $menu = document.getElementById('menu');
const $empresa = document.getElementById('empresa');

export const app = {
  empresas: [], org: null,
  get e() { return this.empresas.find(x => x.id === this.org); },
  get rol() { return this.e?.rol; },
  get uso() { return this.e?.config?.uso || null; },   // sondeo inicial: personal, profesional, ambos o indeciso
  get miTiempo() { return usaPersonal(this.uso) || preferencia('mi-tiempo') === 'si'; },
  get tz() { return this.e?.config?.zona_horaria || 'Atlantic/Canary'; },
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
  const items = modoSA ? [
    ['#/sa', 'Licencias', 'equipo'],
    app.e && ['#/', 'Volver a mi empresa', 'reloj'],
  ].filter(Boolean) : app.uso === 'personal' ? [
    ['#/personal', 'Mi tiempo', 'crono'],
    ['#/jornada', 'Jornada', 'reloj'],
    ['#/ajustes', 'Ajustes', 'ajustes'],
  ] : [
    ['#/', 'Jornada', 'reloj'],
    app.miTiempo && ['#/personal', 'Mi tiempo', 'crono'],
    ['#/clientes', 'Clientes', 'pin'],
    ['#/proyectos', 'Proyectos', 'carpeta'],
    puedeVerEquipo(app.rol) && ['#/equipo', 'Equipo', 'equipo'],
    puedeVerEquipo(app.rol) && ['#/tiempos', 'Tiempos', 'reparto'],
    app.facturacion && ['#/facturacion', 'Facturación', 'factura'],
    ['#/ajustes', 'Ajustes', 'ajustes'],
  ].filter(Boolean);
  $menu.hidden = false;
  montar($menu, items.map(([href, txt, ic]) => h('a', { href, class: (ruta === href || (href !== '#/' && ruta.startsWith(href))) ? 'activo' : '' },
    h('span.icono.' + ic, { 'aria-hidden': 'true' }), h('span', txt))));
}

async function router() {
  const ruta = location.hash || '#/';
  try {
    const sesion = await api.sesion();
    if (!sesion) { $menu.hidden = true; $empresa.replaceChildren(); return montar($vista, await vistaLogin()); }
    if (!app.empresas.length) await cargarEmpresas();
    if (ruta.startsWith('#/sa') && app.superadmin) {
      pintarCabecera(true); pintarMenu('#/sa', true);
      montar($vista, await vistaAdmin(app)); $vista.focus?.(); return;
    }
    if (!app.e) { pintarCabecera(); $menu.hidden = true; return montar($vista, await vistaAlta(app)); }
    // Uso personal: se entra por «Mi tiempo» (salvo si se abrió desde una etiqueta NFC, que pregunta en la Jornada)
    if (app.uso === 'personal' && ruta === '#/' && !app.nfc && !app.qr) { location.replace('#/personal'); return; }
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
