// Capa de datos. La app solo habla con este módulo.
//  - Modo SUPABASE: config.js con URL y clave pública.
//  - Modo DEMO: sin configurar nada; guarda en este navegador para probar la app.
import { CONFIG } from '../config.js';
import { estadoActual, tramos, totales, diaLocal, plazoConservacion } from './lib/jornada.js';
import { esFirmaDe, deBase64 } from './lib/firma.js';
import { calcular, irpfCliente, emisorDe, categoriaDe, conceptoDe, motivoRectificativa, numeroAnterior, SIN_HUELLA } from './lib/factura.js';
const masDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export const DEMO = !CONFIG.SUPABASE_URL || /\?demo|#demo/.test(location.href);

let sb = null;
async function cliente() {
  if (!sb) {
    const { createClient } = await import('@supabase/supabase-js');
    sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
  }
  return sb;
}

// Correo de acceso para otra persona (al invitarla): cliente aparte, sin sesión, para no tocar la de quien invita.
// Flujo «implicit» para que el enlace funcione en el dispositivo de la persona invitada.
let sbAviso = null;
async function clienteAviso() {
  if (!sbAviso) {
    const { createClient } = await import('@supabase/supabase-js');
    sbAviso = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit', storageKey: 'gofio-aviso' } });
  }
  return sbAviso;
}

