// Módulo FACTURACIÓN (solo testers): listado de facturas y borradores, detalle con PDF,
// borradores editables y "facturar horas" (convierte la jornada de un cliente en un borrador).
import { api } from '../api.js';
import { h, montar, accion, eur, fecha, hoyISO, sumarDias, preferencia } from '../ui.js';
import { fmtMin } from '../lib/jornada.js';
import { calcular, irpfCliente } from '../lib/factura.js';
import { vistaFactura } from './factura.js';
import { vistaBorrador } from './borrador.js';
import { vistaProductos, vistaProveedores } from './maestros.js';
import { vistaPresupuestos, vistaPresupuesto } from './presupuestos.js';

// #/facturacion · #/facturacion/<clienteId> (facturar horas) · #/facturacion/factura/<id> · #/facturacion/borrador/<id|nuevo>
export async function vistaFacturacion(app, id, sub) {
  if (id === 'factura') return vistaFactura(app, sub);
  if (id === 'borrador') return vistaBorrador(app, sub);
  if (id === 'productos') return vistaProductos(app);
  if (id === 'proveedores') return vistaProveedores(app);
  if (id === 'presupuestos') return sub ? vistaPresupuesto(app, sub) : vistaPresupuestos(app);
  return id ? facturarHoras(app, id) : listado(app);
}

async function listado(app) {
  const [facturas, clientes, borradores] = await Promise.all([api.facturas(app.org), api.clientes(app.org), api.borradores(app.org)]);
  const nombreCliente = id => clientes.find(c => c.id === id)?.nombre || 'Sin cliente';
  const abrirBorrador = b => { location.hash = '#/facturacion/borrador/' + b.id; };
  const listaBorradores = borradores.length ? h('table.tabla',
    h('thead', h('tr', h('th', 'Cliente'), h('th', 'Modificado'), h('th.num', 'Total'))),
    h('tbody', borradores.map(b => h('tr.enlace', { role: 'link', tabIndex: 0, onclick: () => abrirBorrador(b), onkeydown: e => { if (e.key === 'Enter') abrirBorrador(b); } },
      h('td', nombreCliente(b.cliente_id)), h('td', fecha(b.actualizado_en)), h('td.num', eur(b.total)))))) : null;
  const buscar = h('input', { type: 'search', placeholder: 'Buscar número o cliente…', 'aria-label': 'Buscar' });
  const estado = h('select', { 'aria-label': 'Estado de cobro' }, ['', 'PENDIENTE', 'VENCIDA', 'PARCIAL', 'COBRADA', 'HISTORICA', 'RECTIFICADA'].map(v => h('option', { value: v }, v || 'Todos los estados')));
  const tabla = h('div');
  const pintar = () => {
    const q = buscar.value.toLowerCase();
    const r = facturas.filter(f => (!q || (f.num + ' ' + (f.cliente?.nombre || '')).toLowerCase().includes(q)) && (!estado.value || f.estado_cobro === estado.value));
    const pend = r.filter(f => !['RECTIFICADA', 'ANULADA'].includes(f.estado_cobro)).reduce((s, f) => s + (Number(f.pendiente) || 0), 0);
    const abrir = f => { location.hash = '#/facturacion/factura/' + f.id; };
    tabla.replaceChildren(r.length ? h('table.tabla',
      h('thead', h('tr', h('th', 'Nº'), h('th', 'Fecha'), h('th', 'Cliente'), h('th.num', 'Total'), h('th', 'Estado'))),
      h('tbody', r.map(f => h('tr.enlace', { role: 'link', tabIndex: 0, onclick: () => abrir(f), onkeydown: e => { if (e.key === 'Enter') abrir(f); } }, h('td', f.num), h('td', fecha(f.fecha)), h('td', f.cliente?.nombre || ''), h('td.num', eur(f.total)), h('td', h('span.etiqueta.' + String(f.estado_cobro).toLowerCase(), f.estado_cobro))))),
      h('tfoot', h('tr', h('td', { colSpan: 3 }, `${r.length} facturas · pendiente de cobro`), h('td.num', eur(pend)), h('td')))) : h('p.vacio', 'No hay facturas con ese filtro.'));
  };
  [buscar, estado].forEach(x => x.addEventListener('input', pintar)); pintar();

  const elegir = h('select', { 'aria-label': 'Cliente', onchange: ev => { if (ev.target.value) location.hash = '#/facturacion/' + ev.target.value; } },
    h('option', { value: '' }, 'Elige cliente…'), clientes.map(c => h('option', { value: c.id }, c.nombre)));

  return h('section.pila',
    h('div.cab', h('h1', 'Facturación ', h('span.etiqueta', 'beta')), h('div.acciones', h('a.btn', { href: '#/facturacion/productos' }, 'Productos'), h('a.btn', { href: '#/facturacion/proveedores' }, 'Proveedores'), h('a.btn', { href: '#/facturacion/presupuestos' }, 'Presupuestos'), h('a.btn', { href: '#/facturacion/borrador/anterior' }, 'Registrar factura anterior'), h('a.btn.primario', { href: '#/facturacion/borrador/nuevo' }, '+ Nueva factura'))),
    listaBorradores ? h('div.tarjeta', h('h2', 'Borradores'), h('p.ayuda', 'Facturas en preparación: puedes cambiarlas o borrarlas hasta que las emitas.'), listaBorradores) : null,
    h('div.tarjeta', h('h2', 'Facturar horas registradas'), h('p.ayuda', 'Convierte las horas y desplazamientos fichados para un cliente en un borrador de factura.'), elegir),
    h('div.tarjeta', h('h2', 'Facturas emitidas'), h('div.filtros', buscar, estado), tabla));
}

