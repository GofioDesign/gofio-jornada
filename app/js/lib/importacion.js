import { fechaES, numES } from './csv.js';

const texto = v => String(v ?? '').trim();
const numero = (v, defecto = 0) => numES(v) ?? defecto;
const fechaValida = v => {
  const iso = fechaES(v);
  if (!iso) return null;
  const [a, m, d] = iso.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, d));
  return x.getUTCFullYear() === a && x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? iso : null;
};

export function prepararHistorico(facturas, lineas, cobros, clientes = []) {
  const errores = [];
  const avisos = [];
  const clientesConocidos = new Set(clientes.map(c => texto(c.codigo).toUpperCase()));
  const porFactura = new Map();

  for (const [i, fila] of facturas.entries()) {
    const num = texto(fila.NUM);
    const fecha = fechaValida(fila.FECHA);
    const cliente = texto(fila.CLIENTE_ID).toUpperCase();
    if (!num) { errores.push(`FACTURAS, fila ${i + 2}: falta NUM.`); continue; }
    if (porFactura.has(num)) { errores.push(`FACTURAS: el número ${num} está repetido.`); continue; }
    if (!fecha) errores.push(`FACTURAS ${num}: fecha no válida.`);
    if (!cliente) errores.push(`FACTURAS ${num}: falta CLIENTE_ID.`);
    else if (clientesConocidos.size && !clientesConocidos.has(cliente)) errores.push(`FACTURAS ${num}: el cliente ${cliente} no está importado.`);
    const total = numES(fila.TOTAL);
    if (total === null) errores.push(`FACTURAS ${num}: total no válido.`);

    porFactura.set(num, {
      num, serie: texto(fila.SERIE) || num.split('-')[0], tipo_doc: texto(fila.TIPO_DOC) || 'FACTURA', fecha,
      vencimiento: fechaValida(fila.VENCIMIENTO) || fecha, cliente_codigo: cliente,
      cliente_nombre: texto(fila.CLIENTE_NOMBRE), concepto: texto(fila.CONCEPTO), base: numero(fila.BASE),
      igic: numero(fila.IGIC), irpf_pct: numero(fila.IRPF_PCT), irpf: numero(fila.IRPF), total: total ?? 0,
      coste: numero(fila.COSTE), observaciones: texto(fila.OBSERVACIONES) || null,
      huella: texto(fila.HUELLA) || null, lineas: [], cobros: [],
    });
  }

  for (const [i, fila] of lineas.entries()) {
    const num = texto(fila.NUM_DOC);
    const factura = porFactura.get(num);
    if (!factura) { errores.push(`LINEAS, fila ${i + 2}: ${num || 'sin NUM_DOC'} no corresponde a una factura.`); continue; }
    if (!texto(fila.DESCRIPCION)) errores.push(`LINEAS ${num}, fila ${i + 2}: falta DESCRIPCION.`);
    if (numES(fila.CANTIDAD) === null || numES(fila.PVP_UD) === null) errores.push(`LINEAS ${num}, fila ${i + 2}: cantidad o precio no válido.`);
    factura.lineas.push({
      linea: numero(fila.LINEA, factura.lineas.length + 1), codigo: texto(fila.CODIGO) || null,
      descripcion: texto(fila.DESCRIPCION), cantidad: numero(fila.CANTIDAD), unidad: texto(fila.UNIDAD) || 'ud',
      pvp_ud: numero(fila.PVP_UD), dto_pct: numero(fila.DTO_PCT), base: numero(fila.BASE),
      igic_pct: numero(fila.IGIC_PCT), igic: numero(fila.IGIC), coste_ud: numero(fila.COSTE_UD),
      familia: texto(fila.FAMILIA) || null,
    });
  }

  for (const [i, fila] of cobros.entries()) {
    const num = texto(fila.NUM_FACTURA);
    const factura = porFactura.get(num);
    if (!factura) { errores.push(`COBROS, fila ${i + 2}: ${num || 'sin NUM_FACTURA'} no corresponde a una factura.`); continue; }
    const fecha = fechaValida(fila.FECHA);
    const importe = numES(fila.IMPORTE);
    if (!fecha || importe === null) { errores.push(`COBROS ${num}, fila ${i + 2}: fecha o importe no válido.`); continue; }
    factura.cobros.push({ fecha, importe, medio: texto(fila.MEDIO) || 'TRANSFERENCIA', notas: texto(fila.NOTAS) || null });
  }

  const documentos = [...porFactura.values()].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '') || a.num.localeCompare(b.num));
  documentos.forEach(f => {
    if (!f.lineas.length) avisos.push(`${f.num}: se importará sin líneas.`);
    const cobrado = f.cobros.reduce((s, c) => s + c.importe, 0);
    if (cobrado - f.total > 0.01) avisos.push(`${f.num}: los cobros superan el total de la factura.`);
  });
  return { documentos, errores, avisos, totales: { facturas: documentos.length, lineas: lineas.length, cobros: cobros.length } };
}
