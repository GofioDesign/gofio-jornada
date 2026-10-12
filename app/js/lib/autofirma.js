// Firma con AutoFirma desde el navegador: se le pasa el documento y devuelve la firma CAdES, sin descargar ni subir archivos.
// Usa el script oficial autoscript.js (js/vendor), que en el ordenador abre AutoFirma y habla con él por un WebSocket local.
// En el móvil ese script necesita un servidor intermedio que no tenemos: ahí se sigue firmando a mano (subiendo el .csig).
import { aBase64 } from './firma.js';

/** ¿Se puede firmar desde el navegador en este dispositivo? (ordenador con AutoFirma instalado) */
export const firmaDirectaDisponible = () => typeof navigator !== 'undefined'
  && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let carga = null, iniciado = false;
function cargarScript() {
  if (window.AutoScript) return Promise.resolve(window.AutoScript);
  return carga ??= new Promise((ok, mal) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/autoscript.js', import.meta.url).href;
    s.onload = () => window.AutoScript ? ok(window.AutoScript) : mal(new Error('No se ha podido cargar AutoFirma'));
    s.onerror = () => { carga = null; mal(new Error('No se ha podido cargar AutoFirma. Revisa la conexión.')); };
    document.head.append(s);
  });
}

/** Mensaje claro para los errores de AutoFirma que más se ven. */
export function mensajeError(tipo, mensaje) {
  const t = String(tipo || '');
  if (/Cancelled|Cancel/i.test(t)) return 'Has cancelado la firma.';
  if (/ApplicationNotFound|Timeout|IOException|Interrupted/i.test(t)) return 'No se ha podido abrir AutoFirma. Comprueba que está instalado y vuelve a intentarlo, o fírmalo a mano.';
  if (/KeyStore|Certificate|NoSuchElement|AOCertificatesNotFound/i.test(t)) return 'AutoFirma no ha encontrado ningún certificado válido en este ordenador.';
  return mensaje ? `AutoFirma no ha podido firmar: ${mensaje}` : 'AutoFirma no ha podido firmar.';
}

/** Abre AutoFirma para firmar el texto (CAdES separada, SHA-512, como al firmar el archivo a mano). Devuelve la firma en base64. */
export async function firmarConAutoFirma(documento) {
  const A = await cargarScript();
  if (!iniciado) {
    // Sus propios avisos quedarían tapados por nuestro diálogo: los errores los enseña la app
    try { window.SupportDialog?.enableSupportDialog(false); } catch { }
    A.cargarAppAfirma(); iniciado = true;
  }
  const datos = aBase64(new TextEncoder().encode(documento));
  return new Promise((ok, mal) => A.sign(datos, 'SHA512withRSA', 'CAdES', 'mode=explicit',
    firma => ok(firma),
    (tipo, mensaje) => mal(Object.assign(new Error(mensajeError(tipo, mensaje)), { tipo }))));
}
