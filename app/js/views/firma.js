// Firma mensual del registro de jornada: cada persona revisa su mes y lo firma
// con un código por correo o SMS, o con su certificado digital (AutoFirma).
import { api, DEMO } from '../api.js';
import { CONFIG } from '../../config.js';
import { h, montar, accion, aviso, dialogo, hoyISO } from '../ui.js';
import { fmtMin } from '../lib/jornada.js';
import { descargar } from '../lib/csv.js';
import { nombreMes, mesesCerrados, METODOS, ocultar, telefonoE164, aBase64, deBase64, bytesDeArchivo, esFirmaDe, leerFirmante, justificante } from '../lib/firma.js';

const fechaHora = (x, tz) => new Date(x).toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz });
const archivo = (periodo, persona, ext) => `registro-jornada_${periodo.slice(0, 7)}${persona ? '_' + persona.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') : ''}.${ext}`;

/** Descarga el justificante (y, con certificado, la firma CAdES) de una firma guardada. */
export async function descargarFirma(id, persona, { cms = false } = {}) {
  const f = await api.firma(id);
  if (cms) return descargar(archivo(f.periodo, persona, 'csig'), deBase64(f.firma_cms), 'application/pkcs7-signature');
  descargar(archivo(f.periodo, persona, 'txt').replace('.txt', '_firmado.txt'), justificante(f, persona), 'text/plain;charset=utf-8');
}

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
    montar(zona, h('p.ok-firma', `✓ Registro firmado con ${METODOS[f.metodo]}.`),
      h('div.fila-botones',
        h('button.btn', { onclick: e => accion(e.currentTarget, () => descargarFirma(f.id, persona)) }, 'Descargar justificante'),
        f.metodo === 'CERTIFICADO' ? h('button.btn', { onclick: e => accion(e.currentTarget, () => descargarFirma(f.id, persona, { cms: true })) }, 'Descargar firma (.csig)') : null));
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
    montar(zona,
      h('ol.pasos',
        h('li', h('button.btn', { onclick: () => descargar(archivo(r.periodo, persona, 'txt'), r.documento, 'text/plain;charset=utf-8') }, 'Descargar el documento'), ' (no lo abras ni lo cambies).'),
        h('li', 'Fírmalo con ', h('a', { href: 'https://firmaelectronica.gob.es/Home/Descargas.html', target: '_blank', rel: 'noopener' }, 'AutoFirma'),
          ': «Seleccionar ficheros a firmar», elige el documento y pulsa «Firmar» con tu certificado. Se guarda un archivo .csig.'),
        h('li', h('label', { for: 'firma-archivo' }, 'Sube aquí el archivo .csig'), subir)),
      resultado, h('div.fila-botones', botonVolver()));
  };

  const elegir = () => {
    const estado = estadoFirma(r, app.tz);
    if (r.firma && r.vigente) {
      return montar(zona, h('p.ok-firma', '✓ ' + estado),
        h('div.fila-botones',
          h('button.btn', { onclick: e => accion(e.currentTarget, () => descargarFirma(r.firma.id, persona)) }, 'Descargar justificante'),
          r.firma.metodo === 'CERTIFICADO' ? h('button.btn', { onclick: e => accion(e.currentTarget, () => descargarFirma(r.firma.id, persona, { cms: true })) }, 'Descargar firma (.csig)') : null));
    }
    if (!r.cerrado) return montar(zona, h('p.ayuda', `Podrás firmarlo cuando termine ${nombreMes(r.periodo)}.`));
    if (!r.dias) return montar(zona, h('p.ayuda', 'No tienes jornadas registradas este mes: no hay nada que firmar.'));
    montar(zona,
      estado ? h('p.aviso-firma', estado) : null,
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
