import assert from 'node:assert/strict';
import test from 'node:test';
import { mesAnterior, mesesCerrados, nombreMes, ocultar, telefonoE164, aBase64, deBase64, bytesDeArchivo, esFirmaDe, leerFirmante, justificante } from '../app/js/lib/firma.js';

// Firmas CAdES hechas con openssl sobre DOC (certificado de prueba autofirmado, como uno de la FNMT):
//   openssl cms -sign -binary -md sha512 -in doc.txt -signer c.pem -inkey k.pem -outform DER            (separada, SHA-512, como AutoFirma)
//   openssl cms -sign -binary -nodetach -md sha256 -in doc.txt -signer c.pem -inkey k.pem -outform DER  (implícita, SHA-256)
const DOC = 'REGISTRO DE JORNADA\nTotal: 8:00 de trabajo en 1 día\n';
const SEPARADA = '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';
const IMPLICITA = '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';

test('meses ya terminados', () => {
  assert.equal(mesAnterior('2026-10-11'), '2026-09-01');
  assert.equal(mesAnterior('2026-01-31'), '2025-12-01');
  assert.deepEqual(mesesCerrados('2026-02-03', 3), ['2026-01-01', '2025-12-01', '2025-11-01']);
  assert.equal(nombreMes('2026-09-01'), 'septiembre de 2026');
});

test('destino del código a medias y teléfonos', () => {
  assert.equal(ocultar('empleado@gofio.test'), 'e*******@gofio.test');
  assert.equal(ocultar('+34612345678'), '••• ••• 5678');
  assert.equal(telefonoE164('612 34 56 78'), '+34612345678');
  assert.equal(telefonoE164('0034 612345678'), '+34612345678');
  assert.equal(telefonoE164('+44 7700 900123'), '+447700900123');
  assert.equal(telefonoE164('922 12 34'), null);
});

test('base64 de ida y vuelta, y archivos en DER o en texto', () => {
  const b = deBase64(SEPARADA);
  assert.equal(aBase64(b), SEPARADA);
  assert.deepEqual(bytesDeArchivo(b.buffer), b);
  const pem = '-----BEGIN PKCS7-----\n' + SEPARADA.match(/.{1,64}/g).join('\n') + '\n-----END PKCS7-----\n';
  assert.deepEqual(bytesDeArchivo(new TextEncoder().encode(pem).buffer), b);
});

test('la firma es del documento exacto', async () => {
  assert.equal(await esFirmaDe(deBase64(SEPARADA), DOC), true);
  assert.equal(await esFirmaDe(deBase64(IMPLICITA), DOC), true);
  assert.equal(await esFirmaDe(deBase64(SEPARADA), DOC.replace('8:00', '9:00')), false);
});

test('quién firma: nombre, NIF y emisor del certificado', () => {
  for (const f of [SEPARADA, IMPLICITA]) {
    assert.deepEqual(leerFirmante(deBase64(f)), { nombre: 'ANA PÉREZ GARCÍA', nif: '12345678Z', emisor: 'PÉREZ GARCÍA ANA - 12345678Z' });
  }
  assert.equal(leerFirmante(new Uint8Array([1, 2, 3])), null);
});

test('justificante de la firma', () => {
  const base = { documento: DOC, huella: 'abc', firmado_en: '2026-10-01T08:00:00Z' };
  const t = justificante({ ...base, metodo: 'EMAIL', destino: 'ana@x.es' }, 'Ana');
  assert.match(t, /Firmado por: Ana/);
  assert.match(t, /código por correo enviado a ana@x.es/);
  const c = justificante({ ...base, metodo: 'CERTIFICADO', firma_cms: SEPARADA }, 'Ana');
  assert.match(c, /Certificado: ANA PÉREZ GARCÍA · 12345678Z/);
  assert.match(c, /AutoFirma/);
});
