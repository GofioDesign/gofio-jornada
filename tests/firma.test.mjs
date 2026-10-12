import assert from 'node:assert/strict';
import test from 'node:test';
import { mesAnterior, mesesCerrados, nombreMes, ocultar, telefonoE164, aBase64, deBase64, bytesDeArchivo, esFirmaDe, leerFirmante, justificante, momentoFirma, documentoRegistro } from '../app/js/lib/firma.js';

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

test('fecha de la firma en hora local y UTC', () => {
  assert.equal(momentoFirma('2026-10-11T19:55:41.854Z', 'Atlantic/Canary'), '11/10/2026 a las 20:55:41 (hora de Atlantic/Canary; 19:55:41 UTC)');
  assert.equal(momentoFirma('2026-01-15T08:00:00Z', 'Europe/Madrid'), '15/01/2026 a las 09:00:00 (hora de Europe/Madrid; 08:00:00 UTC)');
  const t = justificante({ documento: DOC, huella: 'abc', firmado_en: '2026-10-11T19:55:41Z', metodo: 'EMAIL', destino: 'ana@x.es' }, 'Ana', 'Atlantic/Canary');
  assert.match(t, /Fecha de la firma: 11\/10\/2026 a las 20:55:41/);
});

// Mismo caso que se comprobó contra _documento_registro_v2 en PostgreSQL: el texto tiene que salir idéntico
test('documento del registro (formato 2): tramos, cambios a mano y totales', () => {
  const F = (id, tipo, momento, x = {}) => ({ id, tipo, momento, origen: 'APP', registrado_por: 'u1', ...x });
  const fichajes = [
    F('a1', 'ENTRADA', '2026-09-23T11:25:10Z'), F('a2', 'PAUSA', '2026-09-23T13:00:00Z'), F('a3', 'REANUDAR', '2026-09-23T13:30:29Z'),
    F('a4', 'SALIDA', '2026-09-24T08:00:00Z', { origen: 'CORRECCION', momento_declarado: '2026-09-23T15:35:00Z', motivo: 'olvidé fichar. ', estado: 'APROBADA', revisado_por: 'u2', revisado_en: '2026-09-24T09:00:00Z' }),
    F('a5', 'SALIDA', '2026-09-23T16:00:00Z', { anulado: { motivo: 'error', anulado_por: 'u2', anulado_en: '2026-09-24T09:01:00Z' } }),
    F('a6', 'ENTRADA', '2026-09-25T09:00:00Z', { origen: 'CORRECCION', momento_declarado: '2026-09-25T06:00:00Z', motivo: 'x', estado: 'PENDIENTE' }),
    F('b1', 'ENTRADA', '2026-09-25T07:00:00Z'), F('b2', 'DESPLAZAMIENTO_INICIO', '2026-09-25T08:00:00Z'), F('b3', 'DESPLAZAMIENTO_FIN', '2026-09-25T08:40:00Z'),
    F('b4', 'SALIDA', '2026-09-25T10:00:00Z'), F('b5', 'ENTRADA', '2026-09-25T14:00:00Z'),
    F('b6', 'CAMBIO_CLIENTE', '2026-09-26T08:00:00Z', { origen: 'RESPONSABLE', momento_declarado: '2026-09-25T07:30:00Z', motivo: 'Cliente asignado a posteriori', estado: 'APROBADA', registrado_por: 'u2' }),
    F('c1', 'ENTRADA', '2026-10-02T10:00:00Z', { origen: 'RESPONSABLE', momento_declarado: '2026-09-29T23:30:00Z', motivo: 'turno', estado: 'APROBADA', registrado_por: 'u2' }),
    F('c2', 'SALIDA', '2026-09-30T22:59:00Z'), F('d1', 'ENTRADA', '2026-10-01T07:00:00Z'),
  ];
  const r = documentoRegistro({ empresa: { nombre: 'GOFIO DESIGN', nif: '78563258L' }, persona: { nombre: 'Juan Alberto González Rodríguez', nif: '78563258L' },
    periodo: '2026-09-01', tz: 'Atlantic/Canary', fichajes, nombres: { u1: 'Juan Alberto González Rodríguez', u2: 'Ana Pérez' } });
  assert.equal(r.documento, `REGISTRO DIARIO DE JORNADA
Empresa: GOFIO DESIGN · NIF 78563258L
Persona trabajadora: Juan Alberto González Rodríguez · NIF 78563258L
Periodo: septiembre de 2026 (del 01/09/2026 al 30/09/2026)
Horas en la hora local de Atlantic/Canary

Día       Entrada Salida      Trabajo Pausas Desplaz.
mié 23/09 12:25   16:35          3:38   0:30     0:00  (1)(2)
          Tramos de trabajo: 12:25–14:00, 14:30–16:35
vie 25/09 08:00   sin cerrar     3:00   0:00     0:40
          Tramos de trabajo: 08:00–11:00, 15:00–sin cerrar
mié 30/09 00:30   23:59         23:29   0:00     0:00  (3)

Total: 30:07 de trabajo en 3 días. Pausas: 0:30. Desplazamientos: 0:40 (incluidos en el trabajo).

Cambios hechos a mano en el registro
(1) mié 23/09 · Se añadió a mano: salida a las 16:35. Lo pidió Juan Alberto González Rodríguez el 24/09/2026 a las 09:00. Motivo: olvidé fichar. Lo aprobó Ana Pérez el 24/09/2026 a las 10:00.
(2) mié 23/09 · Se anuló: salida a las 17:00. Motivo: error. Lo anuló Ana Pérez el 24/09/2026 a las 10:01.
(3) mié 30/09 · Se añadió a mano: entrada a las 00:30. Lo registró Ana Pérez el 02/10/2026 a las 11:00. Motivo: turno.

Registro diario de jornada (artículo 34.9 del Estatuto de los Trabajadores). La empresa lo conserva durante cuatro años a disposición de la persona trabajadora, de sus representantes legales y de la Inspección de Trabajo y Seguridad Social.
`);
  assert.deepEqual([r.dias, r.minutos, r.abiertos], [3, 1807, 1]);
});

test('documento del registro sin jornadas y sin desplazamientos', () => {
  const vacio = documentoRegistro({ empresa: { nombre: 'Taller' }, persona: { nombre: ' ' }, periodo: '2026-02-01', fichajes: [] });
  assert.match(vacio.documento, /Persona trabajadora: —\nPeriodo: febrero de 2026 \(del 01\/02\/2026 al 28\/02\/2026\)/);
  assert.match(vacio.documento, /No hay jornadas registradas en este periodo\./);
  const uno = documentoRegistro({ empresa: { nombre: 'Taller' }, persona: { nombre: 'Ana' }, periodo: '2026-02-01', tz: 'Europe/Madrid',
    fichajes: [{ id: 1, tipo: 'ENTRADA', momento: '2026-02-02T07:00:00Z', origen: 'APP' }, { id: 2, tipo: 'SALIDA', momento: '2026-02-02T15:00:00Z', origen: 'APP' }] });
  assert.match(uno.documento, /Día {7}Entrada Salida {6}Trabajo Pausas\nlun 02\/02 08:00   16:00 {10}8:00   0:00\n\nTotal: 8:00 de trabajo en 1 día\. Pausas: 0:00\.\n/);
});
