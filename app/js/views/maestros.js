import { api } from '../api.js';
import { h, eur, fecha } from '../ui.js';

export async function vistaProductos(app) {
  const productos = await api.catalogoProductos(app.org);
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
      h('tbody', filas.map(p => h('tr', h('td', h('strong', p.codigo)), h('td', p.descripcion), h('td', p.familia),
        h('td.num', eur(p.coste_ud)), h('td.num', eur(p.pvp)), h('td', p.mejor_proveedor ? `${p.mejor_proveedor} · ${eur(p.mejor_precio)}` : '—'),
        h('td', h('span.etiqueta', p.activo ? 'Activo' : 'Inactivo')))))) : h('p.vacio', 'No hay productos con esos filtros.'));
  };
  [buscar, familia, estado].forEach(x => x.addEventListener('input', pintar)); pintar();
  return h('section.pila', h('div.cab', h('div', h('a.volver', { href: '#/facturacion' }, '‹ Facturación'), h('h1', 'Productos')), h('a.btn', { href: '#/ajustes/importar-maestros' }, 'Importar desde v7')),
    h('div.tarjeta.filtros', buscar, familia, estado), h('div.tarjeta', contenido));
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
