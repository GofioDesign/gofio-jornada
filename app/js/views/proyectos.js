import { api } from '../api.js';
import { h, accion, aviso, dialogo, fecha, hoyISO, sumarDias, preferencia } from '../ui.js';
import { fmtMin } from '../lib/jornada.js';

const puedeEditar = rol => ['propietario', 'admin', 'responsable'].includes(rol);
const TIPOS = { PROPIO: 'Propio', AJENO: 'Ajeno' };

export async function vistaProyectos(app) {
  const [proyectos, clientes] = await Promise.all([api.proyectos(app.org), api.clientes(app.org)]);
  const cli = id => clientes.find(c => c.id === id)?.nombre;
  const buscar = h('input', { type: 'search', placeholder: 'Buscar por nombre o cliente…', 'aria-label': 'Buscar', value: preferencia('pro-q') || '' });
  const filtroTipo = h('select', { 'aria-label': 'Tipo' }, h('option', { value: '' }, 'Propios y ajenos'), h('option', { value: 'PROPIO' }, 'Propios'), h('option', { value: 'AJENO' }, 'Ajenos'));
  const filtroEstado = h('select', { 'aria-label': 'Estado' }, h('option', { value: 'activos' }, 'Abiertos'), h('option', { value: 'todos' }, 'Todos'), h('option', { value: 'sincliente' }, 'Sin cliente'));
  const lista = h('div.lista');
  const contador = h('span.ayuda');

  const pintar = () => {
    preferencia('pro-q', buscar.value);
    const q = buscar.value.toLowerCase().trim();
    const r = proyectos.filter(p =>
      (!q || [p.nombre, cli(p.cliente_id), p.notas].join(' ').toLowerCase().includes(q)) &&
      (!filtroTipo.value || p.tipo === filtroTipo.value) &&
      (filtroEstado.value === 'todos' || (filtroEstado.value === 'activos' ? p.activo !== false : !p.cliente_id)));
    contador.textContent = `${r.length} de ${proyectos.length}`;
    lista.replaceChildren(...(r.length ? r.map(p => h('div.item', { role: 'link', tabIndex: 0,
        onclick: () => { location.hash = '#/proyectos/' + p.id; }, onkeydown: e => { if (e.key === 'Enter') location.hash = '#/proyectos/' + p.id; } },
      h('div', h('strong', p.nombre), h('span.etiqueta', TIPOS[p.tipo] || p.tipo), p.activo === false ? h('span.etiqueta', 'cerrado') : null,
        h('small', cli(p.cliente_id) || 'Sin cliente')),
      puedeEditar(app.rol) ? h('button.btn.mini', { type: 'button', onkeydown: e => e.stopPropagation(), onclick: e => { e.stopPropagation(); editar(app, p, clientes); } }, 'Editar') : null))
      : [h('p.vacio', proyectos.length ? 'Ningún proyecto coincide con el filtro.' : 'Aún no hay proyectos.')]));
  };
  [buscar, filtroTipo, filtroEstado].forEach(x => x.addEventListener('input', pintar));
  pintar();

  return h('section.pila',
    h('div.cab', h('h1', 'Proyectos'), puedeEditar(app.rol) ? h('button.btn.primario', { onclick: () => editar(app, {}, clientes) }, '+ Nuevo') : null),
    h('div.filtros', buscar, filtroTipo, filtroEstado, contador),
    lista);
}

