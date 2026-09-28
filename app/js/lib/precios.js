export const claveMargenFamilia = familia => `margen_ideal_${String(familia || '').trim().toLowerCase()}`;

export function costeUnitario(costeCompra, contenidoCompra = 1) {
  const coste = Number(costeCompra) || 0;
  const contenido = Number(contenidoCompra) || 0;
  return contenido > 0 ? Math.round(coste / contenido * 10000) / 10000 : 0;
}

export function margenObjetivo(config = {}, familia = '') {
  const especifico = Number(config[claveMargenFamilia(familia)]);
  const general = Number(config.margen_ideal);
  return especifico > 0 ? especifico : general > 0 ? general : 0.6;
}

export function datosPrecio(coste, pvp, config = {}, familia = '') {
  coste = Number(coste) || 0; pvp = Number(pvp) || 0;
  const objetivo = margenObjetivo(config, familia);
  const ideal = coste > 0 ? Math.round(coste * (1 + objetivo) * 100) / 100 : null;
  const margen = coste > 0 && pvp > 0 ? (pvp - coste) / coste : null;
  return { objetivo, ideal, margen, cumple: margen !== null && margen >= objetivo };
}
