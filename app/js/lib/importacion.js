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

export function prepararMaestros(productos, proveedores, precios) {
  const errores = [];
  const avisos = [];
  const prov = new Map();
  for (const [i, r] of proveedores.entries()) {
    const codigo = texto(r.ID).toUpperCase();
    if (!codigo || !texto(r.NOMBRE)) { errores.push(`PROVEEDORES, fila ${i + 2}: faltan ID o NOMBRE.`); continue; }
    if (prov.has(codigo)) { errores.push(`PROVEEDORES: el ID ${codigo} está repetido.`); continue; }
    prov.set(codigo, { codigo, nombre: texto(r.NOMBRE), nif: texto(r.NIF) || null, web: texto(r.WEB) || null,
      email: texto(r.EMAIL) || null, telefono: texto(r.TELEFONO) || null, contacto: texto(r.CONTACTO) || null,
      direccion: texto(r.DIRECCION) || null, notas: texto(r.NOTAS) || null });
  }
  const prod = new Map();
  for (const [i, r] of productos.entries()) {
    const codigo = texto(r.CODIGO).toUpperCase();
    const proveedor = texto(r.PROVEEDOR_ID).toUpperCase();
    if (!codigo || !texto(r.DESCRIPCION)) { errores.push(`PRODUCTOS, fila ${i + 2}: faltan CODIGO o DESCRIPCION.`); continue; }
    if (prod.has(codigo)) { errores.push(`PRODUCTOS: el código ${codigo} está repetido.`); continue; }
    if (proveedor && !prov.has(proveedor)) errores.push(`PRODUCTOS ${codigo}: proveedor ${proveedor} no encontrado.`);
    prod.set(codigo, { codigo, familia: texto(r.FAMILIA) || 'MATERIALES', descripcion: texto(r.DESCRIPCION),
      descripcion_factura: texto(r.DESCRIPCION_FACTURA) || texto(r.DESCRIPCION), unidad: texto(r.UNIDAD) || 'ud',
      proveedor_codigo: proveedor || null, ref_proveedor: texto(r.REF_PROVEEDOR) || null,
      coste_ud: numero(r.COSTE_UD), pvp_historico: numES(r.PVP_HISTORICO), pvp: numero(r.PVP_ACTUAL || r.PVP_NUEVO),
      igic_pct: numES(r.IGIC_PCT), activo: texto(r.ACTIVO).toUpperCase() !== 'NO', notas: texto(r.NOTAS) || null });
  }
  const cotizaciones = [];
  for (const [i, r] of precios.entries()) {
    const producto = texto(r.CODIGO).toUpperCase(), proveedor = texto(r.PROVEEDOR_ID).toUpperCase();
    const precio = numES(r.PRECIO_SIN_IGIC), fecha = fechaValida(r.FECHA);
    if (!prod.has(producto)) errores.push(`PRECIOS_PROVEEDOR, fila ${i + 2}: producto ${producto || 'vacío'} no encontrado.`);
    if (!prov.has(proveedor)) errores.push(`PRECIOS_PROVEEDOR, fila ${i + 2}: proveedor ${proveedor || 'vacío'} no encontrado.`);
    if (precio === null || !fecha) errores.push(`PRECIOS_PROVEEDOR, fila ${i + 2}: precio o fecha no válido.`);
    if (prod.has(producto) && prov.has(proveedor) && precio !== null && fecha) cotizaciones.push({ producto_codigo: producto, proveedor_codigo: proveedor,
      precio, fecha, ref_proveedor: texto(r.REF_PROVEEDOR) || null, url: texto(r.URL) || null });
  }
  if (!cotizaciones.length) avisos.push('No hay precios de proveedor válidos; se importarán solo proveedores y productos.');
  return { proveedores: [...prov.values()], productos: [...prod.values()], precios: cotizaciones, errores, avisos,
    totales: { proveedores: prov.size, productos: prod.size, precios: cotizaciones.length } };
}
