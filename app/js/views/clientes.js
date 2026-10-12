import { api } from '../api.js';
import { h, montar, accion, aviso, dialogo, posicion, hoyISO, sumarDias, preferencia, eur } from '../ui.js';
import { direccionCompleta, wazeUrl, mapsUrl, tieneDestino } from '../lib/mapas.js';
import { fmtMin } from '../lib/jornada.js';
import { parseCSV, toCSV, descargar } from '../lib/csv.js';
import { clientesDesdeCSV, CABECERAS_CLIENTES } from '../lib/personal.js';
import { preciosHora } from '../lib/nomina.js';

export const TIPOS_CLIENTE = { PARTICULAR: 'Particular', AUTONOMO: 'Profesional / autónomo', EMPRESA: 'Empresa', ADMINISTRACION: 'Administración pública' };

// «Me paga por nómina» se elige como un tipo más; en la base es una empresa con por_nomina = true.
const NOMINA = 'NOMINA';
const OPCIONES_TIPO = { ...TIPOS_CLIENTE, [NOMINA]: 'Me paga por nómina (no se factura)' };
const tipoDe = c => c.por_nomina ? NOMINA : (c.tipo || 'PARTICULAR');

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
      h('div', h('strong', c.nombre), h('span.etiqueta', c.por_nomina ? 'por nómina' : c.tipo === 'PARTICULAR' || !c.tipo ? 'particular' : 'profesional'), c.activo === false ? h('span.etiqueta', 'inactivo') : null, h('small', direccionCompleta(c) || 'Sin dirección')),
      tieneDestino(c) ? h('span.acciones-rapidas',
        h('a.mini', { href: wazeUrl(c), target: '_blank', rel: 'noopener', onclick: e => e.stopPropagation(), title: 'Waze' }, 'Waze'),
        h('a.mini', { href: mapsUrl(c), target: '_blank', rel: 'noopener', onclick: e => e.stopPropagation(), title: 'Google Maps' }, 'Maps')) : null))
      : [h('p.vacio', clientes.length ? 'Ningún cliente coincide con el filtro.' : 'Aún no hay clientes.')]));
  };
  [buscar, filtroLoc, filtroEstado].forEach(x => x.addEventListener('input', pintar));
  pintar();

  return h('section.pila',
    h('div.cab', h('h1', 'Clientes'), puedeEditar(app.rol) ? h('span.fila-botones', h('button.btn', { onclick: () => importar(app, clientes) }, 'Importar CSV'), h('button.btn.primario', { onclick: () => editar(app, {}) }, '+ Nuevo')) : null),
    h('div.filtros', buscar, filtroLoc, filtroEstado, contador),
    lista);
}

export async function vistaCliente(app, id) {
  const clientes = await api.clientes(app.org);
  const c = clientes.find(x => x.id === id);
  if (!c) return h('p.vacio', 'Cliente no encontrado.');
  const hoy = hoyISO(app.tz), desde = sumarDias(hoy, -30);
  const [tramos, proyectos] = await Promise.all([api.tramos(app.org, desde, hoy).catch(() => []), api.proyectos(app.org).catch(() => [])]);
  const tr = tramos.filter(t => t.cliente_id === id);
  const suyos = proyectos.filter(p => p.cliente_id === id);
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
      app.facturacion && !c.por_nomina ? h('a.btn', { href: '#/facturacion/' + c.id }, 'Facturar horas pendientes') : null),
    c.por_nomina ? await tarjetaNominas(app, c) : null,
    suyos.length ? h('div.tarjeta',
      h('h2', 'Proyectos'),
      h('div.lista', suyos.map(p => h('a.item', { href: '#/proyectos/' + p.id },
        h('div', h('strong', p.nombre), p.activo === false ? h('span.etiqueta', 'cerrado') : null))))) : null,
    h('div.tarjeta',
      h('h2', 'Datos'),
      h('dl.datos',
        [['NIF', c.codigo], ['Tipo', OPCIONES_TIPO[tipoDe(c)] || c.tipo], ['Retención IRPF', c.aplica_irpf ? (c.irpf_pct != null ? `${c.irpf_pct} %` : 'Sí (la de la empresa)') : null], ['Teléfono', c.telefono], ['Email', c.email], ['Idioma', c.idioma], ['Notas', c.notas]]
          .map(([k, v]) => v ? [h('dt', k), h('dd', v)] : null)),
      puedeEditar(app.rol) ? h('button.btn', { onclick: () => editar(app, c) }, 'Editar') : null));
}

