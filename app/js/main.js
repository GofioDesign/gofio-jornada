import { api, DEMO } from './api.js';
import { h, montar, aviso, preferencia, puedeVerEquipo, puedeGestionar } from './ui.js';
import { vistaLogin, vistaAlta } from './views/acceso.js';
import { vistaJornada } from './views/jornada.js';
import { vistaClientes, vistaCliente } from './views/clientes.js';
import { vistaEquipo } from './views/equipo.js';
import { vistaAjustes } from './views/ajustes.js';
import { vistaFacturacion } from './views/facturacion.js';

const $vista = document.getElementById('vista');
const $menu = document.getElementById('menu');
const $empresa = document.getElementById('empresa');

export const app = {
  empresas: [], org: null,
  get e() { return this.empresas.find(x => x.id === this.org); },
  get rol() { return this.e?.rol; },
  get tz() { return this.e?.config?.zona_horaria || 'Atlantic/Canary'; },
  get facturacion() { return !!(this.e?.tester_facturacion && this.e?.usa_facturacion && ['propietario', 'admin', 'gestoria'].includes(this.rol)); },
  async recargar() { await cargarEmpresas(); router(); },
};

async function cargarEmpresas() {
  app.empresas = await api.misEmpresas();
  const guardada = preferencia('org');
  app.org = app.empresas.some(e => e.id === guardada) ? guardada : app.empresas[0]?.id || null;
}

function pintarCabecera() {
  if (!app.e) { $empresa.replaceChildren(); return; }
  const sel = app.empresas.length > 1
    ? h('select.selector-empresa', { 'aria-label': 'Empresa', onchange: e => { preferencia('org', e.target.value); app.org = e.target.value; router(); } },
        app.empresas.map(x => h('option', { value: x.id, selected: x.id === app.org }, x.nombre)))
    : h('span', app.e.nombre);
  montar($empresa, sel, DEMO ? h('span.etiqueta.demo', 'DEMO') : null);
}

function pintarMenu(ruta) {
  const items = [
    ['#/', 'Jornada', 'reloj'],
    ['#/clientes', 'Clientes', 'pin'],
    puedeVerEquipo(app.rol) && ['#/equipo', 'Equipo', 'equipo'],
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
    if (!app.e) { $menu.hidden = true; return montar($vista, await vistaAlta(app)); }
    pintarCabecera(); pintarMenu(ruta);
    const [, seccion, id] = ruta.replace(/^#\/?/, '#/').split('/');
    let v;
    switch (seccion) {
      case 'clientes': v = id ? await vistaCliente(app, id) : await vistaClientes(app); break;
      case 'equipo': v = puedeVerEquipo(app.rol) ? await vistaEquipo(app) : null; break;
      case 'ajustes': v = await vistaAjustes(app, id); break;
      case 'facturacion': v = app.facturacion ? await vistaFacturacion(app, id) : null; break;
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
