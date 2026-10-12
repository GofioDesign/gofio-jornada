// Planes de Jornada (0032): qué permite el plan de la empresa y cuánto paga al mes la cuenta principal.
// Igual que limite_usuarios y copia_activa en SQL.

export const caducado = (org, hoy) => !!org.plan_hasta && org.plan_hasta < hoy;

// Personas activas que permite (null = sin límite). Plan caducado: lo del plan gratis (1).
export function limiteUsuarios(org, plan, hoy, maxGratis = 1) {
  if (caducado(org, hoy)) return maxGratis;
  if (plan?.por_asientos) return org.asientos || 1;
  return plan?.max_usuarios ?? null;
}

export const copiaActiva = (org, plan, hoy) => !!(org.copia_auto && plan?.por_asientos && !caducado(org, hoy));

// Cuota mensual: plan + asientos + extras. Devuelve las líneas y el total (0 = precios aún sin definir).
export function cuotaMensual(org, plan, extras = []) {
  const extra = id => extras.find(x => x.id === id) || {};
  const n = plan?.por_asientos ? (org.asientos || 1) : 1;
  const lineas = [];
  const add = (concepto, x) => lineas.push({ concepto, importe: Math.round(((Number(x.precio_mes_eur) || 0) + n * (Number(x.precio_asiento_mes_eur) || 0)) * 100) / 100 });
  add(plan?.por_asientos ? `${plan.nombre} · ${n} ${n === 1 ? 'asiento' : 'asientos'}` : (plan?.nombre || org.plan_id), plan || {});
  if (plan?.por_asientos && org.copia_auto) add(`${extra('copia_auto').nombre || 'Copia automática'} · ${n} ${n === 1 ? 'asiento' : 'asientos'}`, extra('copia_auto'));
  if (org.tester_facturacion) add(extra('facturacion').nombre || 'Facturación', extra('facturacion'));
  return { lineas, total: Math.round(lineas.reduce((s, l) => s + l.importe, 0) * 100) / 100 };
}
