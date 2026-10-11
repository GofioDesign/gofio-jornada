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

/** Justificante de una firma para guardar o enseñar en una inspección: el documento firmado y cómo se firmó. */
export function justificante(firma, persona) {
  const quien = firma.metodo === 'CERTIFICADO' ? leerFirmante(deBase64(firma.firma_cms)) : null;
  return `${firma.documento}\n` +
    `----------------------------------------\n` +
    `Firmado por: ${persona || '—'}\n` +
    `Fecha de la firma: ${new Date(firma.firmado_en).toISOString()}\n` +
    `Método: ${METODOS[firma.metodo]}${firma.destino ? ' enviado a ' + firma.destino : ''}\n` +
    (quien ? `Certificado: ${[quien.nombre, quien.nif].filter(Boolean).join(' · ')}${quien.emisor ? ' (emitido por ' + quien.emisor + ')' : ''}\n` : '') +
    `Huella SHA-256 del documento: ${firma.huella}\n` +
    (firma.metodo === 'CERTIFICADO' ? 'La firma electrónica (CAdES) se descarga aparte y se puede validar con AutoFirma o en valide.redsara.es.\n' : '');
}
