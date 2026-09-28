import { api } from '../api.js';
import { h, eur, fecha, accion, aviso, dialogo, puedeGestionar } from '../ui.js';
import { claveMargenFamilia, datosPrecio, margenObjetivo } from '../lib/precios.js';

const pct = n => Number(n).toLocaleString('es-ES', { style: 'percent', maximumFractionDigits: 1 });

function indicadorPrecio(producto, config) {
  const d = datosPrecio(producto.coste_ud, producto.pvp, config, producto.familia);
  if (d.ideal === null) return h('small.precio-info.neutro', 'Sin coste para calcular margen');
  return h(`small.precio-info.${d.cumple ? 'ok' : 'alerta'}`,
    `${d.cumple ? 'En objetivo' : 'Por debajo'} · ${pct(d.margen)} · ideal ${eur(d.ideal)}`);
}

export async function vistaProductos(app) {
  const [productos, proveedores] = await Promise.all([api.catalogoProductos(app.org), api.proveedores(app.org)]);
  const familias = [...new Set(productos.map(p => p.familia).filter(Boolean))].sort();
  const buscar = h('input', { type: 'search', placeholder: 'Buscar código o descripción…', 'aria-label': 'Buscar productos' });
  const familia = h('select', { 'aria-label': 'Familia' }, h('option', { value: '' }, 'Todas las familias'), familias.map(x => h('option', { value: x }, x)));
  const estado = h('select', { 'aria-label': 'Estado' }, h('option', { value: '' }, 'Todos'), h('option', { value: '1' }, 'Activos'), h('option', { value: '0' }, 'Inactivos'));
  const contenido = h('div');
  const pintar = () => {
    const q = buscar.value.trim().toLowerCase();
    const filas = productos.filter(p => (!q || `${p.codigo} ${p.descripcion} ${p.descripcion_factura || ''}`.toLowerCase().includes(q))
      && (!familia.value || p.familia === familia.value) && (estado.value === '' || Boolean(p.activo) === (estado.value === '1')));
    contenido.replaceChildren(filas.length ? h('table.tabla',
      h('thead', h('tr', h('th', 'Código'), h('th', 'Descripción'), h('th', 'Familia'), h('th.num', 'Coste'), h('th.num', 'PVP'), h('th', 'Mejor proveedor'), h('th', 'Estado'))),
      h('tbody', filas.map(p => h('tr.enlace', { role: 'button', tabIndex: 0, onclick: () => editarProducto(app, p, proveedores), onkeydown: e => { if (e.key === 'Enter') editarProducto(app, p, proveedores); } }, h('td', h('strong', p.codigo)), h('td', p.descripcion), h('td', p.familia),
        h('td.num', eur(p.coste_ud)), h('td.num.precio-producto', eur(p.pvp), indicadorPrecio(p, app.e.config)), h('td', p.mejor_proveedor ? `${p.mejor_proveedor} · ${eur(p.mejor_precio)}` : '—'),
        h('td', h('span.etiqueta', p.activo ? 'Activo' : 'Inactivo')))))) : h('p.vacio', 'No hay productos con esos filtros.'));
  };
  [buscar, familia, estado].forEach(x => x.addEventListener('input', pintar)); pintar();
  return h('section.pila', h('div.cab', h('div', h('a.volver', { href: '#/facturacion' }, '‹ Facturación'), h('h1', 'Productos')), h('div.acciones',
    puedeGestionar(app.rol) ? h('button.btn', { onclick: () => editarMargenes(app, familias) }, 'Márgenes') : null,
    h('a.btn', { href: '#/ajustes/importar-maestros' }, 'Importar desde v7'), h('button.btn.primario', { onclick: () => editarProducto(app, {}, proveedores) }, '+ Nuevo producto'))),
    h('div.tarjeta.filtros', buscar, familia, estado), h('div.tarjeta', contenido));
}

