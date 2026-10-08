// Capa de datos. La app solo habla con este módulo.
//  - Modo SUPABASE: config.js con URL y clave pública.
//  - Modo DEMO: sin configurar nada; guarda en este navegador para probar la app.
import { CONFIG } from '../config.js';
import { estadoActual, tramos, totales, diaLocal } from './lib/jornada.js';
import { calcular, irpfCliente, emisorDe, categoriaDe, conceptoDe, motivoRectificativa, numeroAnterior, SIN_HUELLA } from './lib/factura.js';

export const DEMO = !CONFIG.SUPABASE_URL || /\?demo|#demo/.test(location.href);

let sb = null;
async function cliente() {
  if (!sb) {
    const { createClient } = await import('@supabase/supabase-js');
    sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
  }
  return sb;
}

function ok({ data, error }) {
  if (error) {
    const e = new Error(traducir(error.message)); e.limitePlan = error.hint === 'LIMITE_PLAN'; throw e;
  }
  return data;
}
function traducir(m = '') {
  if (/row-level security/i.test(m)) return 'No tienes permiso para esta acción';
  if (/duplicate key.*horas_facturadas/i.test(m)) return 'Algunas de esas horas ya estaban facturadas';
  if (/duplicate key/i.test(m)) return 'Ya existe un registro con ese código';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Sin conexión. Inténtalo de nuevo.';
  return m;
}

