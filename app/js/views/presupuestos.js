import { api } from '../api.js';
import { h, montar, accion, aviso, eur, fecha, hoyISO } from '../ui.js';
import { categoriaDe } from '../lib/factura.js';
import { opcionesPorFamilia } from './borrador.js';

export async function vistaPresupuestos(app) {
  const [presupuestos, clientes] = await Promise.all([api.presupuestos(app.org), api.clientes(app.org)]);
  const nombre = id => clientes.find(c => c.id === id)?.nombre || 'Sin cliente';
  const abrir = b => { location.hash = '#/facturacion/presupuestos/' + b.id; };
  return h('section.pila',
    h('div.cab', h('div', h('a.volver', { href: '#/facturacion' }, '‹ Facturación'), h('h1', 'Presupuestos')),
      h('a.btn.primario', { href: '#/facturacion/presupuestos/nuevo' }, '+ Nuevo presupuesto')),
    h('div.tarjeta', presupuestos.length ? h('table.tabla',
      h('thead', h('tr', h('th', 'Cliente'), h('th', 'Modificado'), h('th.num', 'Total'))),
      h('tbody', presupuestos.map(b => h('tr.enlace', { role: 'link', tabIndex: 0, onclick: () => abrir(b) },
        h('td', nombre(b.cliente_id)), h('td', fecha(b.actualizado_en)), h('td.num', eur(b.total)))))) : h('p.vacio', 'Todavía no hay presupuestos.')));
}