async function editarProducto(app, producto, proveedores) {
  const campo = (id, etiqueta, attrs = {}) => [h('label', { for: 'prod-' + id }, etiqueta), h('input', { id: 'prod-' + id, value: producto[id] ?? '', ...attrs })];
  const proveedor = h('select', { id: 'prod-proveedor' }, h('option', { value: '' }, 'Sin proveedor habitual'),
    proveedores.map(p => h('option', { value: p.id, selected: p.id === producto.proveedor_id }, `${p.codigo} · ${p.nombre}`)));
  const precioInfo = h('div.precio-editor');
  const form = h('form.formulario',
    h('div.dos', h('div', campo('codigo', 'Código *', { required: true })), h('div', campo('familia', 'Familia *', { required: true, list: 'familias-producto' }))),
    h('datalist', { id: 'familias-producto' }, ['MANO DE OBRA', 'MATERIALES', 'TRANSPORTE', 'FIJACIONES Y ACCESORIOS', 'SERVICIOS'].map(x => h('option', { value: x }))),
    campo('descripcion', 'Descripción interna *', { required: true }), campo('descripcion_factura', 'Descripción para factura'),
    h('div.dos', h('div', campo('unidad', 'Unidad *', { required: true })), h('div', h('label', { for: 'prod-proveedor' }, 'Proveedor habitual'), proveedor)),
    campo('ref_proveedor', 'Referencia del proveedor'),
    h('div.dos', h('div', campo('coste_ud', 'Coste unitario', { type: 'number', min: 0, step: '0.01' })), h('div', campo('pvp', 'PVP sin IGIC', { type: 'number', min: 0, step: '0.01' }), precioInfo)),
    h('div.dos', h('div', campo('igic_pct', 'IGIC (%)', { type: 'number', min: 0, max: 20, step: '0.01' })), h('div', campo('pvp_historico', 'PVP histórico', { type: 'number', min: 0, step: '0.01' }))),
    h('label', { for: 'prod-notas' }, 'Notas'), h('textarea', { id: 'prod-notas', rows: 3, value: producto.notas || '' }),
    h('label.check', h('input', { id: 'prod-activo', type: 'checkbox', checked: producto.activo !== false }), ' Activo'));
  const pintarPrecio = () => precioInfo.replaceChildren(indicadorPrecio({ coste_ud: form.querySelector('#prod-coste_ud').value,
    pvp: form.querySelector('#prod-pvp').value, familia: form.querySelector('#prod-familia').value }, app.e.config));
  ['coste_ud', 'pvp', 'familia'].forEach(id => form.querySelector('#prod-' + id).addEventListener('input', pintarPrecio));
  pintarPrecio();
  await dialogo(producto.id ? `Editar ${producto.codigo}` : 'Nuevo producto', form, [{ texto: 'Cancelar', valor: false }, {
    texto: 'Guardar', clase: 'primario', valor: async () => {
      if (!form.reportValidity()) return undefined;
      const v = id => form.querySelector('#prod-' + id).value.trim();
      const n = id => v(id) === '' ? null : Number(v(id));
      const datos = { id: producto.id, codigo: v('codigo').toUpperCase(), familia: v('familia').toUpperCase(), descripcion: v('descripcion'),
        descripcion_factura: v('descripcion_factura') || null, unidad: v('unidad'), proveedor_id: proveedor.value || null,
        ref_proveedor: v('ref_proveedor') || null, coste_ud: n('coste_ud') ?? 0, pvp: n('pvp') ?? 0,
        igic_pct: n('igic_pct'), pvp_historico: n('pvp_historico'), notas: v('notas') || null,
        activo: form.querySelector('#prod-activo').checked };
      const ok = await accion(null, async () => { await api.guardarProducto(app.org, datos); return true; });
      if (!ok) return undefined;
      aviso('Producto guardado', 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange')); return true;
    },
  }]);
}

async function editarMargenes(app, familias) {
  const cfg = app.e.config || {};
  const general = h('input', { id: 'margen-general', type: 'number', min: 1, max: 95, step: 1, value: margenObjetivo(cfg) * 100 });
  const campos = familias.map((familia, i) => {
    const clave = claveMargenFamilia(familia);
    return h('div.margen-familia', h('label', { for: `margen-${i}` }, familia),
      h('div.campo-porcentaje', h('input', { id: `margen-${i}`, type: 'number', min: 1, max: 95, step: 1,
        value: cfg[clave] == null ? '' : Number(cfg[clave]) * 100, placeholder: String(margenObjetivo(cfg) * 100) }), h('span', '%')));
  });
  const form = h('form.formulario', h('label', { for: 'margen-general' }, 'Margen objetivo general'),
    h('div.campo-porcentaje', general, h('span', '%')), h('p.ayuda', 'Las familias sin valor propio usan el margen general.'), campos);
  await dialogo('Márgenes por familia', form, [{ texto: 'Cancelar', valor: false }, { texto: 'Guardar', clase: 'primario', valor: async () => {
    if (!form.reportValidity()) return undefined;
    const config = { ...cfg, margen_ideal: Number(general.value) / 100 };
    familias.forEach((familia, i) => {
      const clave = claveMargenFamilia(familia); const valor = form.querySelector(`#margen-${i}`).value;
      if (valor === '') delete config[clave]; else config[clave] = Number(valor) / 100;
    });
    const ok = await accion(null, async () => { await api.guardarEmpresa(app.org, { config }); return true; });
    if (!ok) return undefined;
    aviso('Márgenes guardados', 'ok'); await app.recargar(); window.dispatchEvent(new HashChangeEvent('hashchange')); return true;
  }}]);
}

export async function vistaProveedores(app) {
  const [proveedores, precios] = await Promise.all([api.proveedores(app.org), api.preciosProveedor(app.org)]);
  const buscar = h('input', { type: 'search', placeholder: 'Buscar proveedor…', 'aria-label': 'Buscar proveedores' });
  const contenido = h('div');
  const pintar = () => {
    const q = buscar.value.trim().toLowerCase();
    const filas = proveedores.filter(p => !q || `${p.codigo} ${p.nombre} ${p.contacto || ''}`.toLowerCase().includes(q));
    contenido.replaceChildren(filas.length ? h('table.tabla', h('thead', h('tr', h('th', 'Código'), h('th', 'Proveedor'), h('th', 'Contacto'), h('th.num', 'Precios'), h('th', 'Web'))),
      h('tbody', filas.map(p => h('tr', h('td', h('strong', p.codigo)), h('td', p.nombre), h('td', p.contacto || p.email || p.telefono || '—'),
        h('td.num', String(precios.filter(x => x.proveedor_id === p.id).length)), h('td', p.web ? h('a', { href: p.web, target: '_blank', rel: 'noopener' }, 'Abrir') : '—'))))) : h('p.vacio', 'No hay proveedores con ese filtro.'));
  };
  buscar.addEventListener('input', pintar); pintar();
  const ultimos = precios.slice(0, 20);
  return h('section.pila', h('div.cab', h('div', h('a.volver', { href: '#/facturacion' }, '‹ Facturación'), h('h1', 'Proveedores y precios')), h('a.btn', { href: '#/ajustes/importar-maestros' }, 'Importar desde v7')),
    h('div.tarjeta.filtros', buscar), h('div.tarjeta', contenido),
    h('div.tarjeta', h('h2', 'Últimos precios'), ultimos.length ? h('table.tabla', h('thead', h('tr', h('th', 'Fecha'), h('th', 'Producto'), h('th', 'Proveedor'), h('th.num', 'Precio sin IGIC'))),
      h('tbody', ultimos.map(x => h('tr', h('td', fecha(x.fecha)), h('td', x.productos?.codigo || ''), h('td', x.proveedores?.nombre || ''), h('td.num', eur(x.precio)))))) : h('p.vacio', 'Todavía no hay precios registrados.')));
}