// =====================================================================
// SUPABASE
// =====================================================================
const supa = {
  async sesion() { const c = await cliente(); return (await c.auth.getSession()).data.session; },
  async alCambiarSesion(cb) { const c = await cliente(); c.auth.onAuthStateChange((_e, s) => cb(s)); },
  async entrarConEmail(email) {
    const c = await cliente();
    return ok(await c.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } }));
  },
  async entrarConCodigo(email, token) { const c = await cliente(); return ok(await c.auth.verifyOtp({ email, token, type: 'email' })); },
  async salir() { const c = await cliente(); await c.auth.signOut(); },

  async misEmpresas() {
    const c = await cliente(); const { data: { user } } = await c.auth.getUser();
    const rows = ok(await c.from('miembros').select('rol, nombre, activo, organizaciones(*, planes(*))').eq('user_id', user.id).eq('activo', true));
    return rows.map(r => ({ ...r.organizaciones, plan: r.organizaciones.planes, rol: r.rol, mi_nombre: r.nombre, user_id: user.id, usuario_email: user.email }));
  },
  async crearEmpresa(nombre, nif, tuNombre) { const c = await cliente(); return ok(await c.rpc('crear_organizacion', { p_nombre: nombre, p_nif: nif || null, p_nombre_usuario: tuNombre || null })); },
  async misInvitaciones() { const c = await cliente(); return ok(await c.rpc('mis_invitaciones')); },
  async aceptarInvitacion(token, nombre) { const c = await cliente(); return ok(await c.rpc('aceptar_invitacion', { p_token: token, p_nombre: nombre || null })); },
  async guardarEmpresa(org, datos) { const c = await cliente(); return ok(await c.from('organizaciones').update(datos).eq('id', org).select().single()); },
  async planes() { const c = await cliente(); return ok(await c.from('planes').select('*').order('orden')); },

  // ---- jornada
  async fichar(org, tipo, o = {}) {
    const c = await cliente();
    return ok(await c.rpc('fichar', { p_org: org, p_tipo: tipo, p_lat: o.lat ?? null, p_lng: o.lng ?? null, p_precision: o.precision ?? null, p_cliente: o.cliente_id ?? null, p_nota: o.nota ?? null, p_proyecto: o.proyecto_id ?? null }));
  },
  async fichajes(org, { desde, hasta, user } = {}) {
    const c = await cliente();
    // Con su anulación, si la tiene (relación 1 a 1 con fichajes_anulados)
    let q = c.from('fichajes').select('*, fichajes_anulados(motivo, anulado_en)').eq('org_id', org).order('momento');
    // margen de ±1 día para cubrir la zona horaria; la vista agrupa por día local
    if (desde) q = q.gte('momento', new Date(Date.parse(desde + 'T00:00:00Z') - 864e5).toISOString());
    if (hasta) q = q.lte('momento', new Date(Date.parse(hasta + 'T23:59:59Z') + 864e5).toISOString());
    if (user) q = q.eq('user_id', user);
    return ok(await q).map(({ fichajes_anulados: a, ...f }) => ({ ...f, anulado: (Array.isArray(a) ? a[0] : a) || null }));
  },
  async resumen(org, desde, hasta, user) { const c = await cliente(); return ok(await c.rpc('resumen_jornada', { p_org: org, p_desde: desde, p_hasta: hasta, p_user: user || null })); },
  async tramos(org, desde, hasta, user) { const c = await cliente(); return ok(await c.rpc('tramos_jornada', { p_org: org, p_desde: desde, p_hasta: hasta, p_user: user || null })); },
  async solicitarCorreccion(org, tipo, momento, motivo) { const c = await cliente(); return ok(await c.rpc('solicitar_correccion', { p_org: org, p_tipo: tipo, p_momento: momento, p_motivo: motivo })); },
  async asignarCliente(org, momento, cliente_id, proyecto_id, user) { const c = await cliente(); return ok(await c.rpc('asignar_cliente', { p_org: org, p_momento: momento, p_cliente: cliente_id || null, p_proyecto: proyecto_id || null, p_user: user || null })); },
  async anularFichajes(org, ids, motivo) { const c = await cliente(); return ok(await c.rpc('anular_fichajes', { p_org: org, p_ids: ids, p_motivo: motivo })); },
  async correccionesPendientes(org) { const c = await cliente(); return ok(await c.from('fichajes').select('*').eq('org_id', org).eq('estado', 'PENDIENTE').order('momento')); },
  async revisarCorreccion(id, aprobar) { const c = await cliente(); return ok(await c.rpc('revisar_correccion', { p_id: id, p_aprobar: aprobar })); },

  // ---- clientes
  async clientes(org) { const c = await cliente(); return ok(await c.from('clientes').select('*').eq('org_id', org).order('nombre')); },
  async guardarCliente(org, x) {
    const c = await cliente(); const { id, ...datos } = x; datos.org_id = org;
    return ok(id ? await c.from('clientes').update(datos).eq('id', id).select().single() : await c.from('clientes').insert(datos).select().single());
  },
  // ---- proyectos
  async proyectos(org) { const c = await cliente(); return ok(await c.from('proyectos').select('*').eq('org_id', org).order('nombre')); },
  async guardarProyecto(org, x) {
    const c = await cliente(); const { id, ...datos } = x; datos.org_id = org;
    return ok(id ? await c.from('proyectos').update(datos).eq('id', id).select().single() : await c.from('proyectos').insert(datos).select().single());
  },
  async fijarUbicacion(id, lat, lng) { const c = await cliente(); return ok(await c.rpc('fijar_ubicacion_cliente', { p_cliente: id, p_lat: lat, p_lng: lng })); },

  // ---- equipo
  async miembros(org) { const c = await cliente(); return ok(await c.from('miembros').select('*').eq('org_id', org).order('nombre')); },
  async actualizarMiembro(org, user, datos) { const c = await cliente(); return ok(await c.from('miembros').update(datos).eq('org_id', org).eq('user_id', user)); },
  async invitaciones(org) { const c = await cliente(); return ok(await c.from('invitaciones').select('*').eq('org_id', org).is('aceptada_en', null).order('creada_en', { ascending: false })); },
  async invitar(org, email, rol, nombre) { const c = await cliente(); return ok(await c.rpc('invitar', { p_org: org, p_email: email, p_rol: rol, p_nombre: nombre || null })); },
  async borrarInvitacion(id) { const c = await cliente(); return ok(await c.from('invitaciones').delete().eq('id', id)); },

  // ---- copias
  async copia(org) { const c = await cliente(); return ok(await c.rpc('copia_jornada', { p_org: org })); },
  async registrarExportacion(org, tipo, periodo) { const c = await cliente(); return ok(await c.rpc('registrar_exportacion', { p_org: org, p_tipo: tipo, p_periodo: periodo })); },
  async clavesApi(org) { const c = await cliente(); return ok(await c.from('api_claves').select('id, nombre, prefijo, creada_en, revocada_en').eq('org_id', org).order('creada_en', { ascending: false })); },
  async crearClaveApi(org, nombre) { const c = await cliente(); return ok(await c.rpc('crear_clave_api', { p_org: org, p_nombre: nombre })); },
  async revocarClaveApi(id) { const c = await cliente(); return ok(await c.rpc('revocar_clave_api', { p_id: id })); },
  async exportaciones(org) { const c = await cliente(); return ok(await c.from('exportaciones').select('*').eq('org_id', org).order('hecha_en', { ascending: false }).limit(20)); },

  // ---- facturación (testers)
  async horasPendientes(org, cli, desde, hasta) { const c = await cliente(); return ok(await c.rpc('horas_pendientes', { p_org: org, p_cliente: cli, p_desde: desde, p_hasta: hasta })); },
  async productos(org) { const c = await cliente(); return ok(await c.from('productos').select('*').eq('org_id', org).eq('activo', true).order('codigo')); },
  async catalogoProductos(org) { const c = await cliente(); return ok(await c.from('v_productos').select('*').eq('org_id', org).order('familia').order('codigo')); },
  async guardarProducto(org, x) {
    const c = await cliente(); const { id, ...datos } = x; datos.org_id = org;
    return ok(id ? await c.from('productos').update(datos).eq('org_id', org).eq('id', id).select().single()
      : await c.from('productos').insert(datos).select().single());
  },
  async proveedores(org) { const c = await cliente(); return ok(await c.from('proveedores').select('*').eq('org_id', org).order('nombre')); },
  async guardarProveedor(org, id, datos) { const c = await cliente(); return ok(await c.from('proveedores').update(datos).eq('org_id', org).eq('id', id).select().single()); },
  async preciosProveedor(org) { const c = await cliente(); return ok(await c.from('precios_proveedor').select('*, productos(codigo,descripcion), proveedores(codigo,nombre)').eq('org_id', org).order('fecha', { ascending: false })); },
  async facturas(org) { const c = await cliente(); return ok(await c.from('v_facturas').select('*').eq('org_id', org).order('fecha', { ascending: false }).order('num', { ascending: false }).limit(200)); },
  async factura(org, id) {
    const c = await cliente();
    const [f, l] = await Promise.all([c.from('v_facturas').select('*').eq('org_id', org).eq('id', id).maybeSingle(),
      c.from('facturas_lineas').select('*').eq('factura_id', id).order('linea')]);
    return ok(f) && { ...f.data, lineas: ok(l) };
  },
  async borradores(org) { const c = await cliente(); return ok(await c.from('borradores').select('*').eq('org_id', org).eq('tipo', 'FACTURA').order('actualizado_en', { ascending: false })); },
  async presupuestos(org) { const c = await cliente(); return ok(await c.from('borradores').select('*').eq('org_id', org).eq('tipo', 'PRESUPUESTO').order('actualizado_en', { ascending: false })); },
  async borrador(org, id) { const c = await cliente(); return ok(await c.from('borradores').select('*').eq('org_id', org).eq('id', id).maybeSingle()); },
  async guardarBorrador(org, b) {
    const c = await cliente(); const fila = { org_id: org, tipo: b.tipo || 'FACTURA', cliente_id: b.cliente_id || null, datos: b.datos, total: b.total ?? null };
    return ok(b.id ? await c.from('borradores').update(fila).eq('id', b.id).select().single() : await c.from('borradores').insert(fila).select().single());
  },
  async borrarBorrador(id) { const c = await cliente(); return ok(await c.from('borradores').delete().eq('id', id)); },
  async solicitudesPrecio(org, presupuesto) { const c = await cliente(); return ok(await c.from('solicitudes_precio').select('*').eq('org_id', org).eq('presupuesto_id', presupuesto).order('solicitada_en', { ascending: false })); },
  async guardarSolicitudPrecio(org, x) { const c = await cliente(); return ok(await c.from('solicitudes_precio').insert({ ...x, org_id: org }).select().single()); },
  async emitirFactura(org, d) {
    const c = await cliente();
    return ok(await c.rpc('emitir_factura', { p_org: org, p_cliente: d.cliente_id, p_fecha: d.fecha, p_lineas: d.lineas, p_irpf_pct: d.irpf_pct ?? null,
      p_observaciones: d.observaciones || null, p_periodo_desde: d.desde || null, p_periodo_hasta: d.hasta || null, p_horas: d.rectifica ? null : d.horas || null,
      p_rectifica: d.rectifica?.id || null, p_motivo: d.rectifica ? motivoRectificativa(d.rectifica, d.motivo) : null, p_agrupacion: d.agrupacion || 'DETALLE',
      p_concepto: d.agrupacion === 'TOTAL' ? d.concepto || null : null }));
  },
  async registrarFacturaAnterior(org, d) {
    const c = await cliente();
    return ok(await c.rpc('registrar_factura_anterior', { p_org: org, p_cliente: d.cliente_id, p_num: d.num, p_fecha: d.fecha, p_lineas: d.lineas,
      p_irpf_pct: d.irpf_pct ?? null, p_observaciones: d.observaciones || null, p_agrupacion: d.agrupacion || 'DETALLE',
      p_concepto: d.agrupacion === 'TOTAL' ? d.concepto || null : null, p_cobrada: d.cobrada || null }));
  },
  async corregirTextosFactura(id, x) {
    const c = await cliente();
    return ok(await c.rpc('corregir_textos_factura', { p_factura: id, p_lineas: x.lineas || [], p_concepto: x.concepto || null, p_observaciones: x.observaciones || null }));
  },
};