export async function vistaProyecto(app, id) {
  const [proyectos, clientes] = await Promise.all([api.proyectos(app.org), api.clientes(app.org)]);
  const p = proyectos.find(x => x.id === id);
  if (!p) return h('p.vacio', 'Proyecto no encontrado.');
  const c = clientes.find(x => x.id === p.cliente_id);
  const hoy = hoyISO(app.tz);
  // Último año (las horas se pueden asignar a posteriori, también antes de crear el proyecto)
  const [tr, miembros] = await Promise.all([
    api.tramos(app.org, sumarDias(hoy, -365), hoy).catch(() => []),
    puedeEditar(app.rol) ? api.miembros(app.org).catch(() => []) : [],
  ]);
  const mios = tr.filter(t => t.tipo === 'TRABAJO' && t.proyecto_id === id);
  const total = mios.reduce((s, t) => s + t.minutos, 0);
  const suma = clave => Object.entries(mios.reduce((o, t) => ({ ...o, [t[clave]]: (o[t[clave]] || 0) + t.minutos }), {}));
  const nombre = u => miembros.find(m => m.user_id === u)?.nombre || (u === app.e.user_id ? 'Tú' : 'Sin nombre');
  const porPersona = suma('user_id').sort((a, b) => b[1] - a[1]);
  const porDia = suma('dia').sort((a, b) => b[0].localeCompare(a[0]));

  return h('section.pila',
    h('a.volver', { href: '#/proyectos' }, '← Proyectos'),
    h('div.tarjeta',
      h('h1', p.nombre),
      h('p', h('span.etiqueta', TIPOS[p.tipo] || p.tipo), p.activo === false ? h('span.etiqueta', 'cerrado') : null),
      h('p', 'Cliente: ', c ? h('a', { href: '#/clientes/' + c.id }, c.nombre) : h('span.ayuda', 'sin cliente')),
      p.notas ? h('p.ayuda', p.notas) : null,
      puedeEditar(app.rol) ? h('button.btn', { onclick: () => editar(app, p, clientes) }, 'Editar') : null),
    h('div.tarjeta',
      h('h2', puedeEditar(app.rol) ? 'Horas del proyecto (último año)' : 'Tus horas en el proyecto (último año)'),
      h('div.totales', h('div', h('small', 'Trabajo'), h('strong', fmtMin(total))), h('div', h('small', 'Días'), h('strong', String(porDia.length)))),
      porPersona.length > 1 ? h('table.tabla', h('tbody', porPersona.map(([u, m]) => h('tr', h('td', nombre(u)), h('td', fmtMin(m)))))) : null,
      porDia.length ? h('table.tabla', h('thead', h('tr', h('th', 'Día'), h('th', 'Trabajo'))),
        h('tbody', porDia.slice(0, 31).map(([d, m]) => h('tr', h('td', fecha(d)), h('td', fmtMin(m))))))
        : h('p.vacio', 'Todavía no hay horas en este proyecto. Elígelo al fichar o asígnalo a un tramo desde Jornada.')));
}

/** Alta o edición de un proyecto. Devuelve el proyecto guardado, o null si se cancela. */
export async function editar(app, p, clientes, { recargar = true } = {}) {
  const nombre = h('input', { id: 'p-nombre', required: true, value: p.nombre || '' });
  const tipo = h('select', { id: 'p-tipo' }, Object.entries(TIPOS).map(([v, t]) => h('option', { value: v, selected: (p.tipo || 'PROPIO') === v }, t)));
  const cliente = h('select', { id: 'p-cliente' }, h('option', { value: '' }, 'Sin cliente'),
    clientes.filter(c => c.activo !== false || c.id === p.cliente_id).map(c => h('option', { value: c.id, selected: c.id === p.cliente_id }, c.nombre)));
  const notas = h('textarea', { id: 'p-notas', rows: 2, value: p.notas || '' });
  const activo = h('input', { type: 'checkbox', id: 'p-activo', checked: p.activo !== false });
  const form = h('form.formulario',
    h('label', { for: 'p-nombre' }, 'Nombre *'), nombre,
    h('label', { for: 'p-tipo' }, 'Tipo'), tipo,
    h('p.ayuda', 'Propio: de tu empresa. Ajeno: de un tercero para el que trabajas.'),
    h('label', { for: 'p-cliente' }, 'Cliente'), cliente,
    h('p.ayuda', 'Si tiene cliente, las horas del proyecto cuentan también como horas de ese cliente.'),
    p.id ? h('p.ayuda', 'Si cambias el cliente, las horas que se fichen desde ahora irán al nuevo. Las ya fichadas siguen con el cliente que tenían, porque el registro de jornada no se modifica.') : null,
    h('label', { for: 'p-notas' }, 'Notas'), notas,
    h('label.check', activo, ' Abierto (se puede elegir al fichar)'));
  return dialogo(p.id ? 'Editar proyecto' : 'Nuevo proyecto', form, [
    { texto: 'Cancelar', valor: false },
    {
      texto: 'Guardar', clase: 'primario', valor: async () => {
        if (!form.reportValidity()) return undefined;
        const datos = { id: p.id, nombre: nombre.value.trim(), tipo: tipo.value, cliente_id: cliente.value || null, notas: notas.value.trim() || null, activo: activo.checked };
        const guardado = await accion(null, () => api.guardarProyecto(app.org, datos));
        if (!guardado) return undefined;
        aviso('Proyecto guardado', 'ok');
        if (recargar) window.dispatchEvent(new HashChangeEvent('hashchange'));
        return guardado;
      },
    }]);
}
