// Módulo FACTURACIÓN (solo testers). De momento: listado de facturas y
// "facturar horas": convierte la jornada registrada para un cliente en líneas de factura.
import { api } from '../api.js';
import { h, montar, accion, aviso, eur, fecha, hoyISO, sumarDias } from '../ui.js';
import { fmtMin } from '../lib/jornada.js';

export async function vistaFacturacion(app, clienteId) {
  return clienteId ? facturarHoras(app, clienteId) : listado(app);
}

async function listado(app) {
  const [facturas, clientes] = await Promise.all([api.facturas(app.org), api.clientes(app.org)]);
  const buscar = h('input', { type: 'search', placeholder: 'Buscar número o cliente…', 'aria-label': 'Buscar' });
  const estado = h('select', { 'aria-label': 'Estado de cobro' }, ['', 'PENDIENTE', 'VENCIDA', 'PARCIAL', 'COBRADA', 'HISTORICA', 'RECTIFICADA'].map(v => h('option', { value: v }, v || 'Todos los estados')));
  const tabla = h('div');
  const pintar = () => {
    const q = buscar.value.toLowerCase();
    const r = facturas.filter(f => (!q || (f.num + ' ' + (f.cliente?.nombre || '')).toLowerCase().includes(q)) && (!estado.value || f.estado_cobro === estado.value));
    const pend = r.reduce((s, f) => s + (Number(f.pendiente) || 0), 0);
    tabla.replaceChildren(r.length ? h('table.tabla',
      h('thead', h('tr', h('th', 'Nº'), h('th', 'Fecha'), h('th', 'Cliente'), h('th.num', 'Total'), h('th', 'Estado'))),
      h('tbody', r.map(f => h('tr', h('td', f.num), h('td', fecha(f.fecha)), h('td', f.cliente?.nombre || ''), h('td.num', eur(f.total)), h('td', h('span.etiqueta.' + String(f.estado_cobro).toLowerCase(), f.estado_cobro))))),
      h('tfoot', h('tr', h('td', { colSpan: 3 }, `${r.length} facturas · pendiente de cobro`), h('td.num', eur(pend)), h('td')))) : h('p.vacio', 'No hay facturas con ese filtro.'));
  };
  [buscar, estado].forEach(x => x.addEventListener('input', pintar)); pintar();

  const elegir = h('select', { 'aria-label': 'Cliente', onchange: ev => { if (ev.target.value) location.hash = '#/facturacion/' + ev.target.value; } },
    h('option', { value: '' }, 'Elige cliente…'), clientes.map(c => h('option', { value: c.id }, c.nombre)));

  return h('section.pila',
    h('div.cab', h('h1', 'Facturación'), h('span.etiqueta', 'beta')),
    h('div.tarjeta', h('h2', 'Facturar horas registradas'), h('p.ayuda', 'Convierte las horas y desplazamientos fichados para un cliente en una factura.'), elegir),
    h('div.tarjeta', h('h2', 'Facturas'), h('div.filtros', buscar, estado), tabla));
}

async function facturarHoras(app, clienteId) {
  const hoy = hoyISO(app.tz);
  const [clientes, productos] = await Promise.all([api.clientes(app.org), api.productos(app.org).catch(() => [])]);
  const c = clientes.find(x => x.id === clienteId);
  if (!c) return h('p.vacio', 'Cliente no encontrado.');
  const desde = h('input', { type: 'date', value: sumarDias(hoy, -30), 'aria-label': 'Desde' });
  const hasta = h('input', { type: 'date', value: hoy, 'aria-label': 'Hasta' });
  const prodHora = productos.find(p => p.unidad === 'h') || {};
  const prodDesp = productos.find(p => /TRANS|DESPL/i.test(p.codigo)) || {};
  const precioHora = h('input', { type: 'number', step: '0.01', min: 0, value: prodHora.pvp ?? 35, 'aria-label': 'Precio por hora' });
  const precioDesp = h('input', { type: 'number', step: '0.01', min: 0, value: prodDesp.pvp ?? 25, 'aria-label': 'Precio por desplazamiento' });
  const igic = Number(app.e.config?.igic_defecto ?? 7);
  const cuerpo = h('div');
  let horas = [];

  const lineas = () => {
    const sel = horas.filter(x => x._sel);
    const trabajo = sel.filter(x => x.tipo === 'TRABAJO'), desp = sel.filter(x => x.tipo === 'DESPLAZAMIENTO');
    const out = [];
    const porPersona = {};
    trabajo.forEach(x => { porPersona[x.nombre || 'Equipo'] = (porPersona[x.nombre || 'Equipo'] || 0) + x.minutos; });
    Object.entries(porPersona).forEach(([n, m]) => out.push({ producto_id: prodHora.id || null, codigo: prodHora.codigo || 'HORA', descripcion: `${prodHora.descripcion_factura || 'Horas de trabajo'} (${n}, ${fecha(desde.value)} – ${fecha(hasta.value)})`, cantidad: Math.round(m / 60 * 100) / 100, unidad: 'h', pvp: Number(precioHora.value) || 0, dto: 0, igic: prodHora.igic_pct ?? igic }));
    const viajes = desp.reduce((s, x) => s + x.tramos, 0);
    if (viajes) out.push({ producto_id: prodDesp.id || null, codigo: prodDesp.codigo || 'DESPL', descripcion: prodDesp.descripcion_factura || 'Desplazamiento', cantidad: viajes, unidad: 'ud', pvp: Number(precioDesp.value) || 0, dto: 0, igic: prodDesp.igic_pct ?? igic });
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
        h('button.btn.primario', {
          onclick: ev => accion(ev.currentTarget, async () => {
            if (!confirm(`¿Emitir la factura a ${c.nombre}? Una factura emitida no se puede borrar.`)) return;
            const f = await api.emitirFactura(app.org, { cliente_id: c.id, fecha: hoy, lineas: ls, desde: desde.value, hasta: hasta.value,
              horas: horas.filter(x => x._sel).map(x => ({ user_id: x.user_id, dia: x.dia, tipo: x.tipo, minutos: x.minutos, km: x.km })) });
            aviso(`Factura ${f.num} emitida: ${eur(f.total)}`, 'ok'); location.hash = '#/facturacion';
          }),
        }, 'Emitir factura')) : null);
  };
  const cargar = async () => { horas = (await api.horasPendientes(app.org, c.id, desde.value, hasta.value)).map(x => ({ ...x, _sel: true })); pintar(); };
  [desde, hasta].forEach(x => x.addEventListener('change', () => accion(null, cargar)));
  [precioHora, precioDesp].forEach(x => x.addEventListener('input', pintar));
  await cargar();

  return h('section.pila',
    h('a.volver', { href: '#/facturacion' }, '← Facturación'),
    h('h1', 'Facturar horas · ' + c.nombre),
    h('div.tarjeta', h('div.filtros', desde, hasta),
      h('div.dos', h('label', 'Precio hora (€)', precioHora), h('label', 'Precio desplazamiento (€)', precioDesp)), cuerpo));
}
