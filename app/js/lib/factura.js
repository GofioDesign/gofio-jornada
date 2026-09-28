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
