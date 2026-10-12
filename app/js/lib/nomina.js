// Cliente que paga por nómina: precio hora real de cada mes (nómina ÷ horas fichadas).

/** 'AAAA-MM' de una fecha 'AAAA-MM-DD'. */
export const mesDe = dia => String(dia).slice(0, 7);

/**
 * Una fila por nómina, del mes más reciente al más antiguo.
 * Solo cuenta el TRABAJO de esa persona para ese cliente (los desplazamientos van dentro de la jornada).
 * Sin horas, el precio hora queda en null.
 */
export function preciosHora(nominas, tramos, clienteId, userId) {
  const min = {};
  for (const t of tramos) {
    if (t.tipo !== 'TRABAJO' || t.cliente_id !== clienteId || t.user_id !== userId || !t.fin) continue;
    min[mesDe(t.dia)] = (min[mesDe(t.dia)] || 0) + (Number(t.minutos) || 0);
  }
  const porHora = (importe, minutos) => importe == null || importe === '' || !minutos ? null : Math.round(Number(importe) / (minutos / 60) * 100) / 100;
  return nominas
    .filter(n => n.cliente_id === clienteId)
    .map(n => {
      const minutos = min[mesDe(n.mes)] || 0;
      return { ...n, minutos, bruto_hora: porHora(n.bruto, minutos), neto_hora: porHora(n.neto, minutos) };
    })
    .sort((a, b) => String(b.mes).localeCompare(String(a.mes)));
}
