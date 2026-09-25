import { api } from '../api.js';
import { h, accion, aviso, dialogo, posicion, hoyISO, sumarDias, preferencia } from '../ui.js';
import { direccionCompleta, wazeUrl, mapsUrl, tieneDestino } from '../lib/mapas.js';
import { fmtMin } from '../lib/jornada.js';

const puedeEditar = rol => ['propietario', 'admin', 'responsable'].includes(rol);

export async function vistaClientes(app) {
  const clientes = await api.clientes(app.org);
  const localidades = [...new Set(clientes.map(c => c.municipio || c.localidad).filter(Boolean))].sort();
  const buscar = h('input', { type: 'search', placeholder: 'Buscar por nombre, NIF, teléfono o dirección…', 'aria-label': 'Buscar', value: preferencia('cli-q') || '' });
  const filtroLoc = h('select', { 'aria-label': 'Municipio' }, h('option', { value: '' }, 'Todos los municipios'), localidades.map(l => h('option', { value: l }, l)));
  const filtroEstado = h('select', { 'aria-label': 'Estado' }, h('option', { value: 'activos' }, 'Activos'), h('option', { value: 'todos' }, 'Todos'), h('option', { value: 'sinubic' }, 'Sin ubicación GPS'));
  const lista = h('div.lista');
  const contador = h('span.ayuda');

  const pintar = () => {
    preferencia('cli-q', buscar.value);
    const q = buscar.value.toLowerCase().trim();
    const r = clientes.filter(c =>
      (!q || [c.nombre, c.codigo, c.telefono, c.email, direccionCompleta(c)].join(' ').toLowerCase().includes(q)) &&
      (!filtroLoc.value || (c.municipio || c.localidad) === filtroLoc.value) &&
      (filtroEstado.value === 'todos' || (filtroEstado.value === 'activos' ? c.activo !== false : !(c.lat && c.lng))));
    contador.textContent = `${r.length} de ${clientes.length}`;
    lista.replaceChildren(...(r.length ? r.map(c => h('div.item', { role: 'link', tabIndex: 0,
        onclick: () => { location.hash = '#/clientes/' + c.id; }, onkeydown: e => { if (e.key === 'Enter') location.hash = '#/clientes/' + c.id; } },
      h('div', h('strong', c.nombre), c.activo === false ? h('span.etiqueta', 'inactivo') : null, h('small', direccionCompleta(c) || 'Sin dirección')),
      tieneDestino(c) ? h('span.acciones-rapidas',
        h('a.mini', { href: wazeUrl(c), target: '_blank', rel: 'noopener', onclick: e => e.stopPropagation(), title: 'Waze' }, 'Waze'),
        h('a.mini', { href: mapsUrl(c), target: '_blank', rel: 'noopener', onclick: e => e.stopPropagation(), title: 'Google Maps' }, 'Maps')) : null))
      : [h('p.vacio', clientes.length ? 'Ningún cliente coincide con el filtro.' : 'Aún no hay clientes.')]));
  };
  [buscar, filtroLoc, filtroEstado].forEach(x => x.addEventListener('input', pintar));
  pintar();

  return h('section.pila',
    h('div.cab', h('h1', 'Clientes'), puedeEditar(app.rol) ? h('button.btn.primario', { onclick: () => editar(app, {}) }, '+ Nuevo') : null),
    h('div.filtros', buscar, filtroLoc, filtroEstado, contador),
    lista);
}