function ok({ data, error }) {
  if (error) {
    const e = new Error(traducir(error.message)); e.limitePlan = error.hint === 'LIMITE_PLAN'; e.hint = error.hint; throw e;
  }
  return data;
}
function traducir(m = '') {
  if (/row-level security/i.test(m)) return 'No tienes permiso para esta acción';
  if (/duplicate key.*horas_facturadas/i.test(m)) return 'Algunas de esas horas ya estaban facturadas';
  if (/duplicate key/i.test(m)) return 'Ya existe un registro con ese código';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Sin conexión. Inténtalo de nuevo.';
  if (/after (\d+) seconds?/i.test(m)) return `Espera ${m.match(/after (\d+) seconds?/i)[1]} segundos antes de pedir otro código`;
  if (/token has expired or is invalid|otp.*(expired|invalid)/i.test(m)) return 'El código no es correcto o ha caducado';
  if (/sms provider|phone provider|unsupported phone/i.test(m)) return 'El envío de SMS no está configurado. Usa el código por correo.';
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
  // ---- superadministración (Gofio Design)
  async esSuperadmin() { const c = await cliente(); return ok(await c.rpc('es_superadmin')); },
  async saEmpresas() { const c = await cliente(); return ok(await c.rpc('sa_empresas')); },
  async saCrearEmpresa(x) { const c = await cliente(); return ok(await c.rpc('sa_crear_empresa', { p_nombre: x.nombre, p_email_propietario: x.email, p_nif: x.nif || null, p_plan: x.plan, p_facturacion: !!x.facturacion })); },
  async saInvitarPropietario(org, email) { const c = await cliente(); return ok(await c.rpc('sa_invitar_propietario', { p_org: org, p_email: email })); },
  async saDarDeBaja(org, motivo) { const c = await cliente(); return ok(await c.rpc('sa_dar_de_baja', { p_org: org, p_motivo: motivo || null })); },
  async saReactivar(org) { const c = await cliente(); return ok(await c.rpc('sa_reactivar', { p_org: org })); },
  async saEliminarUnidad(org, nombre) { const c = await cliente(); return ok(await c.rpc('sa_eliminar_unidad', { p_org: org, p_nombre: nombre })); },
  async saCopiaUnidad(org) { const c = await cliente(); return ok(await c.rpc('sa_copia_unidad', { p_org: org })); },
  async saAnularInvitacion(org) { const c = await cliente(); return ok(await c.rpc('sa_anular_invitacion', { p_org: org })); },
  // Manda a la persona invitada el correo de acceso (plantilla «Magic Link» de Supabase)
  async avisarInvitado(email) {
    const c = await clienteAviso();
    return ok(await c.auth.signInWithOtp({ email: String(email).trim().toLowerCase(), options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } }));
  },
  async saActualizarEmpresa(id, x) { const c = await cliente(); return ok(await c.rpc('sa_actualizar_empresa', { p_org: id, p_plan: x.plan, p_plan_hasta: x.plan_hasta || null, p_facturacion: !!x.facturacion })); },
  async aceptarInvitacion(token, nombre) { const c = await cliente(); return ok(await c.rpc('aceptar_invitacion', { p_token: token, p_nombre: nombre || null })); },
  async guardarEmpresa(org, datos) { const c = await cliente(); return ok(await c.from('organizaciones').update(datos).eq('id', org).select().single()); },
  async planes() { const c = await cliente(); return ok(await c.from('planes').select('*').order('orden')); },

  // ---- jornada
  async fichar(org, tipo, o = {}) {
    const c = await cliente();
    return ok(await c.rpc('fichar', { p_org: org, p_tipo: tipo, p_lat: o.lat ?? null, p_lng: o.lng ?? null, p_precision: o.precision ?? null, p_cliente: o.cliente_id ?? null, p_nota: o.nota ?? null, p_proyecto: o.proyecto_id ?? null, p_qr: o.qr ?? null }));
  },
  // ---- puntos de fichaje con QR
  async puntosQr(org) { const c = await cliente(); return ok(await c.from('puntos_qr').select('*').eq('org_id', org).order('nombre')); },
  async guardarPuntoQr(org, x) {
    const c = await cliente(); const datos = { nombre: x.nombre, cliente_id: x.cliente_id || null, proyecto_id: x.proyecto_id || null, activo: x.activo !== false };
    return ok(x.id ? await c.from('puntos_qr').update(datos).eq('id', x.id).select().single()
      : await c.from('puntos_qr').insert({ ...datos, org_id: org }).select().single());
  },
  async renovarQr(id) { const c = await cliente(); return ok(await c.rpc('renovar_qr', { p_id: id })); },
  async puntoQr(token) { const c = await cliente(); return ok(await c.rpc('punto_qr', { p_token: token }))[0]; },

  // ---- firma mensual del registro
  async registroParaFirmar(org, periodo) { const c = await cliente(); return ok(await c.rpc('registro_para_firmar', { p_org: org, p_periodo: periodo })); },
  // Código de un solo uso de Supabase Auth a la propia cuenta. SMS: si la cuenta aún no tiene teléfono, primero se confirma.
  async enviarCodigoFirma(canal, telefono) {
    const c = await cliente(); const { data: { user } } = await c.auth.getUser();
    if (canal === 'EMAIL') { ok(await c.auth.signInWithOtp({ email: user.email, options: { shouldCreateUser: false } })); return { paso: 'firma', destino: user.email }; }
    if (user.phone) { const phone = '+' + user.phone.replace(/^\+/, ''); ok(await c.auth.signInWithOtp({ phone, options: { shouldCreateUser: false } })); return { paso: 'firma', destino: phone }; }
    if (!telefono) return { paso: 'telefono' };
    ok(await c.auth.updateUser({ phone: telefono })); return { paso: 'confirmar_telefono', destino: telefono };
  },
  async confirmarCodigoFirma(canal, token, { paso, destino } = {}) {
    const c = await cliente(); token = String(token).replace(/\D/g, '');
    if (canal === 'EMAIL') return ok(await c.auth.verifyOtp({ email: destino, token, type: 'email' }));
    return ok(await c.auth.verifyOtp({ phone: destino, token, type: paso === 'confirmar_telefono' ? 'phone_change' : 'sms' }));
  },
  async firmarRegistro(org, periodo, huella, canal) { const c = await cliente(); return ok(await c.rpc('firmar_registro', { p_org: org, p_periodo: periodo, p_huella: huella, p_canal: canal })); },
  async firmarConCertificado(org, periodo, huella, firma) { const c = await cliente(); return ok(await c.rpc('firmar_registro_certificado', { p_org: org, p_periodo: periodo, p_huella: huella, p_firma: firma })); },
  async estadoFirmas(org, periodo) { const c = await cliente(); return ok(await c.rpc('estado_firmas', { p_org: org, p_periodo: periodo })); },
  async firma(id) { const c = await cliente(); return ok(await c.from('firmas_registro').select('*').eq('id', id).single()); },
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
  // ---- notas de los tramos de trabajo (tareas y materiales)
  async notasTramo(org, desde, hasta, user) {
    const c = await cliente();
    // margen de un día por la zona horaria; se cruza con los tramos por persona y hora de inicio
    let q = c.from('notas_tramo').select('*').eq('org_id', org).gte('inicio', masDias(desde, -1)).lt('inicio', masDias(hasta, 2));
    if (user) q = q.eq('user_id', user);
    return ok(await q);
  },
  async guardarNotaTramo(org, x) {
    const c = await cliente(); const fila = { org_id: org, user_id: x.user_id, inicio: x.inicio, texto: x.texto || '', materiales: x.materiales || [] };
    if (!fila.texto.trim() && !fila.materiales.length) {
      return ok(await c.from('notas_tramo').delete().eq('org_id', org).eq('user_id', x.user_id).eq('inicio', x.inicio));
    }
    return ok(await c.from('notas_tramo').upsert(fila, { onConflict: 'org_id,user_id,inicio' }).select().single());
  },
  async importarClientes(org, filas) {
    if (!filas.length) return [];
    const c = await cliente(); return ok(await c.from('clientes').insert(filas.map(x => ({ ...x, org_id: org }))).select());
  },
  // ---- tiempo personal: privado, solo lo ve quien lo apunta (no es un fichaje)
  async tareasPersonales() { const c = await cliente(); return ok(await c.from('tareas_personales').select('*').order('orden').order('nombre')); },
  async guardarTareaPersonal(x) {
    const c = await cliente(); const { id, ...datos } = x;
    return ok(id ? await c.from('tareas_personales').update(datos).eq('id', id).select().single() : await c.from('tareas_personales').insert(datos).select().single());
  },
  async crearTareasPersonales(nombres) {
    if (!nombres.length) return [];
    const c = await cliente();
    return ok(await c.from('tareas_personales').upsert(nombres.map((nombre, orden) => ({ nombre, orden })), { onConflict: 'user_id,nombre', ignoreDuplicates: true }).select());
  },
  async tiemposPersonales(desde, hasta) {
    const c = await cliente();
    return ok(await c.from('tiempos_personales').select('*').gte('inicio', masDias(desde, -1)).lt('inicio', masDias(hasta, 2)).order('inicio'));
  },
  async empezarPersonal(tarea_id) {
    const c = await cliente(); const ahora = new Date().toISOString();
    ok(await c.from('tiempos_personales').update({ fin: ahora }).is('fin', null));
    return ok(await c.from('tiempos_personales').insert({ tarea_id, inicio: ahora }).select().single());
  },
  async pararPersonal() { const c = await cliente(); return ok(await c.from('tiempos_personales').update({ fin: new Date().toISOString() }).is('fin', null)); },
  async borrarTiempoPersonal(id) { const c = await cliente(); return ok(await c.from('tiempos_personales').delete().eq('id', id)); },
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
const tokenDemo = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(16).padStart(2, '0')).join('');
const hm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
// Documento del mes en la demo: mismo formato que _documento_registro en SQL
async function documentoDemo(d, org, user, periodo) {
  const o = d.orgs.find(x => x.id === org); const m = d.miembros.find(x => x.org_id === org && x.user_id === user) || {};
  const tz = o.config?.zona_horaria || 'Atlantic/Canary'; const hasta = masDias(masDias(periodo, 32).slice(0, 8) + '01', -1);
  const dias = (await demo.resumen(org, periodo, hasta, user)).filter(r => r.user_id === user && r.dia >= periodo && r.dia <= hasta);
  const hhmm = x => x ? new Date(x).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: tz }) : '';
  const minutos = dias.reduce((s, r) => s + r.minutos_trabajo, 0);
  const documento = 'REGISTRO DE JORNADA\n' + `Empresa: ${o.nombre}${o.nif ? ' · NIF ' + o.nif : ''}\n` + `Persona: ${m.nombre || '—'}${m.nif ? ' · NIF ' + m.nif : ''}\n`
    + `Periodo: del ${periodo} al ${hasta} (hora de ${tz})\n\n` + 'Día;Entrada;Salida;Trabajo;Pausas;Desplazamientos;Correcciones\n'
    + dias.map(r => [r.dia, hhmm(r.primera_entrada), r.abierta ? 'sin cerrar' : hhmm(r.ultima_salida), hm(r.minutos_trabajo), hm(r.minutos_pausa), hm(r.minutos_desplazamiento), r.correcciones].join(';') + '\n').join('')
    + `\nTotal: ${hm(minutos)} de trabajo en ${dias.length} ${dias.length === 1 ? 'día' : 'días'}\n`;
  const huella = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(documento))), b => b.toString(16).padStart(2, '0')).join('');
  return { documento, huella, dias: dias.length, minutos };
}
async function firmarDemo(org, periodo, huella, metodo, destino, firma_cms) {
  const d = db(); const r = await documentoDemo(d, org, 'demo-user', periodo);
  if (!r.dias) throw new Error('No hay jornadas que firmar en ese mes');
  if (huella !== r.huella) throw new Error('El registro ha cambiado mientras lo mirabas. Vuelve a abrirlo antes de firmar.');
  d.firmas = d.firmas || [];
  if (d.firmas.some(f => f.org_id === org && f.user_id === 'demo-user' && f.periodo === periodo && f.huella === huella)) throw new Error('Ya has firmado este registro');
  const f = { id: uid(), org_id: org, user_id: 'demo-user', periodo, ...r, metodo, destino, firma_cms, firmado_en: new Date().toISOString() };
  d.firmas.push(f); guardar(d); return f;
}

