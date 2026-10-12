// Firma mensual del registro de jornada: cada persona revisa su mes y lo firma
// con un código por correo o SMS, o con su certificado digital (AutoFirma).
import { api, DEMO } from '../api.js';
import { CONFIG } from '../../config.js';
import { h, montar, accion, aviso, dialogo, hoyISO } from '../ui.js';
import { fmtMin } from '../lib/jornada.js';
import { descargar } from '../lib/csv.js';
import { firmaDirectaDisponible, firmarConAutoFirma } from '../lib/autofirma.js';
import { nombreMes, mesesCerrados, METODOS, ocultar, telefonoE164, aBase64, deBase64, bytesDeArchivo, esFirmaDe, leerFirmante, justificante } from '../lib/firma.js';

const fechaHora = (x, tz) => new Date(x).toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz });
const archivo = (periodo, persona, ext) => `registro-jornada_${periodo.slice(0, 7)}${persona ? '_' + persona.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') : ''}.${ext}`;

/** Abre el justificante en una ventana lista para imprimir o guardar en PDF. */
function imprimir(w, texto, titulo) {
  const esc = t => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(titulo)}</title>`
    + '<style>body{margin:2cm 1.5cm;font:10pt/1.45 ui-monospace,Menlo,Consolas,monospace;color:#000}pre{white-space:pre-wrap;font:inherit;margin:0}@page{size:A4;margin:0}</style>'
    + `<pre>${esc(texto)}</pre>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 200);
}

/** Descarga el justificante (y, con certificado, la firma CAdES) de una firma guardada, o lo abre para imprimir. */
export async function descargarFirma(id, persona, { cms = false, imprimir: paraImprimir = false, tz } = {}) {
  // La ventana se abre antes de esperar al servidor: si no, el navegador la toma por una ventana emergente y la bloquea
  const w = paraImprimir ? window.open('', '_blank') : null;
  if (paraImprimir && !w) throw new Error('El navegador ha bloqueado la ventana. Permite las ventanas emergentes para imprimir.');
  let f;
  try { f = await api.firma(id); } catch (e) { w?.close(); throw e; }
  if (cms) return descargar(archivo(f.periodo, persona, 'csig'), deBase64(f.firma_cms), 'application/pkcs7-signature');
  const texto = justificante(f, persona, tz);
  if (w) return imprimir(w, texto, archivo(f.periodo, persona, 'pdf').replace('.pdf', ''));
  descargar(archivo(f.periodo, persona, 'txt').replace('.txt', '_firmado.txt'), texto, 'text/plain;charset=utf-8');
}

/** Botones del justificante de una firma: descargarlo, imprimirlo y, con certificado, la firma .csig. */
const botonesFirma = (f, persona, tz) => h('div.fila-botones',
  h('button.btn', { onclick: e => accion(e.currentTarget, () => descargarFirma(f.id, persona, { tz })) }, 'Descargar justificante'),
  h('button.btn', { onclick: e => accion(e.currentTarget, () => descargarFirma(f.id, persona, { tz, imprimir: true })) }, 'Imprimir o PDF'),
  f.metodo === 'CERTIFICADO' ? h('button.btn', { onclick: e => accion(e.currentTarget, () => descargarFirma(f.id, persona, { cms: true })) }, 'Descargar firma (.csig)') : null);

/** Texto corto del estado de la firma de un mes. */
export function estadoFirma(r, tz) {
  if (r.firma && r.vigente) return `Firmado el ${fechaHora(r.firma.firmado_en, tz)} con ${METODOS[r.firma.metodo]}.`;
  if (r.firma) return 'El registro cambió después de firmarlo (se aprobó una corrección). Vuelve a firmarlo.';
  return null;
}

/** Tarjeta de la Jornada: aparece si el mes pasado tiene jornadas sin firmar. */
export function avisoFirma(app, r) {
  if (!r || !r.cerrado || !r.dias || r.vigente) return null;
  return h('div.tarjeta.destacada.firma-aviso',
    h('h2', `Firma tu registro de ${nombreMes(r.periodo)}`),
    h('p', `${r.dias} ${r.dias === 1 ? 'día' : 'días'} · ${fmtMin(r.minutos)} de trabajo. `, r.firma ? estadoFirma(r, app.tz) : 'Revísalo y fírmalo para dejar constancia de que estás de acuerdo.'),
    h('button.btn.primario', { onclick: async () => { if (await abrirFirma(app, r.periodo)) window.dispatchEvent(new HashChangeEvent('hashchange')); } }, 'Revisar y firmar'));
}

/** Tarjeta de Ajustes: abrir el registro de cualquier mes terminado para verlo o firmarlo. */
export function tarjetaFirma(app) {
  const mes = h('select', { id: 'firma-mes' }, mesesCerrados(hoyISO(app.tz), 12).map(p => h('option', { value: p }, nombreMes(p))));
  return h('div.tarjeta', { id: 'firma' },
    h('h2', 'Firma de mi registro'),
    h('p.ayuda', 'Cada mes firmas tu registro de jornada: con un código que te llega por correo', CONFIG.FIRMA_SMS ? ' o por SMS' : '', ', o con tu certificado digital.'),
    h('label', { for: 'firma-mes' }, 'Mes'), mes,
    h('button.btn', { onclick: () => abrirFirma(app, mes.value) }, 'Ver y firmar'));
}

