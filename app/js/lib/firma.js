// Firma mensual del registro de jornada: utilidades sin dependencias (también se usan en las pruebas).

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** '2026-10-11' -> '2026-09-01' (primer día del mes anterior) */
export function mesAnterior(hoy) {
  const [a, m] = hoy.split('-').map(Number);
  return m === 1 ? `${a - 1}-12-01` : `${a}-${String(m - 1).padStart(2, '0')}-01`;
}

/** Los últimos n meses ya terminados, del más reciente al más antiguo: ['2026-09-01', '2026-08-01', …] */
export function mesesCerrados(hoy, n = 12) {
  const out = []; let p = mesAnterior(hoy);
  for (let i = 0; i < n; i++) { out.push(p); p = mesAnterior(p); }
  return out;
}

/** '2026-09-01' -> 'septiembre de 2026' */
export const nombreMes = periodo => `${MESES[Number(periodo.slice(5, 7)) - 1]} de ${periodo.slice(0, 4)}`;

export const METODOS = { EMAIL: 'código por correo', SMS: 'código por SMS', CERTIFICADO: 'certificado digital' };

/** Email o teléfono a medias, para enseñar a dónde va el código: 'e*******@gofio.test', '••• ••• 1234' */
export function ocultar(destino = '') {
  const s = String(destino);
  if (s.includes('@')) { const [u, d] = s.split('@'); return u.slice(0, 1) + '*'.repeat(Math.max(u.length - 1, 3)) + '@' + d; }
  const dig = s.replace(/\D/g, '');
  return dig.length > 4 ? '••• ••• ' + dig.slice(-4) : s;
}

/** Teléfono para SMS en formato internacional. Sin prefijo se entiende España (+34). Devuelve null si no parece un móvil. */
export function telefonoE164(t) {
  let s = String(t || '').replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^[67]\d{8}$/.test(s)) s = '+34' + s;
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