export async function vistaPresupuesto(app, id) {
  const nuevo = id === 'nuevo';
  const [clientes, proveedores, productos, b] = await Promise.all([api.clientes(app.org), api.proveedores(app.org), api.productos(app.org), nuevo ? null : api.borrador(app.org, id)]);
  if (!nuevo && (!b || b.tipo !== 'PRESUPUESTO')) return h('p.vacio', 'Presupuesto no encontrado.');
  const d = structuredClone(b?.datos || {});
  let borradorId = b?.id || null;
  let solicitudes = borradorId ? await api.solicitudesPrecio(app.org, borradorId) : [];
  const lineas = d.lineas?.length ? d.lineas : [{ descripcion: '', cantidad: 1, unidad: 'ud', pvp: 0 }];
  const cliente = h('select', h('option', { value: '' }, 'Sin cliente todavía'), clientes.map(c => h('option', { value: c.id }, c.nombre)));
  cliente.value = b?.cliente_id || '';
  const fechaDoc = h('input', { type: 'date', value: d.fecha || hoyISO(app.tz) });
  const editor = h('div.lineas-editor');
  const totalEl = h('strong', eur(0));
  const historial = h('div');
  const producto = h('select', { 'aria-label': 'Producto del catálogo' },
    h('option', { value: '' }, 'Selecciona un producto…'),
    opcionesPorFamilia(productos, p => p.descripcion));
  const validas = () => lineas.filter(l => String(l.descripcion || '').trim());
  const total = () => validas().reduce((s, l) => s + (Number(l.cantidad) || 0) * (Number(l.pvp) || 0), 0);

  const lineaLibre = () => ({ producto_id: null, codigo: '', descripcion: '', cantidad: 1, unidad: 'ud', pvp: 0 });
  const anadirProducto = () => {
    const p = productos.find(x => x.id === producto.value);
    if (!p) return;
    if (lineas.length === 1 && !String(lineas[0].descripcion || '').trim()) lineas.splice(0, 1);
    lineas.push({ producto_id: p.id, codigo: p.codigo, descripcion: p.descripcion_factura || p.descripcion, cantidad: 1,
      unidad: p.unidad || 'ud', pvp: Number(p.pvp) || 0, coste: Number(p.coste_ud) || 0, igic: p.igic_pct, familia: p.familia, categoria: categoriaDe(p) });
    producto.value = ''; pintarLineas();
  };
  const pintarLineas = () => {
    const importes = [];
    const recalcular = () => {
      importes.forEach(({ l, el }) => { el.textContent = eur((Number(l.cantidad) || 0) * (Number(l.pvp) || 0)); });
      totalEl.textContent = eur(total());
    };
    montar(editor,
      h('div.linea-pres.cabecera', { 'aria-hidden': 'true' }, ['Descripción', 'Cantidad', 'Unidad', 'PVP unitario', 'Importe estimado', ''].map(x => h('span', x))),
      lineas.map((l, i) => {
        const importe = h('strong.importe-pres'); importes.push({ l, el: importe });
        return h('div.linea-pres',
          campo(l, 'descripcion', 'Descripción', 'text'), campo(l, 'cantidad', 'Cantidad', 'number', recalcular), campo(l, 'unidad', 'Unidad', 'text'),
          campo(l, 'pvp', 'PVP unitario', 'number', recalcular), h('span.importe-pres-wrap', h('span.rotulo', 'Importe estimado'), importe),
          h('button.btn.enlace.quitar', { type: 'button', title: 'Quitar línea', onclick: () => { lineas.splice(i, 1); if (!lineas.length) lineas.push(lineaLibre()); pintarLineas(); } }, '✕'));
      }),
      h('button.btn', { type: 'button', onclick: () => { lineas.push(lineaLibre()); pintarLineas(); } }, '+ Partida libre'));
    recalcular();
  };
  const campo = (l, k, rotulo, type, alCambiar) => h('label', h('span.rotulo', rotulo), h('input', { type, step: type === 'number' ? 'any' : null, min: type === 'number' ? 0 : null, value: l[k] ?? '', oninput: e => { l[k] = type === 'number' ? Number(e.target.value) : e.target.value; alCambiar?.(); } }));

  const guardar = async () => {
    const datos = { fecha: fechaDoc.value, lineas: validas() };
    const r = await api.guardarBorrador(app.org, { id: borradorId, tipo: 'PRESUPUESTO', cliente_id: cliente.value || null, datos, total: total() });
    if (!borradorId) { borradorId = r.id; history.replaceState(null, '', '#/facturacion/presupuestos/' + r.id); }
    return r;
  };
  const pintarHistorial = () => montar(historial, solicitudes.length ? h('table.tabla', h('thead', h('tr', h('th', 'Proveedor'), h('th', 'Email'), h('th', 'Solicitada'))),
    h('tbody', solicitudes.map(s => h('tr', h('td', s.proveedor), h('td', s.email), h('td', fecha(s.solicitada_en)))))) : h('p.vacio', 'Aún no se ha solicitado precio.'));

  const solicitar = async () => {
    const ls = validas();
    if (!ls.length) throw new Error('Añade al menos una línea al presupuesto.');
    await guardar();
    const disponibles = proveedores.filter(p => p.activo !== false && p.email);
    if (!disponibles.length) throw new Error('No hay proveedores activos con email.');
    const dlg = h('dialog.solicitud-precio');
    const checks = disponibles.map(p => ({ p, el: h('input', { type: 'checkbox' }) }));
    const asunto = h('input', { value: `Solicitud de precio · ${app.e.nombre}` });
    const texto = h('textarea', { rows: 9 }, `Hola,\n\nSolicitamos precio y disponibilidad para:\n\n${ls.map(l => `- ${l.cantidad} ${l.unidad || 'ud'} · ${l.codigo ? l.codigo + ' · ' : ''}${l.descripcion}`).join('\n')}\n\nGracias.`);
    montar(dlg, h('form', { method: 'dialog' }, h('div.cab', h('h2', 'Solicitar precio'), h('button.btn.enlace', { value: 'cancel', 'aria-label': 'Cerrar' }, '✕')),
      h('p.ayuda', 'Se abrirá un correo independiente para cada proveedor seleccionado.'),
      h('div.proveedores-check', checks.map(x => h('label.check', x.el, h('span', x.p.nombre, h('small', x.p.email))))),
      h('label', 'Asunto', asunto), h('label', 'Mensaje', texto),
      h('div.acciones', h('button.btn', { value: 'cancel' }, 'Cancelar'), h('button.btn.primario', { type: 'button', onclick: ev => accion(ev.currentTarget, async () => {
        const elegidos = checks.filter(x => x.el.checked).map(x => x.p);
        if (!elegidos.length) throw new Error('Selecciona al menos un proveedor.');
        for (const p of elegidos) {
          await api.guardarSolicitudPrecio(app.org, { presupuesto_id: borradorId, proveedor_id: p.id, proveedor: p.nombre, email: p.email, asunto: asunto.value.trim(), mensaje: texto.value, lineas: ls });
          window.open(`mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(asunto.value)}&body=${encodeURIComponent(texto.value)}`, '_blank');
        }
        solicitudes = await api.solicitudesPrecio(app.org, borradorId); pintarHistorial(); dlg.close(); aviso('Solicitudes registradas y correos preparados', 'ok');
      }) }, 'Preparar correos'))));
    document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
  };
  pintarLineas(); pintarHistorial();
  return h('section.pila', h('a.volver', { href: '#/facturacion/presupuestos' }, '‹ Presupuestos'),
    h('div.cab', h('h1', nuevo ? 'Nuevo presupuesto' : 'Presupuesto'), h('div.acciones',
      h('button.btn', { onclick: ev => accion(ev.currentTarget, async () => { await guardar(); aviso('Presupuesto guardado', 'ok'); }) }, 'Guardar'),
      h('button.btn.primario', { onclick: ev => accion(ev.currentTarget, solicitar) }, 'Solicitar precio'))),
    h('div.tarjeta.formulario', h('div.dos', h('label', 'Cliente', cliente), h('label', 'Fecha', fechaDoc)), h('h3', 'Partidas'),
      h('div.anadir-producto', producto, h('button.btn', { type: 'button', onclick: anadirProducto }, 'Añadir producto')), editor,
      h('div.total-presupuesto', h('span', 'Total estimado'), totalEl)),
    h('div.tarjeta', h('h2', 'Solicitudes a proveedores'), historial));
}