async function facturarHoras(app, clienteId) {
  const hoy = hoyISO(app.tz);
  const [clientes, productos] = await Promise.all([api.clientes(app.org), api.productos(app.org).catch(() => [])]);
  const c = clientes.find(x => x.id === clienteId);
  if (!c) return h('p.vacio', 'Cliente no encontrado.');
  const desde = h('input', { type: 'date', value: sumarDias(hoy, -30), 'aria-label': 'Desde' });
  const hasta = h('input', { type: 'date', value: hoy, 'aria-label': 'Hasta' });
  // Producto del catálogo para cada línea: lo elige quien factura (se recuerda la última elección).
  // Sin producto, la línea sale como «Horas de trabajo» / «Desplazamiento» genéricos.
  const candidatosHora = productos.filter(p => p.unidad === 'h');
  const candidatosDesp = productos.filter(p => /TRANS|DESPL/i.test(p.codigo));
  const selectorProducto = (lista, clave, generico) => {
    const guardado = preferencia(clave);
    return h('select', { 'aria-label': 'Producto' },
      h('option', { value: '' }, generico),
      lista.map(p => h('option', { value: p.id, selected: p.id === guardado }, `${p.codigo} · ${p.descripcion_factura || p.descripcion}`)));
  };
  const selHora = selectorProducto(candidatosHora, 'fact-prod-hora', 'Horas de trabajo (sin producto)');
  const selDesp = selectorProducto(candidatosDesp, 'fact-prod-desp', 'Desplazamiento (sin producto)');
  let prodHora = {}, prodDesp = {};
  const precioHora = h('input', { type: 'number', step: '0.01', min: 0, 'aria-label': 'Precio por hora' });
  const precioDesp = h('input', { type: 'number', step: '0.01', min: 0, 'aria-label': 'Precio por desplazamiento' });
  const aplicarProductos = () => {
    prodHora = candidatosHora.find(p => p.id === selHora.value) || {};
    prodDesp = candidatosDesp.find(p => p.id === selDesp.value) || {};
    precioHora.value = prodHora.pvp ?? 35; precioDesp.value = prodDesp.pvp ?? 25;
  };
  aplicarProductos();
  const igic = Number(app.e.config?.igic_defecto ?? 7);
  const cuerpo = h('div');
  let horas = [];

  const lineas = () => {
    const sel = horas.filter(x => x._sel);
    const trabajo = sel.filter(x => x.tipo === 'TRABAJO'), desp = sel.filter(x => x.tipo === 'DESPLAZAMIENTO');
    const out = [];
    const porPersona = {};
    trabajo.forEach(x => { porPersona[x.nombre || 'Equipo'] = (porPersona[x.nombre || 'Equipo'] || 0) + x.minutos; });
    // Fechas de los días realmente facturados, no las del filtro
    const periodo = xs => { const ds = xs.map(x => x.dia).sort(); return ds[0] === ds.at(-1) ? fecha(ds[0]) : `${fecha(ds[0])} – ${fecha(ds.at(-1))}`; };
    Object.entries(porPersona).forEach(([n, m]) => out.push({ producto_id: prodHora.id || null, codigo: prodHora.codigo || 'HORA', descripcion: `${prodHora.descripcion_factura || 'Horas de trabajo'} (${n}, ${periodo(trabajo.filter(x => (x.nombre || 'Equipo') === n))})`, cantidad: Math.round(m / 60 * 100) / 100, unidad: 'h', pvp: Number(precioHora.value) || 0, dto: 0, igic: prodHora.igic_pct ?? igic, familia: prodHora.familia, categoria: 'MANO DE OBRA' }));
    const viajes = desp.reduce((s, x) => s + x.tramos, 0);
    if (viajes) out.push({ producto_id: prodDesp.id || null, codigo: prodDesp.codigo || 'DESPL', descripcion: prodDesp.descripcion_factura || 'Desplazamiento', cantidad: viajes, unidad: 'ud', pvp: Number(precioDesp.value) || 0, dto: 0, igic: prodDesp.igic_pct ?? igic, familia: prodDesp.familia, categoria: 'TRANSPORTE' });
    return out;
  };

  const pintar = () => {
    const ls = lineas();
    const base = ls.reduce((s, l) => s + Math.round(l.cantidad * l.pvp * 100), 0) / 100;
    montar(cuerpo,
      horas.length ? h('table.tabla',
        h('thead', h('tr', h('th', ''), h('th', 'Día'), h('th', 'Persona'), h('th', 'Qué'), h('th', 'Tiempo'))),
        h('tbody', horas.map(x => h('tr', h('td', h('input', { type: 'checkbox', checked: x._sel, 'aria-label': 'Incluir', onchange: ev => { x._sel = ev.target.checked; pintar(); } })),
          h('td', fecha(x.dia)), h('td', x.nombre || ''), h('td', x.tipo === 'TRABAJO' ? 'Trabajo' : `Desplazamiento ×${x.tramos}`), h('td', fmtMin(x.minutos)))))) : h('p.vacio', 'No hay horas pendientes de facturar en este periodo.'),
      ls.length ? h('div.tarjeta.interior', h('h3', 'Líneas de la factura'),
        h('ul', ls.map(l => h('li', `${l.descripcion} — ${l.cantidad.toLocaleString('es-ES')} ${l.unidad} × ${eur(l.pvp)}`))),
        h('p', 'Base imponible: ', h('strong', eur(base)), h('span.ayuda', ` · + IGIC ${igic} % · IRPF según cliente`)),
        h('p.ayuda', 'En el borrador podrás revisar y cambiar las líneas antes de emitir la factura.'),
        h('button.btn.primario', {
          onclick: ev => accion(ev.currentTarget, async () => {
            const datos = { fecha: hoy, lineas: ls, desde: desde.value, hasta: hasta.value, irpf_pct: irpfCliente(c, app.e.config),
              horas: horas.filter(x => x._sel).map(x => ({ user_id: x.user_id, dia: x.dia, tipo: x.tipo, minutos: x.minutos, km: x.km })) };
            const b = await api.guardarBorrador(app.org, { cliente_id: c.id, datos, total: calcular(ls, datos.irpf_pct).total });
            location.hash = '#/facturacion/borrador/' + b.id;
          }),
        }, 'Crear borrador')) : null);
  };
  const cargar = async () => { horas = (await api.horasPendientes(app.org, c.id, desde.value, hasta.value)).map(x => ({ ...x, _sel: true })); pintar(); };
  [desde, hasta].forEach(x => x.addEventListener('change', () => accion(null, cargar)));
  [precioHora, precioDesp].forEach(x => x.addEventListener('input', pintar));
  selHora.addEventListener('change', () => { preferencia('fact-prod-hora', selHora.value); aplicarProductos(); pintar(); });
  selDesp.addEventListener('change', () => { preferencia('fact-prod-desp', selDesp.value); aplicarProductos(); pintar(); });
  await cargar();

  return h('section.pila',
    h('a.volver', { href: '#/facturacion' }, '← Facturación'),
    h('h1', 'Facturar horas · ' + c.nombre),
    h('div.tarjeta', h('div.filtros', desde, hasta),
      h('div.dos', h('label', 'Producto para las horas', selHora), h('label', 'Producto para los desplazamientos', selDesp)),
      h('div.dos', h('label', 'Precio hora (€)', precioHora), h('label', 'Precio desplazamiento (€)', precioDesp)), cuerpo));
}