// =====================================================================
// DEMO (localStorage) — mismas reglas básicas, para probar sin servidor
// =====================================================================
const K = 'gofio-demo-v1';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
function db() {
  let d = null; try { d = JSON.parse(localStorage.getItem(K)); } catch { }
  if (!d) {
    const org = uid(), yo = 'demo-user';
    d = {
      sesion: null,
      orgs: [{ id: org, nombre: 'Empresa de prueba', nif: '', plan_id: 'gratis', tester_facturacion: true, usa_facturacion: true,
               config: { zona_horaria: 'Atlantic/Canary', jornada_geolocalizar: true, jornada_horas_dia: 8, igic_defecto: 7, irpf_defecto: 15 } }],
      miembros: [{ org_id: org, user_id: yo, rol: 'propietario', nombre: 'Tú (demo)', activo: true },
                 { org_id: org, user_id: 'demo-2', rol: 'empleado', nombre: 'Ana Pérez', activo: true }],
      invitaciones: [],
      clientes: [
        { id: uid(), org_id: org, codigo: 'X2241917S', nombre: 'Casa María (ejemplo)', direccion: 'C/ Camino de la Cueva 22', cp: '38530', localidad: 'Cuevecitas', municipio: 'Candelaria', provincia: 'S/C de Tenerife', lat: null, lng: null, activo: true },
        { id: uid(), org_id: org, codigo: 'B00000001', nombre: 'Obra El Jardín (ejemplo)', direccion: 'Avenida de Obispo Pérez Cáceres', cp: '38500', localidad: 'Güímar', provincia: 'S/C de Tenerife', lat: 28.3137, lng: -16.4121, activo: true },
      ],
      fichajes: [], exportaciones: [], facturadas: [], facturas: [],
    };
  }
  d.proyectos = d.proyectos || [];
  return d;
}
function guardar(d) { try { localStorage.setItem(K, JSON.stringify(d)); } catch { } }
const PLANES = [
  { id: 'gratis', nombre: 'Jornada Gratis', max_usuarios: 5, backup_auto: false, export_auto: false, precio_mes_eur: 0 },
  { id: 'pro', nombre: 'Jornada Pro', max_usuarios: null, backup_auto: true, export_auto: true, precio_mes_eur: 0 },
];
// Igual que _cliente_de_proyecto en SQL
function proyectoCliente(d, proyecto_id, cliente_id) {
  if (!proyecto_id) return cliente_id || null;
  const p = d.proyectos.find(x => x.id === proyecto_id);
  if (!p) throw new Error('Proyecto no encontrado');
  if (p.activo === false) throw new Error(`El proyecto «${p.nombre}» está cerrado`);
  if (p.cliente_id && cliente_id && cliente_id !== p.cliente_id) throw new Error(`El proyecto «${p.nombre}» es de otro cliente`);
  return p.cliente_id || cliente_id || null;
}
const espera = (ms = 60) => new Promise(r => setTimeout(r, ms));

