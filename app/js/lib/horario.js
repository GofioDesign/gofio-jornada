// Horarios de trabajo: el de la empresa (user_id null) y, si alguien lo tiene, el suyo propio.
// Cada fila es un tramo { dia_semana: 1 (lunes) … 7 (domingo), inicio: 'HH:MM[:SS]', fin }.
// Quien tiene horario propio usa solo el suyo; el resto, el de la empresa (misma regla que la migración 0031).

export const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const hm = x => String(x || '').slice(0, 5);
const minutos = x => { const [h, m] = hm(x).split(':').map(Number); return h * 60 + m; };

/** Día de la semana (1 = lunes … 7 = domingo) de una fecha 'YYYY-MM-DD'. */
export const diaSemana = iso => new Date(iso + 'T12:00:00Z').getUTCDay() || 7;

/** Tramos que se aplican a una persona: los suyos si tiene, si no los de la empresa. */
export function horarioDe(horarios, user) {
  const propios = horarios.filter(x => user && x.user_id === user);
  return propios.length ? propios : horarios.filter(x => !x.user_id);
}

/** Tramos de un día de la semana, por orden de hora. */
export const tramosDia = (tramos, dia) => tramos.filter(x => Number(x.dia_semana) === dia).sort((a, b) => hm(a.inicio).localeCompare(hm(b.inicio)));

/** Minutos previstos en una fecha. */
export const previstoDia = (tramos, iso) => tramosDia(tramos, diaSemana(iso)).reduce((s, x) => s + minutos(x.fin) - minutos(x.inicio), 0);

/** Minutos previstos entre dos fechas (ambas incluidas). */
export function previstoPeriodo(tramos, desde, hasta) {
  let s = 0;
  for (let d = desde; d <= hasta; d = siguiente(d)) s += previstoDia(tramos, d);
  return s;
}
const siguiente = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

/** «08:00–13:00 y 15:00–18:00», o '' si ese día no se trabaja. */
export function textoDia(tramos, dia) {
  const t = tramosDia(tramos, dia).map(x => `${hm(x.inicio)}–${hm(x.fin)}`);
  return t.length > 1 ? t.slice(0, -1).join(', ') + ' y ' + t.at(-1) : t[0] || '';
}

/** Comprueba los tramos antes de guardarlos. Devuelve el texto del primer error o null. */
export function errorHorario(tramos) {
  for (const x of tramos) {
    if (!/^\d\d:\d\d/.test(hm(x.inicio)) || !/^\d\d:\d\d/.test(hm(x.fin))) return `${DIAS[x.dia_semana - 1]}: falta una hora`;
    if (minutos(x.fin) <= minutos(x.inicio)) return `${DIAS[x.dia_semana - 1]}: el tramo ${hm(x.inicio)}–${hm(x.fin)} tiene que acabar después de empezar`;
  }
  for (let d = 1; d <= 7; d++) {
    const t = tramosDia(tramos, d);
    for (let i = 1; i < t.length; i++) if (minutos(t[i].inicio) < minutos(t[i - 1].fin)) return `${DIAS[d - 1]}: hay tramos que se solapan`;
  }
  return null;
}

/** Diferencia trabajado − previsto con signo: «+1 h 05 min», «−0 h 30 min». */
export function fmtDiferencia(min) {
  const a = Math.abs(Math.round(min || 0));
  return (min > 0 ? '+' : min < 0 ? '−' : '') + `${Math.floor(a / 60)} h ${String(a % 60).padStart(2, '0')} min`;
}
