// Cálculo de una factura, idéntico a public.calcular_documento (0005_facturacion.sql):
// base por línea en céntimos, IGIC agrupado por tipo y redondeado por tipo, IRPF sobre la base.
// Se usa para la vista previa de los borradores y en el modo demo; al emitir manda el servidor.
// lineas: [{ cantidad, pvp, dto (0-100), igic (0-100), ... }]
export function calcular(lineas = [], irpfPct = 0) {
  let base = 0;
  const porTipo = new Map();
  const ls = lineas.map(l => {
    const b = Math.round((Number(l.cantidad) || 0) * (Number(l.pvp) || 0) * (1 - (Number(l.dto) || 0) / 100) * 100);
    const k = Number(l.igic) || 0;
    base += b; porTipo.set(k, (porTipo.get(k) || 0) + b);
    return { ...l, base: b / 100, cuota: Math.round(b * k / 100) / 100 };
  });
  let igic = 0;
  const igic_desglose = [...porTipo].sort((a, b) => a[0] - b[0]).map(([pct, b]) => {
    const cuota = Math.round(b * pct / 100); igic += cuota;
    return { pct, base: b / 100, cuota: cuota / 100 };
  });
  const irpf = Math.round(base * (Number(irpfPct) || 0) / 100);
  return { lineas: ls, base: base / 100, igic: igic / 100, irpf: irpf / 100, total: (base + igic - irpf) / 100, igic_desglose };
}

// Datos del emisor tal como los congela emitir_factura (+ la aclaración de IGIC 0 % de la migración 0006).
export function emisorDe(o = {}, igicDesglose = []) {
  const cfg = o.config || {};
  const e = { marca: o.nombre, titular: o.titular, nif: o.nif, direccion: o.direccion, cp: o.cp, localidad: o.localidad, provincia: o.provincia,
              email: o.email, telefono: o.telefono, web: o.web, iban: o.iban, bic: o.bic, pago: cfg.medio_pago_texto };
  if (cfg.texto_exencion_igic && igicDesglose.some(d => Number(d.pct) === 0)) e.nota_igic = cfg.texto_exencion_igic;
  return e;
}

// IRPF que aplica a un cliente: el suyo, el de la empresa, o 0 si no aplica.
export const irpfCliente = (cliente, config = {}) => cliente?.aplica_irpf ? Number(cliente.irpf_pct ?? config.irpf_defecto ?? 15) : 0;

// Categorías de factura (0014_categorias_factura.sql), en el orden en que salen en el documento.
export const CATEGORIAS = ['MANO DE OBRA', 'MATERIALES', 'PEQUEÑO MATERIAL', 'TRANSPORTE', 'OTROS'];
export const NOMBRE_CATEGORIA = { 'MANO DE OBRA': 'Mano de obra', MATERIALES: 'Materiales', 'PEQUEÑO MATERIAL': 'Pequeño material', TRANSPORTE: 'Transporte', OTROS: 'Otros' };
export const AGRUPACIONES = {
  DETALLE: 'Línea a línea (cantidad × precio)', CATEGORIAS: 'Agrupadas por categoría', RESUMEN: 'Un importe por categoría',
  CONCEPTO: 'Conceptos con su importe (agrupables)', TOTAL: 'Un solo concepto con el total',
};

// Igual que public.categoria_de_familia.
export function categoriaDeFamilia(familia) {
  const f = String(familia || '').trim().toUpperCase();
  if (['MANO DE OBRA', 'DISEÑO', 'SERVICIOS'].includes(f)) return 'MANO DE OBRA';
  if (['MATERIALES', 'MATERIAL'].includes(f)) return 'MATERIALES';
  if (['PEQUEÑO MATERIAL', 'FIJACIONES Y ACCESORIOS'].includes(f)) return 'PEQUEÑO MATERIAL';
  if (['TRANSPORTE', 'DESPLAZAMIENTO'].includes(f)) return 'TRANSPORTE';
  return 'OTROS';
}
export const categoriaDe = l => CATEGORIAS.includes(l?.categoria) ? l.categoria : categoriaDeFamilia(l?.familia);

// Líneas calculadas ({ base, igic_pct, categoria | familia, ... }) agrupadas por categoría, con subtotal en céntimos exactos.
export function porCategoria(lineas = []) {
  return CATEGORIAS.map(categoria => {
    const ls = lineas.filter(l => categoriaDe(l) === categoria);
    return { categoria, lineas: ls, base: ls.reduce((s, l) => s + Math.round((Number(l.base) || 0) * 100), 0) / 100 };
  }).filter(g => g.lineas.length);
}

// Una fila por tipo de IGIC con la suma de las bases (agrupación TOTAL).
export function totalPorIgic(lineas = []) {
  const m = new Map();
  lineas.forEach(l => { const k = Number(l.igic_pct) || 0; m.set(k, (m.get(k) || 0) + Math.round((Number(l.base) || 0) * 100)); });
  return [...m].sort((a, b) => a[0] - b[0]).map(([igic_pct, c]) => ({ igic_pct, base: c / 100 }));
}

// Filas de la presentación CONCEPTO: las líneas con el mismo «grupo» se suman en una fila con ese
// texto (una por tipo de IGIC); las que no tienen grupo salen con su descripción. Orden de aparición.
export function porConcepto(lineas = []) {
  const filas = new Map();
  lineas.forEach((l, i) => {
    const grupo = String(l.grupo || '').trim();
    const igic_pct = Number(l.igic_pct) || 0;
    const clave = grupo ? `g|${grupo}|${igic_pct}` : `l|${i}`;
    const f = filas.get(clave) || { concepto: grupo || l.descripcion, igic_pct, c: 0 };
    f.c += Math.round((Number(l.base) || 0) * 100);
    filas.set(clave, f);
  });
  return [...filas.values()].map(({ c, ...f }) => ({ ...f, base: c / 100 }));
}

