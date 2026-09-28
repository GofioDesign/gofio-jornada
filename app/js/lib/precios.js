export const claveMargenFamilia = familia => `margen_ideal_${String(familia || '').trim().toLowerCase()}`;

export function margenObjetivo(config = {}, familia = '') {
  const especifico = Number(config[claveMargenFamilia(familia)]);
  const general = Number(config.margen_ideal);
  return especifico > 0 && especifico < 1 ? especifico : general > 0 && general < 1 ? general : 0.6;
}

export function datosPrecio(coste, pvp, config = {}, familia = '') {
  coste = Number(coste) || 0; pvp = Number(pvp) || 0;
  const objetivo = margenObjetivo(config, familia);
  const ideal = coste > 0 ? Math.round(coste / (1 - objetivo) * 100) / 100 : null;
  const margen = coste > 0 && pvp > 0 ? (pvp - coste) / pvp : null;
  return { objetivo, ideal, margen, cumple: margen !== null && margen >= objetivo };
}
