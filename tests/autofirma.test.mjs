import assert from 'node:assert/strict';
import test from 'node:test';
import { mensajeError } from '../app/js/lib/autofirma.js';

test('mensajes claros para los errores de AutoFirma', () => {
  assert.equal(mensajeError('es.gob.afirma.core.AOCancelledOperationException', 'x'), 'Has cancelado la firma.');
  assert.match(mensajeError('es.gob.afirma.standalone.ApplicationNotFoundException'), /Comprueba que está instalado/);
  assert.match(mensajeError('java.util.concurrent.TimeoutException'), /No se ha podido abrir AutoFirma/);
  assert.equal(mensajeError('java.lang.Exception', 'algo raro'), 'AutoFirma no ha podido firmar: algo raro');
});
