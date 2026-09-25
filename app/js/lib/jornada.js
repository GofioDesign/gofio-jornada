// Lógica de jornada en el cliente (misma que las funciones SQL estado_jornada / tramos_jornada).
// Se usa para el contador en vivo, el modo demo y para mostrar el día sin esperar al servidor.

export const TIPOS = {
  ENTRADA: 'Entrada', PAUSA: 'Pausa', REANUDAR: 'Reanudar', SALIDA: 'Salida',
  DESPLAZAMIENTO_INICIO: 'Sale hacia', DESPLAZAMIENTO_FIN: 'Llega a', CAMBIO_CLIENTE: 'Trabaja para',
};

const t = f => new Date(f.momento_declarado || f.momento).getTime();
const efectivo = f => f.origen === 'APP' || f.origen === undefined || f.estado === 'APROBADA';

/** Estado actual a partir de los fichajes de la app (ordenados o no). */
export function estadoActual(fichajes) {
  const app = fichajes.filter(f => (f.origen || 'APP') === 'APP').sort((a, b) => t(a) - t(b));
  let estado = 'FUERA', desde = null, desp = null, cliente = null;
  for (const f of app) {
    switch (f.tipo) {
      case 'ENTRADA': estado = 'TRABAJANDO'; desde = t(f); cliente = f.cliente_id || null; break;
      case 'PAUSA': estado = 'PAUSA'; desde = t(f); break;
      case 'REANUDAR': estado = 'TRABAJANDO'; desde = t(f); cliente = f.cliente_id || cliente; break;
      case 'SALIDA': estado = 'FUERA'; desde = t(f); cliente = null; desp = null; break;
      case 'CAMBIO_CLIENTE': cliente = f.cliente_id; break;
      case 'DESPLAZAMIENTO_INICIO': desp = { desde: t(f), cliente_id: f.cliente_id, lat: f.lat, lng: f.lng }; break;
      case 'DESPLAZAMIENTO_FIN': cliente = f.cliente_id || desp?.cliente_id || cliente; desp = null; break;
    }
  }
  return { estado, desde, desplazamiento: desp, cliente_id: cliente };
}

/** Qué fichajes se pueden hacer ahora (para habilitar botones). */
export function accionesPosibles(st) {
  if (st.estado === 'FUERA') return ['ENTRADA', 'DESPLAZAMIENTO_INICIO'];
  if (st.estado === 'PAUSA') return ['REANUDAR', 'SALIDA'];
  return st.desplazamiento ? ['DESPLAZAMIENTO_FIN', 'SALIDA'] : ['PAUSA', 'SALIDA', 'DESPLAZAMIENTO_INICIO', 'CAMBIO_CLIENTE'];
}

/**
 * Tramos continuos de un día: TRABAJO (por cliente), PAUSA y DESPLAZAMIENTO.
 * @param fichajes de UN usuario y UN día
 * @param ahora ms: si la jornada sigue abierta, el tramo en curso llega hasta aquí.
 *              null = día pasado: los tramos sin cerrar no cuentan (igual que en SQL).
 */
export function tramos(fichajes, ahora = Date.now()) {
  const ev = fichajes.filter(efectivo).sort((a, b) => t(a) - t(b));
  const out = [];
  let st = 'FUERA', segIni = null, segCli = null, cli = null, d = null;
  const cerrar = (fin) => {
    if (segIni === null) return;
    const min = Math.floor((fin - segIni) / 60000);
    if (min > 0) out.push({ tipo: st === 'PAUSA' ? 'PAUSA' : 'TRABAJO', cliente_id: segCli, inicio: segIni, fin, minutos: min });
    segIni = null;
  };
  for (const f of ev) {
    const m = t(f);
    if (segIni !== null && (['PAUSA', 'REANUDAR', 'SALIDA', 'CAMBIO_CLIENTE', 'ENTRADA'].includes(f.tipo)
        || (f.tipo === 'DESPLAZAMIENTO_FIN' && (f.cliente_id || d?.cliente_id || null) !== segCli))) cerrar(m);
    switch (f.tipo) {
      case 'ENTRADA': st = 'TRABAJANDO'; cli = f.cliente_id || null; segIni = m; segCli = cli; break;
      case 'PAUSA': st = 'PAUSA'; segIni = m; segCli = null; break;
      case 'REANUDAR': st = 'TRABAJANDO'; cli = f.cliente_id || cli; segIni = m; segCli = cli; break;
      case 'CAMBIO_CLIENTE': cli = f.cliente_id; segIni = m; segCli = cli; break;
      case 'SALIDA': st = 'FUERA'; break;
      case 'DESPLAZAMIENTO_INICIO': d = { ini: m, cliente_id: f.cliente_id, lat: f.lat, lng: f.lng }; break;
      case 'DESPLAZAMIENTO_FIN': {
        const destino = f.cliente_id || d?.cliente_id || null;
        if (d) {
          out.push({ tipo: 'DESPLAZAMIENTO', cliente_id: destino, inicio: d.ini, fin: m, minutos: Math.floor((m - d.ini) / 60000),
                     km: km(d, f) });
          d = null;
        }
        if (st === 'TRABAJANDO' && destino !== segCli) { cli = destino; segIni = m; segCli = cli; }
        break;
      }
    }
  }
  if (ahora === null) return out.sort((a, b) => a.inicio - b.inicio);
  if (segIni !== null && st === 'TRABAJANDO') {
    out.push({ tipo: 'TRABAJO', cliente_id: segCli, inicio: segIni, fin: null, minutos: Math.max(0, Math.floor((ahora - segIni) / 60000)) });
  } else if (segIni !== null && st === 'PAUSA') {
    out.push({ tipo: 'PAUSA', cliente_id: null, inicio: segIni, fin: null, minutos: Math.max(0, Math.floor((ahora - segIni) / 60000)) });
  }
  if (d) out.push({ tipo: 'DESPLAZAMIENTO', cliente_id: d.cliente_id, inicio: d.ini, fin: null, minutos: Math.max(0, Math.floor((ahora - d.ini) / 60000)) });
  return out.sort((a, b) => a.inicio - b.inicio);
}

function km(a, b) {
  if (a.lat == null || b.lat == null) return null;
  const R = 6371, r = x => x * Math.PI / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 100) / 100;
}

/** Totales de un día a partir de sus tramos. */
export function totales(trs) {
  const s = { trabajo: 0, pausa: 0, desplazamiento: 0, km: 0, porCliente: {} };
  for (const x of trs) {
    if (x.tipo === 'TRABAJO') { s.trabajo += x.minutos; s.porCliente[x.cliente_id || ''] = (s.porCliente[x.cliente_id || ''] || 0) + x.minutos; }
    if (x.tipo === 'PAUSA') s.pausa += x.minutos;
    if (x.tipo === 'DESPLAZAMIENTO') { s.desplazamiento += x.minutos; s.km += x.km || 0; }
  }
  s.km = Math.round(s.km * 100) / 100;
  return s;
}

export function fmtMin(min) {
  min = Math.max(0, Math.round(min || 0));
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

export function fmtReloj(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
}

/** Clave de día local (zona de la empresa) de un instante. */
export function diaLocal(ms, tz = 'Atlantic/Canary') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
