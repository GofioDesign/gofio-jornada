// Detalle de una factura emitida y su PDF (impresión del navegador → «Guardar como PDF»).
// Idiomas: ES y EN. Los datos de emisor y cliente son los congelados al emitir.
import { api } from '../api.js';
import { h, montar } from '../ui.js';

const TXT = {
  ES: {
    locale: 'es-ES', factura: 'Factura', rectificativa: 'Factura rectificativa', num: 'Nº', fecha: 'Fecha', vence: 'Vencimiento',
    periodo: 'Periodo', cliente: 'Cliente', nif: 'NIF', desc: 'Descripción', cant: 'Cant.', precio: 'Precio', dto: 'Dto.',
    igic: 'IGIC', importe: 'Importe', base: 'Base imponible', sobre: 'sobre', irpf: 'Retención IRPF', total: 'Total',
    pago: 'Forma de pago', transferencia: 'Transferencia bancaria', motivo: 'Motivo',
    obs: 'Observaciones', huella: 'Huella',
  },
  EN: {
    locale: 'en-IE', factura: 'Invoice', rectificativa: 'Corrective invoice', num: 'No.', fecha: 'Date', vence: 'Due date',
    periodo: 'Period', cliente: 'Bill to', nif: 'Tax ID', desc: 'Description', cant: 'Qty', precio: 'Price', dto: 'Disc.',
    igic: 'IGIC', importe: 'Amount', base: 'Taxable base', sobre: 'on', irpf: 'IRPF withholding', total: 'Total',
    pago: 'Payment', transferencia: 'Bank transfer', motivo: 'Reason',
    obs: 'Notes', huella: 'Hash',
  },
};

export async function vistaFactura(app, id) {
  const f = await api.factura(app.org, id);
  if (!f) return h('p.vacio', 'Factura no encontrada.');
  const hoja = h('article.doc-factura');
  const idioma = h('select', { 'aria-label': 'Idioma del PDF', onchange: () => pintar() },
    h('option', { value: 'ES' }, 'Español'), h('option', { value: 'EN' }, 'English'));
  idioma.value = f.cliente?.idioma === 'EN' ? 'EN' : 'ES';
  const pintar = () => montar(hoja, ...documento(f, TXT[idioma.value]));
  pintar();

  const pdf = () => {
    const titulo = document.title;
    document.title = `${f.num} ${f.cliente?.nombre || ''}`.trim();   // nombre de archivo sugerido al guardar
    addEventListener('afterprint', () => { document.title = titulo; }, { once: true });
    print();
  };
  const e = f.emisor || {};
  const faltan = ['nif', 'direccion'].filter(k => !e[k]).length || !(e.titular || e.marca);

  return h('section.pila',
    h('div.no-imprimir.pila',
      h('a.volver', { href: '#/facturacion' }, '← Facturación'),
      h('div.cab', h('h1', f.num), h('div.acciones', idioma, h('button.btn.primario', { onclick: pdf }, 'Descargar PDF'))),
      faltan ? h('p.aviso-fijo', 'Esta factura se emitió sin tus datos fiscales completos (titular, NIF y dirección). ',
        'Rellénalos en ', h('a', { href: '#/ajustes' }, 'Ajustes'), ': las próximas facturas ya los llevarán. Una factura emitida no se puede cambiar.') : null,
      h('p.ayuda', 'En la ventana de impresión elige «Guardar como PDF».')),
    hoja);
}

function documento(f, t) {
  const eur = n => (Number(n) || 0).toLocaleString(t.locale, { style: 'currency', currency: 'EUR' });
  const num = n => (Number(n) || 0).toLocaleString(t.locale, { maximumFractionDigits: 3 });
  const pct = n => `${num(n)} %`;
  const dia = x => x ? new Date(x + 'T12:00:00').toLocaleDateString('en-GB') : '';
  const e = f.emisor || {}, c = f.cliente || {};
  const lineas = f.lineas || [];
  const conDto = lineas.some(l => Number(l.dto_pct) > 0);
  const juntar = (...xs) => xs.filter(Boolean).join(' ');
  const bloque = (...filas) => filas.filter(Boolean).map(x => h('div', x));
  const desglose = (f.igic_desglose || []).filter(d => Number(d.base) || Number(d.cuota));

  return [
    h('header.df-cab',
      h('div.df-emisor',
        h('strong.df-marca', e.marca || ''),
        bloque(e.titular && e.titular !== e.marca ? e.titular : null, e.nif && `${t.nif}: ${e.nif}`, e.direccion,
          juntar(e.cp, e.localidad), e.provincia, juntar(e.email, e.telefono && `· ${e.telefono}`), e.web)),
      h('div.df-titulo',
        h('h2', f.tipo_doc === 'RECTIFICATIVA' ? t.rectificativa : t.factura),
        h('dl', h('dt', t.num), h('dd', f.num), h('dt', t.fecha), h('dd', dia(f.fecha)),
          f.vencimiento ? [h('dt', t.vence), h('dd', dia(f.vencimiento))] : null,
          f.periodo_desde ? [h('dt', t.periodo), h('dd', `${dia(f.periodo_desde)} – ${dia(f.periodo_hasta)}`)] : null))),
    h('section.df-cliente',
      h('div.df-etiqueta', t.cliente),
      h('strong', c.nombre || ''),
      bloque(c.codigo && `${t.nif}: ${c.codigo}`, c.direccion, juntar(c.cp, c.localidad),
        [c.municipio !== c.localidad ? c.municipio : null, c.provincia].filter(Boolean).join(', '),
        c.pais && c.pais !== 'ESPAÑA' ? c.pais : null)),
    f.tipo_doc === 'RECTIFICATIVA' && f.motivo ? h('p.df-nota', h('strong', `${t.motivo}: `), f.motivo) : null,
    h('table.df-lineas',
      h('thead', h('tr', h('th', t.desc), h('th.n', t.cant), h('th.n', t.precio), conDto ? h('th.n', t.dto) : null, h('th.n', t.igic), h('th.n', t.importe))),
      h('tbody', lineas.map(l => h('tr',
        h('td', l.descripcion), h('td.n', `${num(l.cantidad)} ${l.unidad || ''}`.trim()), h('td.n', eur(l.pvp_ud)),
        conDto ? h('td.n', Number(l.dto_pct) ? pct(l.dto_pct) : '') : null, h('td.n', pct(l.igic_pct)), h('td.n', eur(l.base)))))),
    h('table.df-totales', h('tbody',
      h('tr', h('th', t.base), h('td', eur(f.base))),
      desglose.map(d => h('tr', h('th', `${t.igic} ${pct(d.pct)} ${t.sobre} ${eur(d.base)}`), h('td', eur(d.cuota)))),
      Number(f.irpf) ? h('tr', h('th', `${t.irpf} ${pct(f.irpf_pct)}`), h('td', '−' + eur(f.irpf))) : null,
      h('tr.df-total', h('th', t.total), h('td', eur(f.total))))),
    e.nota_igic && desglose.some(d => Number(d.pct) === 0) ? h('p.df-nota', e.nota_igic) : null,
    e.iban || e.pago ? h('section.df-pago', h('div.df-etiqueta', t.pago),
      bloque(e.pago || t.transferencia, e.iban && `IBAN: ${e.iban}`, e.bic && `BIC: ${e.bic}`)) : null,
    f.observaciones ? h('p.df-nota', h('strong', `${t.obs}: `), f.observaciones) : null,
    h('footer.df-pie', `${t.huella}: ${f.huella || ''}`),
  ];
}