const demo = {
  async sesion() { return db().sesion; },
  async alCambiarSesion() { },
  async entrarConEmail(email) { const d = db(); d.sesion = { user: { id: 'demo-user', email } }; guardar(d); location.reload(); },
  async entrarConCodigo() { },
  async salir() { const d = db(); d.sesion = null; guardar(d); },
  async misEmpresas() {
    const d = db();
    return d.miembros.filter(m => m.user_id === 'demo-user' && m.activo && !d.orgs.find(x => x.id === m.org_id)?.baja_en).map(m => {
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
  // En la demo eres superadmin para poder probar el panel
  async esSuperadmin() { return true; },
  async saEmpresas() {
    const d = db();
    return d.orgs.map(o => ({ id: o.id, nombre: o.nombre, nif: o.nif, plan_id: o.plan_id, plan_hasta: o.plan_hasta || null, tester_facturacion: !!o.tester_facturacion,
      usa_facturacion: !!o.usa_facturacion, creado_en: o.creado_en || new Date().toISOString(),
      propietario: d.miembros.find(m => m.org_id === o.id && m.rol === 'propietario') ? (d.miembros.find(m => m.org_id === o.id && m.rol === 'propietario').user_id === 'demo-user' ? d.sesion?.user?.email : 'otro') : null,
      usuarios: d.miembros.filter(m => m.org_id === o.id && m.activo).length,
      invitacion_pendiente: d.invitaciones.find(i => i.org_id === o.id && i.rol === 'propietario' && !i.aceptada_en)?.email || null,
      ultimo_fichaje: d.fichajes.filter(f => f.org_id === o.id).map(f => f.momento).sort().at(-1) || null,
      con_registros: d.fichajes.some(f => f.org_id === o.id) || d.facturas.some(f => f.org_id === o.id),
      baja_en: o.baja_en || null, baja_motivo: o.baja_motivo || null, eliminar_desde: o.eliminar_desde || null }))
      .sort((a, b) => !!a.baja_en - !!b.baja_en);
  },
  async saDarDeBaja(org, motivo) {
    const d = db(); const o = d.orgs.find(x => x.id === org);
    if (o.baja_en) throw new Error('La unidad ya está de baja');
    const ultimoFichaje = d.fichajes.filter(f => f.org_id === org).map(f => f.momento_declarado || f.momento).sort().at(-1);
    const ultimaFactura = d.facturas.filter(f => f.org_id === org).map(f => f.fecha).sort().at(-1);
    Object.assign(o, { baja_en: new Date().toISOString(), baja_motivo: motivo || null,
      eliminar_desde: plazoConservacion({ ultimoFichaje, ultimaFactura, hoy: new Date().toISOString().slice(0, 10) }) });
    d.invitaciones = d.invitaciones.filter(i => !(i.org_id === org && !i.aceptada_en));
    guardar(d); return o.eliminar_desde;
  },
  async saReactivar(org) { const d = db(); Object.assign(d.orgs.find(x => x.id === org), { baja_en: null, baja_motivo: null, eliminar_desde: null }); guardar(d); },
  async saEliminarUnidad(org, nombre) {
    const d = db(); const o = d.orgs.find(x => x.id === org);
    if ((nombre || '').trim().toLowerCase() !== o.nombre.trim().toLowerCase()) throw new Error('Escribe el nombre exacto de la unidad para confirmar');
    const registros = d.fichajes.some(f => f.org_id === org) || d.facturas.some(f => f.org_id === org);
    if (registros && !o.baja_en) throw new Error('La unidad tiene fichajes o facturas: dala de baja y podrás eliminarla cuando acabe el plazo legal');
    if (registros && o.eliminar_desde > new Date().toISOString().slice(0, 10)) throw new Error(`Hay que conservar sus datos hasta el ${o.eliminar_desde}`);
    for (const k of Object.keys(d)) if (Array.isArray(d[k])) d[k] = d[k].filter(x => x?.org_id !== org);
    d.orgs = d.orgs.filter(x => x.id !== org); guardar(d);
  },
  async saCopiaUnidad(org) { const d = db(); return { formato: 'gofio-unidad/1', generada: new Date().toISOString(), empresa: d.orgs.find(o => o.id === org),
    ...Object.fromEntries(['miembros', 'clientes', 'fichajes', 'facturas'].map(k => [k, (d[k] || []).filter(x => x.org_id === org)])) }; },
  async saCrearEmpresa(x) {
    if (!String(x.nombre || '').trim()) throw new Error('Escribe el nombre de la unidad');
    const email = String(x.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Escribe un email válido para el propietario');
    const d = db(); const id = uid();
    d.orgs.push({ id, nombre: x.nombre.trim(), nif: x.nif || '', plan_id: x.plan, tester_facturacion: !!x.facturacion, usa_facturacion: !!x.facturacion, config: { ...d.orgs[0].config }, creado_en: new Date().toISOString() });
    d.invitaciones.push({ id: uid(), org_id: id, email, rol: 'propietario', token: uid(), creada_en: new Date().toISOString(), aceptada_en: null });
    guardar(d); return id;
  },
  async saInvitarPropietario(org, email) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Escribe un email válido para el propietario');
    const d = db(); d.invitaciones = d.invitaciones.filter(i => !(i.org_id === org && i.rol === 'propietario' && !i.aceptada_en));
    d.invitaciones.push({ id: uid(), org_id: org, email, rol: 'propietario', token: uid(), creada_en: new Date().toISOString(), aceptada_en: null }); guardar(d);
  },
  async saAnularInvitacion(org) { const d = db(); d.invitaciones = d.invitaciones.filter(i => !(i.org_id === org && i.rol === 'propietario' && !i.aceptada_en)); guardar(d); },
  async avisarInvitado() { },   // en la demo no se envían correos
  async saActualizarEmpresa(id, x) {
    const d = db(); const o = d.orgs.find(y => y.id === id);
    o.usa_facturacion = !x.facturacion ? false : !o.tester_facturacion ? true : o.usa_facturacion;
    Object.assign(o, { plan_id: x.plan, plan_hasta: x.plan_hasta || null, tester_facturacion: !!x.facturacion }); guardar(d);
  },

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
    // Igual que fichar(p_qr) en SQL: el punto da el cliente o proyecto si no se elige otro
    const punto = o.qr ? (d.puntosQr || []).find(p => p.token === o.qr && p.org_id === org && p.activo !== false) : null;
    if (o.qr && !punto) err('Este código QR no es de tu empresa o ya no está activo');
    if (punto && ['ENTRADA', 'CAMBIO_CLIENTE'].includes(tipo) && !o.cliente_id && !o.proyecto_id) o = { ...o, cliente_id: punto.cliente_id, proyecto_id: punto.proyecto_id };
    if (punto && tipo === 'DESPLAZAMIENTO_FIN' && !o.cliente_id) o = { ...o, cliente_id: punto.cliente_id };
    const proyecto_id = ['ENTRADA', 'CAMBIO_CLIENTE'].includes(tipo) ? o.proyecto_id || null : null;
    if (proyecto_id) o = { ...o, cliente_id: proyectoCliente(d, proyecto_id, o.cliente_id) };
    if (tipo === 'CAMBIO_CLIENTE' && (e.estado !== 'TRABAJANDO' || !(o.cliente_id || proyecto_id))) err('Elige un cliente o un proyecto con la jornada iniciada');
    add(tipo, { cliente_id: o.cliente_id ?? (tipo === 'DESPLAZAMIENTO_FIN' ? e.desplazamiento?.cliente_id : null), proyecto_id, nota: o.nota ?? null, punto_id: punto?.id || null });
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
  async notasTramo(org, desde, hasta, user) {
    return (db().notas || []).filter(n => n.org_id === org && (!user || n.user_id === user)
      && n.inicio.slice(0, 10) >= masDias(desde, -1) && n.inicio.slice(0, 10) <= masDias(hasta, 1));
  },
  async guardarNotaTramo(org, x) {
    const d = db(); d.notas = (d.notas || []).filter(n => !(n.org_id === org && n.user_id === x.user_id && Date.parse(n.inicio) === Date.parse(x.inicio)));
    const n = { id: uid(), org_id: org, user_id: x.user_id, inicio: new Date(x.inicio).toISOString(), texto: x.texto || '', materiales: x.materiales || [] };
    if (n.texto.trim() || n.materiales.length) d.notas.push(n);
    guardar(d); return n;
  },
  async anularFichajes(org, ids, motivo) {
    const d = db(); let n = 0;
    d.fichajes.filter(f => f.org_id === org && ids.includes(f.id) && !f.anulado).forEach(f => { f.anulado = { motivo, anulado_en: new Date().toISOString() }; n++; });
    guardar(d); return n;
  },
  async correccionesPendientes(org) { return db().fichajes.filter(f => f.org_id === org && f.estado === 'PENDIENTE'); },
  // ---- puntos QR (demo)
  async puntosQr(org) { return (db().puntosQr || []).filter(p => p.org_id === org).sort((a, b) => a.nombre.localeCompare(b.nombre)); },
  async guardarPuntoQr(org, x) {
    if (!String(x.nombre || '').trim()) throw new Error('Escribe un nombre para el punto');
    const d = db(); d.puntosQr = d.puntosQr || [];
    const datos = { nombre: x.nombre.trim(), cliente_id: x.cliente_id || null, proyecto_id: x.proyecto_id || null, activo: x.activo !== false };
    let p = x.id && d.puntosQr.find(y => y.id === x.id);
    if (p) Object.assign(p, datos); else { p = { id: uid(), org_id: org, token: tokenDemo(), creado_en: new Date().toISOString(), ...datos }; d.puntosQr.push(p); }
    guardar(d); return p;
  },
  async renovarQr(id) { const d = db(); const p = d.puntosQr.find(y => y.id === id); p.token = tokenDemo(); guardar(d); return p.token; },
  async puntoQr(token) {
    const p = (db().puntosQr || []).find(y => y.token === token && y.activo !== false);
    if (!p) throw new Error('Este código QR no es de tu empresa o ya no está activo');
    return p;
  },

  // ---- firma del registro (demo: el código siempre es 123456)
  async registroParaFirmar(org, periodo) {
    const d = db(); const r = await documentoDemo(d, org, 'demo-user', periodo);
    const f = (d.firmas || []).filter(x => x.org_id === org && x.user_id === 'demo-user' && x.periodo === periodo).at(-1);
    const o = d.orgs.find(x => x.id === org);
    return { ...r, periodo, cerrado: masDias(periodo, 32).slice(0, 8) + '01' <= diaLocal(Date.now(), o.config?.zona_horaria),
      vigente: !!f && f.huella === r.huella, firma: f ? { id: f.id, metodo: f.metodo, destino: f.destino, firmado_en: f.firmado_en, huella: f.huella } : null };
  },
  async enviarCodigoFirma(canal, telefono) {
    const destino = canal === 'EMAIL' ? db().sesion?.user?.email || 'demo@ejemplo.com' : telefono || '+34600000000';
    return { paso: 'firma', destino, demo: true };
  },
  async confirmarCodigoFirma(_canal, token) {
    if (String(token).replace(/\D/g, '') !== '123456') throw new Error('El código no es correcto o ha caducado');
    const d = db(); d.codigoFirma = Date.now(); guardar(d);
  },
  async firmarRegistro(org, periodo, huella, canal) {
    if (Date.now() - (db().codigoFirma || 0) > 600000) throw Object.assign(new Error('Escribe el código que te hemos enviado antes de firmar'), { hint: 'CODIGO_FIRMA' });
    return firmarDemo(org, periodo, huella, canal, canal === 'EMAIL' ? db().sesion?.user?.email || 'demo@ejemplo.com' : '+34600000000', null);
  },
  async firmarConCertificado(org, periodo, huella, firma) {
    const r = await documentoDemo(db(), org, 'demo-user', periodo);
    if (!(await esFirmaDe(deBase64(firma), r.documento))) throw new Error('Esa firma no es del registro de este mes. Firma el documento que has descargado, sin cambiarlo.');
    return firmarDemo(org, periodo, huella, 'CERTIFICADO', null, firma);
  },
  async estadoFirmas(org, periodo) {
    const d = db(); const out = [];
    for (const m of d.miembros.filter(x => x.org_id === org)) {
      const r = await documentoDemo(d, org, m.user_id, periodo);
      const f = (d.firmas || []).filter(x => x.org_id === org && x.user_id === m.user_id && x.periodo === periodo).at(-1);
      if (!r.dias && !f) continue;
      out.push({ user_id: m.user_id, nombre: m.nombre, dias: r.dias, minutos: r.minutos, firma_id: f?.id || null, metodo: f?.metodo || null,
        destino: f?.destino || null, firmado_en: f?.firmado_en || null, vigente: !!f && f.huella === r.huella });
    }
    return out;
  },
  async firma(id) { return (db().firmas || []).find(f => f.id === id); },

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
  async importarClientes(org, filas) { const r = []; for (const x of filas) r.push(await demo.guardarCliente(org, x)); return r; },
  async tareasPersonales() { return (db().tareasPersonales || []).slice().sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre)); },
  async guardarTareaPersonal(x) {
    const d = db(); d.tareasPersonales = d.tareasPersonales || []; let fila;
    if (x.id) fila = Object.assign(d.tareasPersonales.find(t => t.id === x.id), x);
    else {
      if (d.tareasPersonales.some(t => t.nombre.toLowerCase() === x.nombre.toLowerCase())) throw new Error('Ya tienes una tarea con ese nombre');
      fila = { activa: true, orden: d.tareasPersonales.length, ...x, id: uid() }; d.tareasPersonales.push(fila);
    }
    guardar(d); return { ...fila };
  },
  async crearTareasPersonales(nombres) {
    const d = db(); d.tareasPersonales = d.tareasPersonales || [];
    nombres.forEach((nombre, orden) => { if (!d.tareasPersonales.some(t => t.nombre === nombre)) d.tareasPersonales.push({ id: uid(), nombre, orden, activa: true }); });
    guardar(d); return d.tareasPersonales;
  },
  async tiemposPersonales() { return db().tiemposPersonales || []; },
  async empezarPersonal(tarea_id) {
    const d = db(); d.tiemposPersonales = d.tiemposPersonales || []; const ahora = new Date().toISOString();
    d.tiemposPersonales.forEach(t => { if (!t.fin) t.fin = ahora; });
    const fila = { id: uid(), tarea_id, inicio: ahora, fin: null }; d.tiemposPersonales.push(fila); guardar(d); return fila;
  },
  async pararPersonal() { const d = db(); const ahora = new Date().toISOString(); (d.tiemposPersonales || []).forEach(t => { if (!t.fin) t.fin = ahora; }); guardar(d); },
  async borrarTiempoPersonal(id) { const d = db(); d.tiemposPersonales = (d.tiemposPersonales || []).filter(t => t.id !== id); guardar(d); },
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
