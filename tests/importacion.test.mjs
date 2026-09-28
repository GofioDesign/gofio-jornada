import test from 'node:test';
import assert from 'node:assert/strict';
import { prepararHistorico } from '../app/js/lib/importacion.js';

test('prepara FACTURAS, LINEAS y COBROS de la hoja v7', () => {
  const r = prepararHistorico([
    { NUM: 'EMIT26-0001', SERIE: 'EMIT26', FECHA: '01/01/2026', VENCIMIENTO: '31/01/2026', CLIENTE_ID: 'X1', CLIENTE_NOMBRE: 'Cliente', BASE: '100,00 €', IGIC: '7,00 €', IRPF_PCT: '15,00%', IRPF: '15,00 €', TOTAL: '92,00 €', HUELLA: 'abc' },
  ], [
    { NUM_DOC: 'EMIT26-0001', LINEA: '1', DESCRIPCION: 'Trabajo', CANTIDAD: '2', UNIDAD: 'h', PVP_UD: '50,00 €', BASE: '100,00 €', IGIC_PCT: '7,00%', IGIC: '7,00 €' },
  ], [
    { FECHA: '02/02/2026', NUM_FACTURA: 'EMIT26-0001', IMPORTE: '92,00 €', MEDIO: 'TRANSFERENCIA' },
  ], [{ codigo: 'X1' }]);

  assert.deepEqual(r.errores, []);
  assert.equal(r.documentos[0].fecha, '2026-01-01');
  assert.equal(r.documentos[0].lineas[0].pvp_ud, 50);
  assert.equal(r.documentos[0].cobros[0].importe, 92);
});

test('detecta referencias rotas antes de importar', () => {
  const r = prepararHistorico([
    { NUM: 'F-1', FECHA: '32/01/2026', CLIENTE_ID: 'DESCONOCIDO', TOTAL: 'x' },
  ], [{ NUM_DOC: 'F-2', DESCRIPCION: 'Huérfana', CANTIDAD: '1', PVP_UD: '1' }], [], [{ codigo: 'C1' }]);
  assert.equal(r.documentos.length, 1);
  assert.ok(r.errores.some(e => e.includes('fecha no válida')));
  assert.ok(r.errores.some(e => e.includes('no está importado')));
  assert.ok(r.errores.some(e => e.includes('no corresponde')));
});