export function aBase64(bytes) {
  let s = ''; const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function deBase64(txt) {
  const s = atob(String(txt).replace(/-----[A-Z0-9 ]+-----|\s/g, ''));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

/** El archivo que sube la persona: binario DER (.csig, .p7s) o el mismo en base64/PEM. */
export function bytesDeArchivo(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0x30) return b;
  try { return deBase64(new TextDecoder().decode(b)); } catch { return b; }
}

function indexOf(grande, chico) {
  outer: for (let i = 0; i <= grande.length - chico.length; i++) {
    for (let j = 0; j < chico.length; j++) if (grande[i + j] !== chico[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * ¿La firma es de este documento? Una firma CAdES lleva dentro el resumen (SHA-256/384/512) de lo firmado.
 * Es la misma comprobación que hace el servidor antes de guardarla.
 */
export async function esFirmaDe(firma, documento) {
  const doc = new TextEncoder().encode(documento);
  for (const alg of ['SHA-256', 'SHA-384', 'SHA-512']) {
    const r = new Uint8Array(await crypto.subtle.digest(alg, doc));
    if (indexOf(firma, r) >= 0) return true;
  }
  return false;
}

// ---------- Lectura mínima de DER (lo justo para saber quién firma) ----------
function tlv(b, i) {
  const tag = b[i]; let len = b[i + 1], p = i + 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = len * 256 + b[p + k]; p += n; }
  if (p + len > b.length) throw new Error('DER truncado');
  return { tag, ini: p, fin: p + len, sig: p + len };
}
function hijos(b, nodo) {
  const out = []; let i = nodo.ini;
  while (i < nodo.fin) { const t = tlv(b, i); out.push(t); i = t.sig; }
  return out;
}
const hex = (b, n) => Array.from(b.subarray(n.ini, n.fin), x => x.toString(16).padStart(2, '0')).join('');
function texto(b, n) {
  const v = b.subarray(n.ini, n.fin);
  if (n.tag === 0x1e) { let s = ''; for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode(v[i] * 256 + v[i + 1]); return s; }
  if (n.tag === 0x14) return String.fromCharCode(...v);
  return new TextDecoder().decode(v);
}
const OID = { '550403': 'cn', '550405': 'serial', '55042a': 'nombre', '550404': 'apellidos', '55040a': 'organizacion' };
function nombreX500(b, nodo) {
  const r = {};
  for (const set of hijos(b, nodo)) for (const atv of hijos(b, set)) {
    const [oid, val] = hijos(b, atv); const k = OID[hex(b, oid)];
    if (k && !r[k]) r[k] = texto(b, val);
  }
  return r;
}
function datosCertificado(b, cert) {
  const tbs = hijos(b, hijos(b, cert)[0]);
  const c = tbs[0].tag === 0xa0 ? tbs.slice(1) : tbs;   // [0] versión, opcional
  return { serie: hex(b, c[0]), emisor: nombreX500(b, c[2]), sujeto: nombreX500(b, c[4]) };
}

const NIF = /\b([0-9XYZ]\d{7}[A-Z]|[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J])\b/;

/**
 * Quién firma un archivo CAdES/PKCS#7: { nombre, nif, emisor }. Si no se entiende, null.
 * Toma el certificado del firmante (el que indica la firma) o, si no lo encuentra, el primero.
 */
export function leerFirmante(bytes) {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ci = tlv(b, 0); const [, cont] = hijos(b, ci);
    const sd = hijos(b, hijos(b, cont)[0]);
    const certsNodo = sd.find(n => n.tag === 0xa0);
    if (!certsNodo) return null;
    const certs = hijos(b, certsNodo).filter(n => n.tag === 0x30).map(n => datosCertificado(b, n));
    let serieFirmante = null;
    const infos = sd[sd.length - 1];
    if (infos.tag === 0x31) {
      const si = hijos(b, infos)[0];
      const sid = si && hijos(b, si)[1];
      if (sid?.tag === 0x30) serieFirmante = hex(b, hijos(b, sid)[1]);
    }
    const c = certs.find(x => x.serie === serieFirmante) || certs[0];
    if (!c) return null;
    const s = c.sujeto;
    const nif = (String(s.serial || '').replace(/^IDC[A-Z]{2}-/, '').match(NIF) || String(s.cn || '').match(NIF) || [])[1] || null;
    const nombre = s.nombre && s.apellidos ? `${s.nombre} ${s.apellidos}` : String(s.cn || '').replace(/\s*-\s*[0-9XYZ]\d{7}[A-Z]\s*$/, '').trim() || null;
    return { nombre, nif, emisor: c.emisor.cn || c.emisor.organizacion || null };
  } catch { return null; }
}

/** Fecha y hora de la firma en la hora local de la empresa, con la hora UTC al lado: '11/10/2026 a las 20:55:41 (hora de Atlantic/Canary; 19:55:41 UTC)' */
export function momentoFirma(iso, tz = 'Atlantic/Canary') {
  const ms = Date.parse(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} a las ${p.hour}:${p.minute}:${p.second} (hora de ${tz}; ${new Date(ms).toISOString().slice(11, 19)} UTC)`;
}

/** Justificante de una firma para guardar o enseñar en una inspección: el documento firmado y cómo se firmó. */
export function justificante(firma, persona, tz = 'Atlantic/Canary') {
  const quien = firma.metodo === 'CERTIFICADO' ? leerFirmante(deBase64(firma.firma_cms)) : null;
  return `${firma.documento}\n` +
    `----------------------------------------\n` +
    `Firmado por: ${persona || '—'}\n` +
    `Fecha de la firma: ${momentoFirma(firma.firmado_en, tz)}\n` +
    `Método: ${METODOS[firma.metodo]}${firma.destino ? ' enviado a ' + firma.destino : ''}\n` +
    (quien ? `Certificado: ${[quien.nombre, quien.nif].filter(Boolean).join(' · ')}${quien.emisor ? ' (emitido por ' + quien.emisor + ')' : ''}\n` : '') +
    `Huella SHA-256 del documento: ${firma.huella}\n` +
    (firma.metodo === 'CERTIFICADO' ? 'La firma electrónica (CAdES) se descarga aparte y se puede validar con AutoFirma o en valide.redsara.es.\n' : '');
}

// ---------- Documento del registro (formato 2) ----------
// Es el mismo texto que genera _documento_registro_v2 en SQL: el servidor lo usa para firmar y la demo lo usa tal cual.
// Si cambia algo aquí, hay que cambiarlo igual allí (y al revés), o las firmas dejarían de cuadrar.

const DIAS_SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const QUE = {
  ENTRADA: 'entrada', SALIDA: 'salida', PAUSA: 'inicio de pausa', REANUDAR: 'vuelta de la pausa',
  DESPLAZAMIENTO_INICIO: 'salida de desplazamiento', DESPLAZAMIENTO_FIN: 'llegada de desplazamiento', CAMBIO_CLIENTE: 'cambio de cliente',
};
const hm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const minutosEntre = (a, b) => Math.trunc(Math.round((b - a) / 1000) / 60);
const partes = (ms, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .formatToParts(new Date(ms)).map(p => [p.type, p.value]));
const horaLocal = (ms, tz) => { const p = partes(ms, tz); return `${p.hour}:${p.minute}`; };
const diaClave = (ms, tz) => { const p = partes(ms, tz); return `${p.year}-${p.month}-${p.day}`; };
const fechaLocal = (ms, tz) => { const p = partes(ms, tz); return `${p.day}/${p.month}/${p.year} a las ${p.hour}:${p.minute}`; };
const ddmmaaaa = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const diaCorto = iso => `${DIAS_SEMANA[new Date(iso + 'T12:00:00Z').getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const ultimoDia = periodo => { const [a, m] = periodo.split('-').map(Number); return `${periodo.slice(0, 8)}${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const quien = (nombres, id) => (id && nombres[id]?.trim()) || '—';
const motivo = t => String(t || '').trim().replace(/[.\s]+$/, '') || '—';

/**
 * Texto del registro de un mes de una persona.
 * fichajes: los suyos (de cualquier fecha), con anulado = { motivo, anulado_por, anulado_en } si se anuló.
 * nombres: { user_id: nombre } para decir quién pidió, aprobó o anuló cada cambio.
 * Devuelve { documento, dias, minutos, abiertos } (abiertos: días sin hora de salida).
 */
export function documentoRegistro({ empresa, persona, periodo, tz = 'Atlantic/Canary', fichajes, nombres = {} }) {
  const hasta = ultimoDia(periodo);
  const m = f => Date.parse(f.momento_declarado || f.momento);
  const delMes = fichajes.map(f => ({ ...f, _m: m(f), _d: diaClave(m(f), tz) })).filter(f => f._d >= periodo && f._d <= hasta)
    .sort((a, b) => a._m - b._m || Date.parse(a.momento) - Date.parse(b.momento) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Cambios hechos a mano: correcciones aprobadas y fichajes anulados (sin los de cliente, que no cambian las horas)
  const cambios = delMes.filter(f => f.tipo !== 'CAMBIO_CLIENTE' && (f.anulado || (f.origen !== 'APP' && f.estado === 'APROBADA')));
  const refs = {};
  const lineasCambios = cambios.map((f, i) => {
    (refs[f._d] = refs[f._d] || []).push(`(${i + 1})`);
    const que = `${QUE[f.tipo]} a las ${horaLocal(f._m, tz)}`;
    let t;
    if (f.anulado) {
      t = `Se anuló: ${que}. Motivo: ${motivo(f.anulado.motivo)}. Lo anuló ${quien(nombres, f.anulado.anulado_por)} el ${fechaLocal(Date.parse(f.anulado.anulado_en), tz)}.`;
    } else if (f.origen === 'RESPONSABLE') {
      t = `Se añadió a mano: ${que}. Lo registró ${quien(nombres, f.registrado_por)} el ${fechaLocal(Date.parse(f.momento), tz)}. Motivo: ${motivo(f.motivo)}.`;
    } else {
      t = `Se añadió a mano: ${que}. Lo pidió ${quien(nombres, f.registrado_por)} el ${fechaLocal(Date.parse(f.momento), tz)}. Motivo: ${motivo(f.motivo)}. `
        + (f.revisado_por ? `Lo aprobó ${quien(nombres, f.revisado_por)}${f.revisado_en ? ' el ' + fechaLocal(Date.parse(f.revisado_en), tz) : ''}.` : 'Aprobado.');
    }
    return `(${i + 1}) ${diaCorto(f._d)} · ${t}`;
  });

  // Días: la misma cuenta que resumen_jornada, con los tramos de trabajo de cada día
  const dias = [];
  let d = null, st, tIni, pIni, dIni;
  for (const f of delMes.filter(x => !x.anulado && (x.origen === 'APP' || x.estado === 'APROBADA'))) {
    if (!d || d.dia !== f._d) {
      d = { dia: f._d, entrada: null, salida: null, trabajo: 0, pausa: 0, desp: 0, tramos: [] }; dias.push(d);
      st = 'FUERA'; tIni = pIni = dIni = null;
    }
    const t = f._m;
    switch (f.tipo) {
      case 'ENTRADA': if (st === 'FUERA') { st = 'TRABAJANDO'; tIni = t; d.entrada ??= t; d.tramos.push([t, null]); } break;
      case 'PAUSA': if (st === 'TRABAJANDO') { d.trabajo += minutosEntre(tIni, t); d.tramos.at(-1)[1] = t; st = 'PAUSA'; pIni = t; } break;
      case 'REANUDAR': if (st === 'PAUSA') { d.pausa += minutosEntre(pIni, t); st = 'TRABAJANDO'; tIni = t; d.tramos.push([t, null]); } break;
      case 'SALIDA':
        if (st === 'TRABAJANDO') { d.trabajo += minutosEntre(tIni, t); d.tramos.at(-1)[1] = t; } else if (st === 'PAUSA') d.pausa += minutosEntre(pIni, t);
        st = 'FUERA'; d.salida = t; break;
      case 'DESPLAZAMIENTO_INICIO': dIni = t; break;
      case 'DESPLAZAMIENTO_FIN': if (dIni !== null) { d.desp += minutosEntre(dIni, t); dIni = null; } break;
    }
    d.abierta = st === 'TRABAJANDO' || st === 'PAUSA';
  }

  const conDesp = dias.some(x => x.desp > 0);
  const fila = (a, b, c, e, g, k) => (a.padEnd(10) + b.padEnd(8) + c.padEnd(12) + e.padStart(7) + g.padStart(7) + (conDesp ? k.padStart(9) : '')).trimEnd();
  const minutos = dias.reduce((s, x) => s + x.trabajo, 0);
  const pausas = dias.reduce((s, x) => s + x.pausa, 0);
  const desp = dias.reduce((s, x) => s + x.desp, 0);
  const nif = x => x?.trim() ? ` · NIF ${x.trim()}` : '';

  let doc = 'REGISTRO DIARIO DE JORNADA\n'
    + `Empresa: ${empresa.nombre}${nif(empresa.nif)}\n`
    + `Persona trabajadora: ${persona.nombre?.trim() || '—'}${nif(persona.nif)}\n`
    + `Periodo: ${nombreMes(periodo)} (del ${ddmmaaaa(periodo)} al ${ddmmaaaa(hasta)})\n`
    + `Horas en la hora local de ${tz}\n\n`;
  if (!dias.length) doc += 'No hay jornadas registradas en este periodo.\n';
  else {
    doc += fila('Día', 'Entrada', 'Salida', 'Trabajo', 'Pausas', 'Desplaz.') + '\n';
    for (const x of dias) {
      doc += (fila(diaCorto(x.dia), x.entrada ? horaLocal(x.entrada, tz) : '', x.abierta ? 'sin cerrar' : x.salida ? horaLocal(x.salida, tz) : '',
        hm(x.trabajo), hm(x.pausa), hm(x.desp)) + (refs[x.dia] ? '  ' + refs[x.dia].join('') : '')) + '\n';
      if (x.tramos.length > 1) doc += ' '.repeat(10) + 'Tramos de trabajo: ' + x.tramos.map(([a, b]) => `${horaLocal(a, tz)}–${b ? horaLocal(b, tz) : 'sin cerrar'}`).join(', ') + '\n';
    }
    doc += `\nTotal: ${hm(minutos)} de trabajo en ${dias.length} ${dias.length === 1 ? 'día' : 'días'}. Pausas: ${hm(pausas)}.`
      + (conDesp ? ` Desplazamientos: ${hm(desp)} (incluidos en el trabajo).` : '') + '\n';
  }
  if (lineasCambios.length) doc += '\nCambios hechos a mano en el registro\n' + lineasCambios.join('\n') + '\n';
  doc += '\nRegistro diario de jornada (artículo 34.9 del Estatuto de los Trabajadores). La empresa lo conserva durante cuatro años'
    + ' a disposición de la persona trabajadora, de sus representantes legales y de la Inspección de Trabajo y Seguridad Social.\n';
  return { documento: doc, dias: dias.length, minutos, abiertos: dias.filter(x => x.abierta).length };
}