export async function vistaCliente(app, id) {
  const clientes = await api.clientes(app.org);
  const c = clientes.find(x => x.id === id);
  if (!c) return h('p.vacio', 'Cliente no encontrado.');
  const hoy = hoyISO(app.tz), desde = sumarDias(hoy, -30);
  const tr = (await api.tramos(app.org, desde, hoy).catch(() => [])).filter(t => t.cliente_id === id);
  const min = tipo => tr.filter(t => t.tipo === tipo).reduce((s, t) => s + t.minutos, 0);
  const tel = (c.telefono || '').replace(/[^\d+]/g, '');

  return h('section.pila',
    h('a.volver', { href: '#/clientes' }, '← Clientes'),
    h('div.tarjeta',
      h('h1', c.nombre),
      h('p', direccionCompleta(c) || h('span.ayuda', 'Sin dirección')),
      c.lat && c.lng ? h('p.ayuda', `📍 Ubicación GPS guardada (${Number(c.lat).toFixed(5)}, ${Number(c.lng).toFixed(5)})`) : null,
      h('div.fila-botones',
        tieneDestino(c) ? h('a.btn.primario', { href: wazeUrl(c), target: '_blank', rel: 'noopener' }, 'Ir con Waze') : null,
        tieneDestino(c) ? h('a.btn', { href: mapsUrl(c), target: '_blank', rel: 'noopener' }, 'Ir con Google Maps') : null,
        tel ? h('a.btn', { href: 'tel:' + tel }, 'Llamar') : null,
        c.email ? h('a.btn', { href: 'mailto:' + c.email }, 'Email') : null),
      h('button.btn.enlace', {
        onclick: e => accion(e.currentTarget, async () => {
          const p = await posicion(10000);
          if (!p) throw new Error('No se pudo obtener tu ubicación. Revisa el permiso de localización.');
          if (!confirm(`¿Guardar tu posición actual (precisión ±${p.precision} m) como ubicación de ${c.nombre}?`)) return;
          await api.fijarUbicacion(c.id, p.lat, p.lng); aviso('Ubicación guardada', 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange'));
        }),
      }, '📍 Estoy aquí: guardar esta ubicación')),
    h('div.tarjeta',
      h('h2', 'Últimos 30 días'),
      h('div.totales',
        h('div', h('small', 'Trabajo'), h('strong', fmtMin(min('TRABAJO')))),
        h('div', h('small', 'Desplazamientos'), h('strong', fmtMin(min('DESPLAZAMIENTO')))),
        h('div', h('small', 'Km (línea recta)'), h('strong', tr.reduce((s, t) => s + (Number(t.km) || 0), 0).toLocaleString('es-ES', { maximumFractionDigits: 1 })))),
      app.facturacion ? h('a.btn', { href: '#/facturacion/' + c.id }, 'Facturar horas pendientes') : null),
    h('div.tarjeta',
      h('h2', 'Datos'),
      h('dl.datos',
        [['NIF', c.codigo], ['Tipo', c.tipo], ['Teléfono', c.telefono], ['Email', c.email], ['Idioma', c.idioma], ['Notas', c.notas]]
          .map(([k, v]) => v ? [h('dt', k), h('dd', v)] : null)),
      puedeEditar(app.rol) ? h('button.btn', { onclick: () => editar(app, c) }, 'Editar') : null));
}

async function editar(app, c) {
  const campo = (k, etiqueta, attrs = {}) => {
    const i = h('input', { id: 'f-' + k, value: c[k] ?? '', ...attrs });
    return [h('label', { for: 'f-' + k }, etiqueta), i];
  };
  const form = h('form.formulario',
    campo('nombre', 'Nombre *', { required: true }),
    campo('codigo', 'NIF / código *', { required: true }),
    campo('direccion', 'Dirección'),
    h('div.dos', h('div', campo('cp', 'CP')), h('div', campo('localidad', 'Localidad'))),
    h('div.dos', h('div', campo('municipio', 'Municipio')), h('div', campo('provincia', 'Provincia'))),
    campo('telefono', 'Teléfono', { type: 'tel' }),
    campo('email', 'Email', { type: 'email' }),
    h('label', { for: 'f-notas' }, 'Notas'), h('textarea', { id: 'f-notas', rows: 2, value: c.notas || '' }),
    h('label.check', h('input', { type: 'checkbox', id: 'f-activo', checked: c.activo !== false }), ' Activo'));
  await dialogo(c.id ? 'Editar cliente' : 'Nuevo cliente', form, [
    { texto: 'Cancelar', valor: false },
    {
      texto: 'Guardar', clase: 'primario', valor: async () => {
        if (!form.reportValidity()) return undefined;
        const v = k => form.querySelector('#f-' + k).value.trim() || null;
        const datos = { id: c.id, nombre: v('nombre'), codigo: v('codigo').toUpperCase(), direccion: v('direccion'), cp: v('cp'), localidad: v('localidad'),
          municipio: v('municipio'), provincia: v('provincia'), telefono: v('telefono'), email: v('email'), notas: v('notas'), activo: form.querySelector('#f-activo').checked };
        const ok = await accion(null, async () => { await api.guardarCliente(app.org, datos); return true; });
        if (!ok) return undefined;
        aviso('Cliente guardado', 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange')); return true;
      },
    }]);
}