/** Nóminas de quien mira (cada persona solo ve las suyas) con el precio hora de cada mes. */
async function tarjetaNominas(app, c) {
  const hoy = hoyISO(app.tz), yo = app.e.user_id;
  const desde = sumarDias(hoy.slice(0, 8) + '01', -365).slice(0, 8) + '01';
  const [nominas, tramos] = await Promise.all([api.nominas(app.org).catch(() => []), api.tramos(app.org, desde, hoy, yo).catch(() => [])]);
  const filas = preciosHora(nominas.filter(n => n.user_id === yo), tramos, c.id, yo);
  const mesTxt = mes => new Date(mes.slice(0, 7) + '-15T12:00:00').toLocaleDateString('es-ES', { month: 'short', year: 'numeric' });
  const porHora = v => v == null ? '—' : eur(v) + '/h';
  return h('div.tarjeta',
    h('h2', 'Nóminas'),
    h('p.ayuda', 'Apunta lo que cobras cada mes y verás tu precio hora real con las horas que fichaste para este cliente. Solo lo ves tú.'),
    filas.length ? h('table.tabla',
      h('thead', h('tr', h('th', 'Mes'), h('th.num', 'Horas'), h('th.num', 'Nómina'), h('th.num', 'Precio hora'))),
      h('tbody', filas.map(n => h('tr', { role: 'button', tabIndex: 0, title: 'Editar', style: 'cursor:pointer',
          onclick: () => editarNomina(app, c, n), onkeydown: e => { if (e.key === 'Enter') editarNomina(app, c, n); } },
        h('td', mesTxt(n.mes)), h('td.num', fmtMin(n.minutos)),
        h('td.num', n.bruto != null ? h('div', eur(n.bruto), h('small', ' bruto')) : null, n.neto != null ? h('div', eur(n.neto), h('small', ' neto')) : null),
        h('td.num', n.bruto != null ? h('div', h('strong', porHora(n.bruto_hora)), h('small', ' bruto')) : null,
          n.neto != null ? h('div', h('strong', porHora(n.neto_hora)), h('small', ' neto')) : null))))) : h('p.vacio', 'Aún no has apuntado ninguna nómina.'),
    filas.length ? h('p.ayuda', 'Toca un mes para cambiarlo o borrarlo. Sin horas fichadas ese mes no se puede calcular el precio hora.') : null,
    h('button.btn', { onclick: () => editarNomina(app, c, { mes: hoy.slice(0, 8) + '01' }) }, '+ Apuntar nómina'));
}