/** Diálogo para ver y firmar un mes. Devuelve true si se ha firmado. */
export async function abrirFirma(app, periodo) {
  let r;
  try { r = await api.registroParaFirmar(app.org, periodo); } catch (e) { aviso(e.message, 'error'); return false; }
  let firmado = false;
  const zona = h('div.firma-zona');
  const persona = app.e.mi_nombre || app.e.usuario_email;
  const hecho = f => {
    firmado = true;
    montar(zona, h('p.ok-firma', `✓ Registro firmado con ${METODOS[f.metodo]}.`), botonesFirma(f, persona, app.tz));
  };

  // ---------- con código por correo o SMS ----------
  const conCodigo = async (canal, btn) => {
    let envio = await accion(btn, () => api.enviarCodigoFirma(canal));
    if (!envio) return;
    if (envio.paso === 'telefono') {
      const tel = h('input', { type: 'tel', id: 'firma-tel', autocomplete: 'tel', placeholder: '612 345 678', inputMode: 'tel' });
      montar(zona,
        h('p', 'Tu cuenta aún no tiene un móvil. Escríbelo y te mandamos un código para confirmarlo.'),
        h('label', { for: 'firma-tel' }, 'Móvil'), tel,
        h('div.fila-botones', h('button.btn.primario', { onclick: async e => {
          const t = telefonoE164(tel.value);
          if (!t) return aviso('Escribe el móvil con su prefijo, por ejemplo +34 612 345 678', 'error');
          const x = await accion(e.currentTarget, () => api.enviarCodigoFirma('SMS', t));
          if (x) pedirCodigo(canal, x);
        } }, 'Enviar código'), botonVolver()));
      return;
    }
    pedirCodigo(canal, envio);
  };
  const pedirCodigo = (canal, envio) => {
    const codigo = h('input', { id: 'firma-codigo', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 8, placeholder: '123456', class: 'codigo' });
    const que = envio.paso === 'confirmar_telefono' ? 'para confirmar tu móvil' : 'para firmar';
    montar(zona,
      h('p', `Te hemos enviado un código ${que} a `, h('strong', ocultar(envio.destino)), '. Escríbelo aquí.'),
      DEMO ? h('p.ayuda', 'En la demo el código es 123456.') : null,
      canal === 'EMAIL' ? h('p.ayuda', 'Es el mismo correo que el de entrar en la app: usa las 6 cifras, no el enlace.') : null,
      h('label', { for: 'firma-codigo' }, 'Código'), codigo,
      h('div.fila-botones',
        h('button.btn.primario', { onclick: e => accion(e.currentTarget, async () => {
          if (!/^\d{6,8}$/.test(codigo.value.replace(/\D/g, ''))) throw new Error('Escribe el código de 6 cifras');
          await api.confirmarCodigoFirma(canal, codigo.value, envio);
          try {
            hecho(await api.firmarRegistro(app.org, r.periodo, r.huella, canal));
          } catch (err) {
            // Móvil recién confirmado: ahora llega el código para firmar
            if (err.hint !== 'CODIGO_FIRMA' || envio.paso !== 'confirmar_telefono') throw err;
            aviso('Móvil confirmado. Te enviamos otro código para firmar.', 'ok');
            pedirCodigo(canal, await api.enviarCodigoFirma('SMS'));
          }
        }) }, 'Firmar'),
        h('button.btn.enlace', { onclick: e => accion(e.currentTarget, async () => { await api.enviarCodigoFirma(canal, envio.paso === 'confirmar_telefono' ? envio.destino : undefined); aviso('Código reenviado', 'ok'); }) }, 'Enviar otro código'),
        botonVolver()));
    codigo.focus();
  };

  // ---------- con certificado digital ----------
  const conCertificado = () => {
    const subir = h('input', { type: 'file', id: 'firma-archivo', accept: '.csig,.p7s,.p7m,.sig,.xsig,application/pkcs7-signature' });
    const resultado = h('div');
    subir.addEventListener('change', () => accion(null, async () => {
      const file = subir.files[0]; if (!file) return;
      const bytes = bytesDeArchivo(await file.arrayBuffer());
      if (!(await esFirmaDe(bytes, r.documento))) {
        montar(resultado); subir.value = '';
        throw new Error('Esa firma no es del registro de este mes. Firma el documento que has descargado, sin cambiarlo.');
      }
      const quien = leerFirmante(bytes);
      montar(resultado,
        h('p', quien ? ['Firma de ', h('strong', [quien.nombre, quien.nif].filter(Boolean).join(' · ') || 'certificado sin nombre'), quien.emisor ? ` (certificado de ${quien.emisor})` : '', '.'] : 'No se ha podido leer el certificado, pero la firma es de este documento.'),
        h('button.btn.primario', { onclick: e => accion(e.currentTarget, async () => hecho(await api.firmarConCertificado(app.org, r.periodo, r.huella, aBase64(bytes)))) }, 'Guardar la firma'));
    }));
    const aMano = h('ol.pasos',
      h('li', h('button.btn', { onclick: () => descargar(archivo(r.periodo, persona, 'txt'), r.documento, 'text/plain;charset=utf-8') }, 'Descargar el documento'), ' (no lo abras ni lo cambies).'),
      h('li', 'Fírmalo con ', h('a', { href: 'https://firmaelectronica.gob.es/Home/Descargas.html', target: '_blank', rel: 'noopener' }, 'AutoFirma'),
        ': «Seleccionar ficheros a firmar», elige el documento y pulsa «Firmar» con tu certificado. Se guarda un archivo .csig.'),
      h('li', h('label', { for: 'firma-archivo' }, 'Sube aquí el archivo .csig'), subir));
    if (!firmaDirectaDisponible()) return montar(zona, aMano, resultado, h('div.fila-botones', botonVolver()));
    // En el ordenador: AutoFirma se abre con el registro ya cargado y la firma vuelve sola a la app
    const espera = h('p.ayuda');
    const directa = e => accion(e.currentTarget, async () => {
      espera.textContent = 'Abriendo AutoFirma… Si el navegador te pregunta, permite que lo abra. Puede tardar unos segundos.';
      const firma = await firmarConAutoFirma(r.documento).finally(() => { espera.textContent = ''; });
      if (!(await esFirmaDe(deBase64(firma), r.documento))) throw new Error('La firma que ha devuelto AutoFirma no es de este documento. Vuelve a intentarlo.');
      hecho(await api.firmarConCertificado(app.org, r.periodo, r.huella, firma));
    });
    montar(zona,
      h('p', 'Se abrirá ', h('strong', 'AutoFirma'), ' con tu registro ya cargado. Elige tu certificado y la firma se guarda sola.'),
      h('div.fila-botones', h('button.btn.primario', { onclick: directa }, '🔏 Firmar con AutoFirma'), botonVolver()), espera,
      h('p.ayuda', '¿No tienes AutoFirma? ', h('a', { href: 'https://firmaelectronica.gob.es/Home/Descargas.html', target: '_blank', rel: 'noopener' }, 'Descárgalo aquí'), ' (es gratis, del Gobierno de España).'),
      h('details.firma-a-mano', h('summary', '¿No se abre AutoFirma? Fírmalo a mano'), aMano, resultado));
  };

  const elegir = () => {
    const estado = estadoFirma(r, app.tz);
    if (r.firma && r.vigente) {
      return montar(zona, h('p.ok-firma', '✓ ' + estado), botonesFirma(r.firma, persona, app.tz));
    }
    if (!r.cerrado) return montar(zona, h('p.ayuda', `Podrás firmarlo cuando termine ${nombreMes(r.periodo)}.`));
    if (!r.dias) return montar(zona, h('p.ayuda', 'No tienes jornadas registradas este mes: no hay nada que firmar.'));
    const n = (k, uno, varios) => `${k} ${k === 1 ? uno : varios}`;
    montar(zona,
      estado ? h('p.aviso-firma', estado) : null,
      r.pendientes ? h('p.aviso-firma', `Tienes ${n(r.pendientes, 'corrección', 'correcciones')} de este mes sin aprobar todavía. Si firmas ahora y luego se aprueba${r.pendientes === 1 ? '' : 'n'}, tendrás que volver a firmar.`) : null,
      r.sin_cerrar ? h('p.aviso-firma', `${n(r.sin_cerrar, 'día no tiene', 'días no tienen')} hora de salida («sin cerrar»), así que sus horas no cuentan enteras. Pide una corrección antes de firmar.`) : null,
      h('p', '¿Cómo quieres firmar?'),
      h('div.botones-firma',
        h('button.btn.primario', { onclick: e => conCodigo('EMAIL', e.currentTarget) }, '✉️ Código por correo'),
        CONFIG.FIRMA_SMS || DEMO ? h('button.btn', { onclick: e => conCodigo('SMS', e.currentTarget) }, '📱 Código por SMS') : null,
        h('button.btn', { onclick: conCertificado }, '🔏 Certificado digital')));
  };
  const botonVolver = () => h('button.btn.enlace', { onclick: elegir }, 'Volver');
  elegir();

  await dialogo(`Registro de ${nombreMes(r.periodo)}`, [
    h('p.ayuda', `${r.dias} ${r.dias === 1 ? 'día' : 'días'} · ${fmtMin(r.minutos)} de trabajo`),
    h('pre.documento-firma', r.documento),
    h('p.ayuda.huella', 'Huella del documento (SHA-256): ', h('code', r.huella)),
    zona,
  ], [{ texto: 'Cerrar', valor: true }]);
  return firmado;
}
