// Borrador de factura: editor de líneas con vista previa del documento. Nada es definitivo
// hasta «Emitir factura»: entonces el servidor numera, calcula, congela los datos y encadena la huella.
import { api } from '../api.js';
import { h, montar, accion, aviso, eur, hoyISO, sumarDias } from '../ui.js';
import { calcular, irpfCliente, emisorDe } from '../lib/factura.js';
import { documento, imprimir, TXT } from './factura.js';

export async function vistaBorrador(app, id) {
  const nuevo = !id || id === 'nuevo';
  const [clientes, b] = await Promise.all([api.clientes(app.org), nuevo ? null : api.borrador(app.org, id)]);
  if (!nuevo && !b) return h('p.vacio', 'Borrador no encontrado.');
  const cfg = app.e.config || {};
  const igicDefecto = Number(cfg.igic_defecto ?? 7);
  const d = structuredClone(b?.datos || {});
  let borradorId = b?.id || null;
  const lineaVacia = () => ({ descripcion: '', cantidad: 1, unidad: 'ud', pvp: 0, dto: 0, igic: igicDefecto });
  const lineas = d.lineas?.length ? d.lineas : [lineaVacia()];

  const cliente = h('select', { id: 'b-cliente', onchange: () => { if (!irpfTocado) irpf.value = irpfCliente(cli(), cfg); idioma.value = cli()?.idioma === 'EN' ? 'EN' : 'ES'; previa(); } },
    h('option', { value: '' }, 'Elige cliente…'), clientes.filter(c => c.activo !== false || c.id === b?.cliente_id).map(c => h('option', { value: c.id }, c.nombre)));
  cliente.value = b?.cliente_id || '';
  const cli = () => clientes.find(c => c.id === cliente.value);
  const fecha = h('input', { id: 'b-fecha', type: 'date', value: d.fecha || hoyISO(app.tz), onchange: () => previa() });
  let irpfTocado = d.irpf_pct != null;
  const irpf = h('input', { id: 'b-irpf', type: 'number', min: 0, max: 50, step: 0.5, value: d.irpf_pct ?? irpfCliente(cli(), cfg),
    oninput: () => { irpfTocado = true; previa(); } });
  const obs = h('textarea', { id: 'b-obs', rows: 2, value: d.observaciones || '', oninput: () => previa() });
  const idioma = h('select', { 'aria-label': 'Idioma del PDF', onchange: () => previa() }, h('option', { value: 'ES' }, 'Español'), h('option', { value: 'EN' }, 'English'));
  idioma.value = cli()?.idioma === 'EN' ? 'EN' : 'ES';
  const editor = h('div.lineas-editor');
  const hoja = h('article.doc-factura');

  const validas = () => lineas.filter(l => String(l.descripcion || '').trim() || Number(l.pvp));
  const datos = () => ({ fecha: fecha.value, irpf_pct: Number(irpf.value) || 0, observaciones: obs.value.trim() || null, lineas: validas(),
                         desde: d.desde || null, hasta: d.hasta || null, horas: d.horas || null });

  const importes = [];
  const previa = () => {
    const t = calcular(validas(), irpf.value);
    const porLinea = calcular(lineas, 0).lineas;
    importes.forEach((el, i) => { el.textContent = eur(porLinea[i]?.base); });
    const f = { borrador: true, fecha: fecha.value, vencimiento: fecha.value && sumarDias(fecha.value, Number(cfg.dias_vencimiento ?? 30)),
      periodo_desde: d.desde, periodo_hasta: d.hasta, cliente: cli() || {}, emisor: emisorDe(app.e, t.igic_desglose),
      lineas: t.lineas.map(l => ({ descripcion: l.descripcion, cantidad: l.cantidad, unidad: l.unidad, pvp_ud: l.pvp, dto_pct: l.dto, igic_pct: l.igic, base: l.base })),
      base: t.base, igic: t.igic, igic_desglose: t.igic_desglose, irpf_pct: Number(irpf.value) || 0, irpf: t.irpf, total: t.total, observaciones: obs.value.trim() };
    montar(hoja, ...documento(f, TXT[idioma.value], app.e.logo_url));
  };

  const pintarLineas = () => {
    importes.length = 0;
    // Cada campo lleva su rótulo (visible solo en móvil; en escritorio lo da la fila de cabecera)
    const campo = (l, k, rotulo, attrs) => h('label.c-' + k, h('span.rotulo', rotulo),
      h('input', { ...attrs, value: l[k] ?? '', oninput: ev => { l[k] = attrs.type === 'number' ? (ev.target.value === '' ? '' : Number(ev.target.value)) : ev.target.value; previa(); } }));
    montar(editor,
      h('div.linea-ed.cabecera', { 'aria-hidden': 'true' }, ['Descripción', 'Cant.', 'Ud.', 'Precio €', 'Dto. %', 'IGIC %', 'Importe', ''].map(x => h('span', x))),
      lineas.map((l, i) => {
        const imp = h('span.importe'); importes.push(imp);
        return h('div.linea-ed',
          campo(l, 'descripcion', 'Descripción', { type: 'text', placeholder: 'Descripción' }),
          campo(l, 'cantidad', 'Cant.', { type: 'number', step: 'any', min: 0 }),
          campo(l, 'unidad', 'Ud.', { type: 'text' }),
          campo(l, 'pvp', 'Precio €', { type: 'number', step: '0.01' }),
          campo(l, 'dto', 'Dto. %', { type: 'number', step: 'any', min: 0, max: 100 }),
          campo(l, 'igic', 'IGIC %', { type: 'number', step: 'any', min: 0, max: 20 }),
          imp,
          h('button.btn.enlace.quitar', { type: 'button', 'aria-label': `Quitar línea ${i + 1}`, title: 'Quitar línea',
            onclick: () => { lineas.splice(i, 1); if (!lineas.length) lineas.push(lineaVacia()); pintarLineas(); } }, '✕'));
      }),
      h('button.btn', { type: 'button', onclick: () => { lineas.push(lineaVacia()); pintarLineas(); [...editor.querySelectorAll('.linea-ed input')].at(-6)?.focus(); } }, '+ Añadir línea'));
    previa();
  };

  const guardar = async () => {
    const x = datos();
    const r = await api.guardarBorrador(app.org, { id: borradorId, cliente_id: cliente.value || null, datos: x, total: calcular(x.lineas, x.irpf_pct).total });
    if (!borradorId) { borradorId = r.id; history.replaceState(null, '', '#/facturacion/borrador/' + r.id); }
  };
  const emitir = async () => {
    const x = datos(), c = cli();
    if (!c) throw new Error('Elige el cliente.');
    if (!x.lineas.length) throw new Error('La factura no tiene líneas.');
    if (x.lineas.some(l => !String(l.descripcion || '').trim())) throw new Error('Todas las líneas necesitan una descripción.');
    const total = calcular(x.lineas, x.irpf_pct).total;
    if (!confirm(`¿Emitir la factura a ${c.nombre} por ${eur(total)}?\n\nUna factura emitida no se puede borrar ni modificar.`)) return;
    await guardar();   // si falla la emisión, el borrador queda guardado tal cual
    const f = await api.emitirFactura(app.org, { cliente_id: c.id, ...x });
    await api.borrarBorrador(borradorId).catch(() => { });
    aviso(`Factura ${f.num} emitida: ${eur(f.total)}`, 'ok');
    location.hash = '#/facturacion/factura/' + f.id;
  };
  const borrar = async () => {
    if (!confirm('¿Borrar este borrador?')) return;
    if (borradorId) await api.borrarBorrador(borradorId);
    aviso('Borrador borrado', 'ok'); location.hash = '#/facturacion';
  };

  pintarLineas();

  return h('section.pila',
    h('div.no-imprimir.pila',
      h('a.volver', { href: '#/facturacion' }, '← Facturación'),
      h('div.cab', h('h1', 'Borrador de factura'),
        h('div.acciones', idioma, h('button.btn', { onclick: () => imprimir(`Borrador ${cli()?.nombre || ''}`) }, 'PDF borrador'))),
      h('div.tarjeta.formulario',
        h('div.dos', h('div', h('label', { for: 'b-cliente' }, 'Cliente'), cliente), h('div', h('label', { for: 'b-fecha' }, 'Fecha de la factura'), fecha)),
        d.horas?.length ? h('p.ayuda', `Incluye ${d.horas.length === 1 ? '1 registro' : d.horas.length + ' registros'} de jornada (${fechaCorta(d.desde)} – ${fechaCorta(d.hasta)}). Al emitir quedarán marcados como facturados.`) : null,
        h('h3', 'Líneas'), editor,
        h('div.dos', h('div', h('label', { for: 'b-irpf' }, 'Retención IRPF (%)'), irpf), h('div')),
        h('label', { for: 'b-obs' }, 'Observaciones (salen en la factura)'), obs,
        h('div.acciones',
          h('button.btn', { onclick: ev => accion(ev.currentTarget, async () => { await guardar(); aviso('Borrador guardado', 'ok'); }) }, 'Guardar borrador'),
          h('button.btn.primario', { onclick: ev => accion(ev.currentTarget, emitir) }, 'Emitir factura'),
          h('button.btn.peligro', { onclick: ev => accion(ev.currentTarget, borrar) }, borradorId ? 'Borrar borrador' : 'Descartar'))),
      h('h2', 'Vista previa')),
    hoja);
}

const fechaCorta = x => x ? new Date(x + 'T12:00:00').toLocaleDateString('es-ES') : '';