async function editarNomina(app, c, n) {
  const mes = h('input', { id: 'n-mes', type: 'month', required: true, value: (n.mes || '').slice(0, 7) });
  const importe = (id, v) => h('input', { id, type: 'number', min: 0, step: '0.01', inputMode: 'decimal', value: v ?? '' });
  const bruto = importe('n-bruto', n.bruto), neto = importe('n-neto', n.neto);
  const form = h('form.formulario',
    h('label', { for: 'n-mes' }, 'Mes *'), mes,
    h('div.dos', h('div', h('label', { for: 'n-bruto' }, 'Bruto (€)'), bruto), h('div', h('label', { for: 'n-neto' }, 'Neto (€)'), neto)),
    h('p.ayuda', 'Con uno de los dos basta. Si ese mes ya tenía nómina, se sustituye.'));
  const recargar = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const botones = [{ texto: 'Cancelar', valor: false }];
  if (n.id) botones.push({ texto: 'Eliminar', valor: async () => {
    if (!confirm('¿Eliminar esta nómina?')) return undefined;
    if (!await accion(null, async () => { await api.borrarNomina(n.id); return true; })) return undefined;
    aviso('Nómina eliminada', 'ok'); recargar(); return true;
  } });
  botones.push({ texto: 'Guardar', clase: 'primario', valor: async () => {
    if (!form.reportValidity()) return undefined;
    const num = i => i.value === '' ? null : Number(i.value);
    if (num(bruto) == null && num(neto) == null) { aviso('Pon el bruto, el neto o los dos', 'error'); return undefined; }
    const datos = { cliente_id: c.id, user_id: app.e.user_id, mes: mes.value + '-01', bruto: num(bruto), neto: num(neto) };
    const hecho = await accion(null, async () => {
      await api.guardarNomina(app.org, datos);
      if (n.id && n.mes !== datos.mes) await api.borrarNomina(n.id);   // se cambió de mes: no dejar la anterior
      return true;
    });
    if (!hecho) return undefined;
    aviso('Nómina guardada', 'ok'); recargar(); return true;
  } });
  return dialogo(n.id ? 'Editar nómina' : 'Apuntar nómina', form, botones);
}

/** Alta o edición de un cliente. Devuelve el cliente guardado, o null si se cancela. */
export async function editar(app, c, { recargar = true } = {}) {
  const campo = (k, etiqueta, attrs = {}) => {
    const i = h('input', { id: 'f-' + k, value: c[k] ?? '', ...attrs });
    return [h('label', { for: 'f-' + k }, etiqueta), i];
  };
  // Particular y por nómina: nunca se les retiene IRPF (al de nómina no se le factura).
  // Al pasar a profesional se propone aplicarla (se puede desmarcar).
  const sinIrpf = () => tipo.value === 'PARTICULAR' || tipo.value === NOMINA;
  const tipo = h('select', { id: 'f-tipo', onchange: () => { aplicaIrpf.checked = !sinIrpf(); sincronizarIrpf(); } },
    Object.entries(OPCIONES_TIPO).map(([v, t]) => h('option', { value: v, selected: tipoDe(c) === v }, t)));
  const aplicaIrpf = h('input', { type: 'checkbox', id: 'f-aplica_irpf', checked: !!c.aplica_irpf, onchange: () => sincronizarIrpf() });
  const irpfPct = h('input', { id: 'f-irpf_pct', type: 'number', min: 0, max: 50, step: 0.5, value: c.irpf_pct ?? '', placeholder: 'el de la empresa' });
  const sincronizarIrpf = () => {
    if (sinIrpf()) aplicaIrpf.checked = false;
    aplicaIrpf.disabled = sinIrpf();
    irpfPct.disabled = !aplicaIrpf.checked;
  };
  sincronizarIrpf();
  const form = h('form.formulario',
    campo('nombre', 'Nombre *', { required: true }),
    campo('codigo', 'NIF / código *', { required: true }),
    h('div.dos', h('div', h('label', { for: 'f-tipo' }, 'Tipo de cliente'), tipo),
      h('div', h('label', { for: 'f-irpf_pct' }, 'Retención IRPF (%)'), irpfPct)),
    h('label.check', aplicaIrpf, ' Aplicar retención IRPF en sus facturas'),
    campo('direccion', 'Dirección'),
    h('div.dos', h('div', campo('cp', 'CP')), h('div', campo('localidad', 'Localidad'))),
    h('div.dos', h('div', campo('municipio', 'Municipio')), h('div', campo('provincia', 'Provincia'))),
    campo('telefono', 'Teléfono', { type: 'tel' }),
    campo('email', 'Email', { type: 'email' }),
    h('label', { for: 'f-notas' }, 'Notas'), h('textarea', { id: 'f-notas', rows: 2, value: c.notas || '' }),
    h('label.check', h('input', { type: 'checkbox', id: 'f-activo', checked: c.activo !== false }), ' Activo'));
  return dialogo(c.id ? 'Editar cliente' : 'Nuevo cliente', form, [
    { texto: 'Cancelar', valor: false },
    {
      texto: 'Guardar', clase: 'primario', valor: async () => {
        if (!form.reportValidity()) return undefined;
        const v = k => form.querySelector('#f-' + k).value.trim() || null;
        const datos = { id: c.id, nombre: v('nombre'), codigo: v('codigo').toUpperCase(), direccion: v('direccion'), cp: v('cp'), localidad: v('localidad'),
          municipio: v('municipio'), provincia: v('provincia'), telefono: v('telefono'), email: v('email'), notas: v('notas'),
          tipo: tipo.value !== NOMINA ? tipo.value : c.tipo && c.tipo !== 'PARTICULAR' ? c.tipo : 'EMPRESA', por_nomina: tipo.value === NOMINA, aplica_irpf: aplicaIrpf.checked, irpf_pct: aplicaIrpf.checked && irpfPct.value !== '' ? Number(irpfPct.value) : null, activo: form.querySelector('#f-activo').checked };
        const guardado = await accion(null, () => api.guardarCliente(app.org, datos));
        if (!guardado) return undefined;
        aviso('Cliente guardado', 'ok');
        if (recargar) window.dispatchEvent(new HashChangeEvent('hashchange'));
        return guardado;
      },
    }]);
}