// Texto del concepto único: el escrito, o las descripciones juntas como hace emitir_factura (0018).
export const conceptoDe = (concepto, lineas = []) =>
  (String(concepto || '').trim() || lineas.map(l => l.descripcion).filter(Boolean).join(' · ')).slice(0, 250);

// Una fila por categoría y tipo de IGIC (si una categoría mezcla tipos, sale una fila por tipo).
export function resumenPorCategoria(lineas = []) {
  return porCategoria(lineas).flatMap(g => [...new Set(g.lineas.map(l => Number(l.igic_pct) || 0))].sort((a, b) => a - b)
    .map(igic_pct => ({ categoria: g.categoria, igic_pct,
      base: g.lineas.filter(l => (Number(l.igic_pct) || 0) === igic_pct).reduce((s, l) => s + Math.round((Number(l.base) || 0) * 100), 0) / 100 })));
}

// Observaciones recurrentes (como las firmas del correo): se guardan en organizaciones.config.observaciones_plantillas
// como [{ titulo, texto }]. Mientras la empresa no guarde las suyas, se ofrecen estas.
export const OBSERVACIONES_INICIALES = [
  { titulo: 'Reparación parcial con garantía 6 meses', texto: 'Reparación parcial de instalación preexistente. La intervención comprende los materiales suministrados y los trabajos detallados en esta factura. La cobertura se limita a los defectos atribuibles a dichos materiales o a su instalación, conforme a las condiciones pactadas y la normativa aplicable. No supone una renovación integral ni cubre averías independientes de los elementos antiguos no intervenidos.\n\nGarantía contractual de seis meses desde la finalización de los trabajos, sobre los cables, conectores y fijaciones suministrados y su correcta instalación. Cubre defectos atribuibles a los materiales o a la ejecución realizada. No cubre averías independientes de los elementos preexistentes no intervenidos, ni daños causados por uso indebido o actuaciones posteriores de terceros. Todo ello sin perjuicio de las responsabilidades legales aplicables.' },
];
export const plantillasObs = (config = {}) =>
  (Array.isArray(config?.observaciones_plantillas) ? config.observaciones_plantillas : OBSERVACIONES_INICIALES).filter(p => p?.texto?.trim());
// Añade un texto a las observaciones con una línea en blanco de separación; si ya está, no lo repite.
export function anadirObs(actual = '', texto = '') {
  const a = (actual || '').trimEnd(); const t = (texto || '').trim();
  if (!t || a.includes(t)) return a;
  return a ? `${a}\n\n${t}` : t;
}

// Rectificativa (por sustitución): borrador con todo lo de la factura original, para corregir y emitir
// en la serie RECT. Al emitirla, la original queda RECTIFICADA y deja de contar como pendiente.
export const lineaDeFactura = l => ({ producto_id: l.producto_id || null, codigo: l.codigo || null, descripcion: l.descripcion,
  cantidad: Number(l.cantidad), unidad: l.unidad || 'ud', pvp: Number(l.pvp_ud), dto: Number(l.dto_pct) || 0, igic: Number(l.igic_pct) || 0,
  coste: Number(l.coste_ud) || 0, familia: l.familia || null, categoria: categoriaDe(l), grupo: l.grupo || '' });
// Orden en que salen las líneas de una factura emitida: «orden» si se cambió al corregir textos, si no su número.
export const ordenLineas = (lineas = []) => [...lineas].sort((a, b) => (a.orden ?? a.linea) - (b.orden ?? b.linea) || a.linea - b.linea);
export const borradorRectificativo = (f, hoy) => ({
  fecha: hoy, irpf_pct: Number(f.irpf_pct) || 0, observaciones: f.observaciones || null,
  lineas: ordenLineas(f.lineas).map(lineaDeFactura),
  agrupacion: f.agrupacion || 'DETALLE', concepto: f.agrupacion === 'TOTAL' ? f.concepto || null : null,
  desde: f.periodo_desde || null, hasta: f.periodo_hasta || null,
  rectifica: { id: f.id, num: f.num, fecha: f.fecha }, motivo: '' });
// Texto del motivo que sale en la rectificativa: siempre cita la factura que sustituye.
export const motivoRectificativa = (r, motivo) => {
  const [a, m, d] = String(r.fecha || '').split('-');
  return `Rectifica la factura ${r.num}${d ? ` de ${d}/${m}/${a}` : ''}. ${String(motivo || '').trim()}`.trim();
};

// Enlaces del emisor en la factura (el PDF de «Guardar como PDF» los conserva clicables).
export const urlWeb = w => { const s = String(w || '').trim(); return !s ? null : /^https?:\/\//i.test(s) ? s : 'https://' + s; };
// WhatsApp: wa.me necesita el número internacional sin «+» ni espacios; un número español de 9 cifras lleva el 34 delante.
export const urlWhatsApp = tel => {
  let d = String(tel || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2); else if (/^[6789]\d{8}$/.test(d)) d = '34' + d;
  d = d.replace(/\D/g, '');
  return d.length >= 8 ? 'https://wa.me/' + d : null;
};