const demo = {
  async sesion() { return db().sesion; },
  async alCambiarSesion() { },
  async entrarConEmail(email) { const d = db(); d.sesion = { user: { id: 'demo-user', email } }; guardar(d); location.reload(); },
  async entrarConCodigo() { },
  async salir() { const d = db(); d.sesion = null; guardar(d); },
  async misEmpresas() {
    const d = db();
    return d.miembros.filter(m => m.user_id === 'demo-user' && m.activo).map(m => {
      const o = d.orgs.find(x => x.id === m.org_id);
      return { ...o, plan: PLANES.find(p => p.id === o.plan_id), rol: m.rol, mi_nombre: m.nombre, user_id: 'demo-user', usuario_email: d.sesion?.user?.email };
    });
  },
  async crearEmpresa(nombre, nif, tuNombre) {
    const d = db(); const id = uid();
    d.orgs.push({ id, nombre, nif, plan_id: 'gratis', tester_facturacion: false, usa_facturacion: false, config: { zona_horaria: 'Atlantic/Canary', jornada_geolocalizar: true, jornada_horas_dia: 8 } });
    d.miembros.push({ org_id: id, user_id: 'demo-user', rol: 'propietario', nombre: tuNombre, activo: true }); guardar(d); return id;
  },
  async misInvitaciones() { return []; },
  async aceptarInvitacion() { },
  async guardarEmpresa(org, datos) { const d = db(); Object.assign(d.orgs.find(o => o.id === org), datos); guardar(d); },
  async planes() { return PLANES; },

  async fichar(org, tipo, o = {}) {
    await espera();
    const d = db(); const mios = d.fichajes.filter(f => f.org_id === org && f.user_id === 'demo-user');
    const e = estadoActual(mios); const nuevos = [];
    const add = (tp, extra = {}) => { const f = { id: uid(), org_id: org, user_id: 'demo-user', tipo: tp, momento: new Date(Date.now() + nuevos.length).toISOString(), origen: 'APP', lat: o.lat ?? null, lng: o.lng ?? null, precision_m: o.precision ?? null, cliente_id: null, nota: null, ...extra }; nuevos.push(f); };
    const err = m => { throw new Error(m); };
    if (tipo === 'ENTRADA' && e.estado !== 'FUERA') err('Ya tienes la jornada iniciada');
    if (tipo === 'PAUSA' && e.estado !== 'TRABAJANDO') err('No estás trabajando ahora mismo');
    if (tipo === 'REANUDAR' && e.estado !== 'PAUSA') err('No estás en pausa');
    if (tipo === 'SALIDA') { if (e.estado === 'FUERA') err('No has iniciado la jornada'); if (e.desplazamiento) add('DESPLAZAMIENTO_FIN', { cliente_id: e.desplazamiento.cliente_id }); }
    if (tipo === 'DESPLAZAMIENTO_INICIO') { if (e.desplazamiento) err('Ya hay un desplazamiento en curso'); if (e.estado === 'FUERA') add('ENTRADA'); if (e.estado === 'PAUSA') add('REANUDAR'); }
    if (tipo === 'DESPLAZAMIENTO_FIN' && !e.desplazamiento) err('No hay ningún desplazamiento en curso');
    const proyecto_id = ['ENTRADA', 'CAMBIO_CLIENTE'].includes(tipo) ? o.proyecto_id || null : null;
    if (proyecto_id) o = { ...o, cliente_id: proyectoCliente(d, proyecto_id, o.cliente_id) };
    if (tipo === 'CAMBIO_CLIENTE' && (e.estado !== 'TRABAJANDO' || !(o.cliente_id || proyecto_id))) err('Elige un cliente o un proyecto con la jornada iniciada');
    add(tipo, { cliente_id: o.cliente_id ?? (tipo === 'DESPLAZAMIENTO_FIN' ? e.desplazamiento?.cliente_id : null), proyecto_id, nota: o.nota ?? null });
    d.fichajes.push(...nuevos); guardar(d); return nuevos;
  },
  async fichajes(org, { user } = {}) { return db().fichajes.filter(f => f.org_id === org && (!user || f.user_id === user)).sort((a, b) => a.momento.localeCompare(b.momento)); },
  async tramos(org, desde, hasta, user) {
    const fs = await demo.fichajes(org, { user }); const out = [];
    const grupos = {};
    for (const f of fs) { const k = f.user_id + '|' + diaLocal(new Date(f.momento_declarado || f.momento).getTime()); (grupos[k] = grupos[k] || []).push(f); }
    for (const [k, g] of Object.entries(grupos)) {
      const [u, dia] = k.split('|'); if (dia < desde || dia > hasta) continue;
      tramos(g, dia === diaLocal(Date.now()) ? Date.now() : null).forEach(t => out.push({ ...t, user_id: u, dia, inicio: new Date(t.inicio).toISOString(), fin: t.fin && new Date(t.fin).toISOString() }));
    }
    return out;
  },
  async resumen(org, desde, hasta, user) {
    const d = db(); const tr = await demo.tramos(org, desde, hasta, user); const g = {};
    tr.forEach(t => { const k = t.user_id + '|' + t.dia; (g[k] = g[k] || []).push({ ...t, inicio: Date.parse(t.inicio), fin: t.fin && Date.parse(t.fin) }); });
    return Object.entries(g).map(([k, ts]) => {
      const [u, dia] = k.split('|'); const s = totales(ts);
      return { user_id: u, nombre: d.miembros.find(m => m.user_id === u)?.nombre, dia, minutos_trabajo: s.trabajo, minutos_pausa: s.pausa,
               minutos_desplazamiento: s.desplazamiento, km_linea_recta: s.km, abierta: ts.some(t => !t.fin && t.tipo !== 'DESPLAZAMIENTO'), correcciones: 0,
               primera_entrada: new Date(Math.min(...ts.map(t => t.inicio))).toISOString(), ultima_salida: null };
    }).sort((a, b) => a.dia.localeCompare(b.dia));
  },
  async solicitarCorreccion(org, tipo, momento, motivo) {
    const d = db(); d.fichajes.push({ id: uid(), org_id: org, user_id: 'demo-user', tipo, momento: new Date().toISOString(), momento_declarado: momento, motivo, origen: 'CORRECCION', estado: 'PENDIENTE' }); guardar(d);
  },
  async asignarCliente(org, momento, cliente_id, proyecto_id, user) {
    const d = db(); cliente_id = proyectoCliente(d, proyecto_id, cliente_id);
    const f = { id: uid(), org_id: org, user_id: user || 'demo-user', tipo: 'CAMBIO_CLIENTE', cliente_id, proyecto_id: proyecto_id || null, momento: new Date().toISOString(), momento_declarado: momento, motivo: 'Cliente asignado a posteriori', origen: 'RESPONSABLE', estado: 'APROBADA' };
    d.fichajes.push(f); guardar(d); return f;
  },
  async anularFichajes(org, ids, motivo) {
    const d = db(); let n = 0;
    d.fichajes.filter(f => f.org_id === org && ids.includes(f.id) && !f.anulado).forEach(f => { f.anulado = { motivo, anulado_en: new Date().toISOString() }; n++; });
    guardar(d); return n;
  },
  async correccionesPendientes(org) { return db().fichajes.filter(f => f.org_id === org && f.estado === 'PENDIENTE'); },
  async revisarCorreccion(id, aprobar) { const d = db(); const f = d.fichajes.find(x => x.id === id); f.estado = aprobar ? 'APROBADA' : 'RECHAZADA'; guardar(d); },

  async clientes(org) { return db().clientes.filter(c => c.org_id === org).sort((a, b) => a.nombre.localeCompare(b.nombre)); },
  async guardarCliente(org, x) {
    const d = db();
    let fila;
    if (x.id) fila = Object.assign(d.clientes.find(c => c.id === x.id), x);
    else { if (d.clientes.some(c => c.org_id === org && c.codigo === x.codigo)) throw new Error('Ya existe un registro con ese código'); fila = { activo: true, ...x, id: uid(), org_id: org }; d.clientes.push(fila); }
    guardar(d);
    return { ...fila };
  },
  async proyectos(org) { return db().proyectos.filter(p => p.org_id === org).sort((a, b) => a.nombre.localeCompare(b.nombre)); },
  async guardarProyecto(org, x) {
    const d = db(); let fila;
    if (x.id) fila = Object.assign(d.proyectos.find(p => p.id === x.id), x);
    else { fila = { activo: true, tipo: 'PROPIO', ...x, id: uid(), org_id: org, creado_en: new Date().toISOString() }; d.proyectos.push(fila); }
    guardar(d); return { ...fila };
  },
  async fijarUbicacion(id, lat, lng) { const d = db(); Object.assign(d.clientes.find(c => c.id === id), { lat, lng }); guardar(d); },

  async miembros(org) { return db().miembros.filter(m => m.org_id === org); },
  async actualizarMiembro(org, user, datos) {
    const d = db(); const m = d.miembros.find(x => x.org_id === org && x.user_id === user);
    if (datos.activo && !m.activo && d.miembros.filter(x => x.org_id === org && x.activo).length >= 5) { const e = new Error('Tu plan permite 5 usuarios activos.'); e.limitePlan = true; throw e; }
    Object.assign(m, datos); guardar(d);
  },
  async invitaciones(org) { return db().invitaciones.filter(i => i.org_id === org); },
  async invitar(org, email, rol, nombre) {
    const d = db();
    if (d.miembros.filter(x => x.org_id === org && x.activo).length >= 5) { const e = new Error('Tu plan permite 5 usuarios activos.'); e.limitePlan = true; throw e; }
    const token = uid().replace(/-/g, ''); d.invitaciones.push({ id: uid(), org_id: org, email, rol, nombre, token, creada_en: new Date().toISOString() }); guardar(d); return token;
  },
  async borrarInvitacion(id) { const d = db(); d.invitaciones = d.invitaciones.filter(i => i.id !== id); guardar(d); },

  async copia(org) { const d = db(); return { formato: 'gofio-jornada/1', generada: new Date().toISOString(), empresa: d.orgs.find(o => o.id === org), miembros: await demo.miembros(org), clientes: await demo.clientes(org), fichajes: await demo.fichajes(org) }; },
  async registrarExportacion(org, tipo, periodo) { const d = db(); d.exportaciones.unshift({ id: uid(), org_id: org, tipo, periodo, ok: true, hecha_en: new Date().toISOString() }); guardar(d); },
  async clavesApi(org) { return (db().clavesApi || []).filter(k => k.org_id === org).sort((a, b) => b.creada_en.localeCompare(a.creada_en)); },
  async crearClaveApi(org, nombre) {
    if (!String(nombre || '').trim()) throw new Error('Ponle un nombre a la clave (p. ej. «Hoja de horarios»)');
    const d = db(); d.clavesApi = d.clavesApi || [];
    const clave = 'gj_' + Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
    d.clavesApi.push({ id: uid(), org_id: org, nombre: nombre.trim(), prefijo: clave.slice(0, 9), creada_en: new Date().toISOString(), revocada_en: null });
    guardar(d); return clave;
  },
  async revocarClaveApi(id) { const d = db(); const k = (d.clavesApi || []).find(x => x.id === id); if (k) k.revocada_en ||= new Date().toISOString(); guardar(d); },
  async exportaciones(org) { return db().exportaciones.filter(e => e.org_id === org); },

  async horasPendientes(org, cli, desde, hasta) {
    const d = db(); const tr = (await demo.tramos(org, desde, hasta)).filter(t => t.cliente_id === cli && t.fin && t.tipo !== 'PAUSA');
    const g = {};
    tr.forEach(t => { const k = [t.user_id, t.dia, t.tipo].join('|'); g[k] = g[k] || { user_id: t.user_id, nombre: d.miembros.find(m => m.user_id === t.user_id)?.nombre, dia: t.dia, tipo: t.tipo, minutos: 0, km: 0, tramos: 0 }; g[k].minutos += t.minutos; g[k].km += t.km || 0; g[k].tramos++; });
    return Object.values(g).filter(h => !d.facturadas.includes([cli, h.user_id, h.dia, h.tipo].join('|')));
  },
  async productos() { return (await demo.catalogoProductos()).filter(p => p.activo !== false); },
  async catalogoProductos() { const d = db(); d.productos = d.productos || [{ id: 'p1', codigo: '1HTEC', familia: 'MANO DE OBRA', descripcion: 'Hora de trabajo técnico', descripcion_factura: 'Hora de trabajo técnico', unidad: 'h', coste_ud: 0, pvp: 35, igic_pct: 7, activo: true }, { id: 'p2', codigo: 'TRANS', familia: 'TRANSPORTE', descripcion: 'Desplazamiento', descripcion_factura: 'Desplazamiento', unidad: 'ud', coste_ud: 10, pvp: 25, igic_pct: 7, activo: true, mejor_precio: 9.5, mejor_proveedor: 'Proveedor demo' }]; guardar(d); return d.productos; },
  async guardarProducto(org, x) {
    const d = db(); d.productos = await demo.catalogoProductos();
    if (d.productos.some(p => p.codigo === x.codigo && p.id !== x.id)) throw new Error('Ya existe un registro con ese código');
    let p = x.id && d.productos.find(y => y.id === x.id);
    if (p) Object.assign(p, x); else { p = { ...x, id: uid(), org_id: org }; d.productos.push(p); }
    guardar(d); return p;
  },
  async proveedores() { const d = db(); d.proveedores = d.proveedores || [{ id: 'prov1', codigo: 'PROV', nombre: 'Proveedor demo', web: 'https://example.com', email: 'compras@example.com', activo: true }]; guardar(d); return d.proveedores.map(p => p.email ? p : { ...p, email: 'compras@example.com' }); },
  async guardarProveedor(_org, id, datos) { const d = db(); d.proveedores = await demo.proveedores(); const p = d.proveedores.find(x => x.id === id); Object.assign(p, datos); guardar(d); return p; },
  async preciosProveedor() { return [{ id: 'precio1', producto_id: 'p2', proveedor_id: 'prov1', precio: 9.5, fecha: '2026-01-22', productos: { codigo: 'TRANS', descripcion: 'Desplazamiento' }, proveedores: { codigo: 'PROV', nombre: 'Proveedor demo' } }]; },
  async facturas(org) { return db().facturas.filter(f => f.org_id === org); },
  async factura(org, id) { return db().facturas.find(f => f.org_id === org && f.id === id) || null; },
  async emitirFactura(org, x) {
    const d = db(); const n = d.facturas.length + 1;
    if (!x.lineas?.length) throw new Error('La factura no tiene líneas');
    const o = d.orgs.find(y => y.id === org), c = d.clientes.find(y => y.id === x.cliente_id) || {};
    const t = calcular(x.lineas, x.irpf_pct ?? irpfCliente(c, o?.config));
    const lineas = t.lineas.map((l, i) => ({ linea: i + 1, codigo: l.codigo, descripcion: l.descripcion, cantidad: l.cantidad, unidad: l.unidad, pvp_ud: l.pvp,
      dto_pct: l.dto || 0, base: l.base, igic_pct: l.igic || 0, igic: l.cuota, familia: l.familia || null, categoria: categoriaDe(l), grupo: String(l.grupo || '').trim() || null }));
    const orig = x.rectifica && d.facturas.find(y => y.id === x.rectifica.id);
    if (x.rectifica && !String(x.motivo || '').trim()) throw new Error('Indica el motivo de la rectificación');
    const f = { id: uid(), org_id: org, num: (orig ? 'RECT-' : 'DEMO-') + String(n).padStart(4, '0'), tipo_doc: orig ? 'RECTIFICATIVA' : 'FACTURA', fecha: x.fecha,
      rectifica_a: orig?.id || null, motivo: orig ? motivoRectificativa(x.rectifica, x.motivo) : null, vencimiento: new Date(Date.parse(x.fecha) + 30 * 864e5).toISOString().slice(0, 10),
      periodo_desde: x.desde || null, periodo_hasta: x.hasta || null, cliente: { ...c }, emisor: emisorDe(o, t.igic_desglose),
      base: t.base, igic: t.igic, igic_desglose: t.igic_desglose, irpf_pct: x.irpf_pct ?? irpfCliente(c, o?.config), irpf: t.irpf, total: t.total,
      observaciones: x.observaciones || null, agrupacion: x.agrupacion || 'DETALLE',
      concepto: conceptoDe(x.agrupacion === 'TOTAL' ? x.concepto : '', x.lineas), lineas, huella: 'demo', estado_cobro: 'PENDIENTE' };
    d.facturas.unshift(f);
    if (orig) Object.assign(orig, { estado: 'RECTIFICADA', estado_cobro: 'RECTIFICADA' });
    if (!orig) (x.horas || []).forEach(h => d.facturadas.push([x.cliente_id, h.user_id, h.dia, h.tipo].join('|')));
    guardar(d); return f;
  },
  async registrarFacturaAnterior(org, x) {
    const d = db();
    const num = numeroAnterior(x.num, x.fecha);
    if (d.facturas.some(y => y.org_id === org && y.num === num)) throw new Error('Ya hay una factura con el número ' + num);
    if (!x.lineas?.length) throw new Error('La factura no tiene líneas');
    const o = d.orgs.find(y => y.id === org), c = d.clientes.find(y => y.id === x.cliente_id) || {};
    const t = calcular(x.lineas, x.irpf_pct ?? irpfCliente(c, o?.config));
    const lineas = t.lineas.map((l, i) => ({ linea: i + 1, codigo: l.codigo, descripcion: l.descripcion, cantidad: l.cantidad, unidad: l.unidad, pvp_ud: l.pvp,
      dto_pct: l.dto || 0, base: l.base, igic_pct: l.igic || 0, igic: l.cuota, familia: l.familia || null, categoria: categoriaDe(l), grupo: String(l.grupo || '').trim() || null }));
    const f = { id: uid(), org_id: org, num, serie: num.split('-')[0], tipo_doc: 'FACTURA', fecha: x.fecha, vencimiento: new Date(Date.parse(x.fecha) + 30 * 864e5).toISOString().slice(0, 10),
      cliente: { ...c }, emisor: emisorDe(o, t.igic_desglose), base: t.base, igic: t.igic, igic_desglose: t.igic_desglose, irpf_pct: x.irpf_pct ?? irpfCliente(c, o?.config),
      irpf: t.irpf, total: t.total, observaciones: x.observaciones || null, agrupacion: x.agrupacion || 'DETALLE',
      concepto: conceptoDe(x.agrupacion === 'TOTAL' ? x.concepto : '', x.lineas), lineas, huella: SIN_HUELLA, estado: 'HISTORICA', estado_cobro: 'HISTORICA',
      pendiente: x.cobrada ? 0 : t.total };
    d.facturas.push(f); d.facturas.sort((a, b) => b.fecha.localeCompare(a.fecha));
    guardar(d); return f;
  },
  async corregirTextosFactura(id, x) {
    const d = db(); const f = d.facturas.find(y => y.id === id);
    for (const l of x.lineas || []) {
      if (!String(l.descripcion || '').trim()) throw new Error('Todas las líneas necesitan una descripción');
      Object.assign(f.lineas.find(y => y.linea === l.linea), { descripcion: l.descripcion.trim(), grupo: String(l.grupo || '').trim() || null }, l.orden ? { orden: l.orden } : {});
    }
    if (String(x.concepto || '').trim()) f.concepto = x.concepto.trim();
    f.observaciones = String(x.observaciones || '').trim() || null; f.textos_corregidos_en = new Date().toISOString();
    guardar(d); return f;
  },
  async borradores(org) { return (db().borradores || []).filter(b => b.org_id === org && (b.tipo || 'FACTURA') === 'FACTURA').sort((a, b) => b.actualizado_en.localeCompare(a.actualizado_en)); },
  async presupuestos(org) { return (db().borradores || []).filter(b => b.org_id === org && b.tipo === 'PRESUPUESTO').sort((a, b) => b.actualizado_en.localeCompare(a.actualizado_en)); },
  async borrador(org, id) { return (db().borradores || []).find(b => b.org_id === org && b.id === id) || null; },
  async guardarBorrador(org, b) {
    const d = db(); d.borradores = d.borradores || [];
    const fila = { org_id: org, tipo: b.tipo || 'FACTURA', cliente_id: b.cliente_id || null, datos: b.datos, total: b.total ?? null, actualizado_en: new Date().toISOString() };
    let r = b.id && d.borradores.find(x => x.id === b.id);
    if (r) Object.assign(r, fila); else { r = { id: uid(), ...fila }; d.borradores.push(r); }
    guardar(d); return r;
  },
  async borrarBorrador(id) { const d = db(); d.borradores = (d.borradores || []).filter(b => b.id !== id); guardar(d); },
  async solicitudesPrecio(_org, presupuesto) { return (db().solicitudesPrecio || []).filter(x => x.presupuesto_id === presupuesto).sort((a, b) => b.solicitada_en.localeCompare(a.solicitada_en)); },
  async guardarSolicitudPrecio(org, x) { const d = db(); d.solicitudesPrecio = d.solicitudesPrecio || []; const r = { id: uid(), org_id: org, solicitada_en: new Date().toISOString(), estado: 'SOLICITADA', ...x }; d.solicitudesPrecio.push(r); guardar(d); return r; },
};

export const api = DEMO ? demo : supa;