/** Caja para elegir un CSV de clientes: muestra cuántos se importarán y los errores. clientes() da las filas listas. */
export function cajaCSVClientes(existentes = []) {
  let listos = [];
  const resumen = h('p.ayuda', 'Columnas: nombre (obligatoria), nif, tipo, email, telefono, direccion, cp, localidad, municipio, provincia. Separador ; o ,');
  const archivo = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'Archivo CSV de clientes',
    onchange: async () => {
      const f = archivo.files[0]; listos = [];
      if (!f) return;
      const { clientes, errores } = clientesDesdeCSV(parseCSV(await f.text()), existentes);
      listos = clientes;
      montar(resumen, h('strong', clientes.length === 1 ? '1 cliente listo para importar.' : `${clientes.length} clientes listos para importar.`),
        errores.length ? h('span', ` ${errores.length === 1 ? '1 fila no se importa' : errores.length + ' filas no se importan'}: ${errores.slice(0, 3).join('; ')}${errores.length > 3 ? '…' : ''}`) : null,
        clientes.some(c => c.codigo.startsWith('SIN-NIF')) ? h('span', ' Los que no traen NIF quedan con un código provisional (SIN-NIF-…) que puedes cambiar después.') : null);
    } });
  const plantilla = h('button.btn.enlace', { type: 'button', onclick: () => descargar('plantilla-clientes.csv', toCSV([
    { nombre: 'Casa María', nif: '12345678Z', tipo: 'particular', email: 'maria@ejemplo.com', telefono: '600000000', direccion: 'C/ Real 1', cp: '38500', localidad: 'Güímar', municipio: 'Güímar', provincia: 'S/C de Tenerife' },
    { nombre: 'Construcciones Norte SL', nif: 'B00000000', tipo: 'empresa', email: '', telefono: '', direccion: '', cp: '', localidad: '', municipio: '', provincia: '' },
  ], CABECERAS_CLIENTES)) }, 'Descargar plantilla');
  return { nodo: h('div.csv-clientes', archivo, plantilla, resumen), clientes: () => listos };
}

async function importar(app, existentes) {
  const caja = cajaCSVClientes(existentes);
  const hecho = await dialogo('Importar clientes', caja.nodo, [
    { texto: 'Cancelar', valor: false },
    { texto: 'Importar', clase: 'primario', valor: async () => {
      const filas = caja.clientes();
      if (!filas.length) { aviso('Elige un CSV con al menos un cliente', 'error'); return undefined; }
      const r = await accion(null, () => api.importarClientes(app.org, filas));
      if (!r) return undefined;
      aviso(filas.length === 1 ? '1 cliente importado' : `${filas.length} clientes importados`, 'ok');
      return true;
    } }]);
  if (hecho) window.dispatchEvent(new HashChangeEvent('hashchange'));
}
