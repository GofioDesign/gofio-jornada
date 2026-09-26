// Capa de datos. La app solo habla con este módulo.
//  - Modo SUPABASE: config.js con URL y clave pública.
//  - Modo DEMO: sin configurar nada; guarda en este navegador para probar la app.
import { CONFIG } from '../config.js';
import { estadoActual, tramos, totales, diaLocal } from './lib/jornada.js';

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
    return ok(await c.rpc('fichar', { p_org: org, p_tipo: tipo, p_lat: o.lat ?? null, p_lng: o.lng ?? null, p_precision: o.precision ?? null, p_cliente: o.cliente_id ?? null, p_nota: o.nota ?? null }));
  },
  async fichajes(org, { desde, hasta, user } = {}) {
    const c = await cliente();
    let q = c.from('fichajes').select('*').eq('org_id', org).order('momento');
    // margen de ±1 día para cubrir la zona horaria; la vista agrupa por día local
    if (desde) q = q.gte('momento', new Date(Date.parse(desde + 'T00:00:00Z') - 864e5).toISOString());
    if (hasta) q = q.lte('momento', new Date(Date.parse(hasta + 'T23:59:59Z') + 864e5).toISOString());
    if (user) q = q.eq('user_id', user);
    return ok(await q);
  },
  async resumen(org, desde, hasta, user) { const c = await cliente(); return ok(await c.rpc('resumen_jornada', { p_org: org, p_desde: desde, p_hasta: hasta, p_user: user || null })); },
  async tramos(org, desde, hasta, user) { const c = await cliente(); return ok(await c.rpc('tramos_jornada', { p_org: org, p_desde: desde, p_hasta: hasta, p_user: user || null })); },
  async solicitarCorreccion(org, tipo, momento, motivo) { const c = await cliente(); return ok(await c.rpc('solicitar_correccion', { p_org: org, p_tipo: tipo, p_momento: momento, p_motivo: motivo })); },
  async correccionesPendientes(org) { const c = await cliente(); return ok(await c.from('fichajes').select('*').eq('org_id', org).eq('estado', 'PENDIENTE').order('momento')); },
  async revisarCorreccion(id, aprobar) { const c = await cliente(); return ok(await c.rpc('revisar_correccion', { p_id: id, p_aprobar: aprobar })); },

  // ---- clientes
  async clientes(org) { const c = await cliente(); return ok(await c.from('clientes').select('*').eq('org_id', org).order('nombre')); },
  async guardarCliente(org, x) {
    const c = await cliente(); const { id, ...datos } = x; datos.org_id = org;
    return ok(id ? await c.from('clientes').update(datos).eq('id', id).select().single() : await c.from('clientes').insert(datos).select().single());
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
  async exportaciones(org) { const c = await cliente(); return ok(await c.from('exportaciones').select('*').eq('org_id', org).order('hecha_en', { ascending: false }).limit(20)); },

  // ---- facturación (testers)
  async horasPendientes(org, cli, desde, hasta) { const c = await cliente(); return ok(await c.rpc('horas_pendientes', { p_org: org, p_cliente: cli, p_desde: desde, p_hasta: hasta })); },
  async productos(org) { const c = await cliente(); return ok(await c.from('productos').select('*').eq('org_id', org).eq('activo', true).order('codigo')); },
  async facturas(org) { const c = await cliente(); return ok(await c.from('v_facturas').select('*').eq('org_id', org).order('fecha', { ascending: false }).order('num', { ascending: false }).limit(200)); },
  async factura(org, id) {
    const c = await cliente();
    const [f, l] = await Promise.all([c.from('v_facturas').select('*').eq('org_id', org).eq('id', id).maybeSingle(),
      c.from('facturas_lineas').select('*').eq('factura_id', id).order('linea')]);
    return ok(f) && { ...f.data, lineas: ok(l) };
  },
  async emitirFactura(org, d) {
    const c = await cliente();
    return ok(await c.rpc('emitir_factura', { p_org: org, p_cliente: d.cliente_id, p_fecha: d.fecha, p_lineas: d.lineas, p_irpf_pct: d.irpf_pct ?? null,
      p_observaciones: d.observaciones || null, p_periodo_desde: d.desde || null, p_periodo_hasta: d.hasta || null, p_horas: d.horas || null }));
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
  return d;
}
function guardar(d) { try { localStorage.setItem(K, JSON.stringify(d)); } catch { } }
const PLANES = [
  { id: 'gratis', nombre: 'Jornada Gratis', max_usuarios: 5, backup_auto: false, export_auto: false, precio_mes_eur: 0 },
  { id: 'pro', nombre: 'Jornada Pro', max_usuarios: null, backup_auto: true, export_auto: true, precio_mes_eur: 0 },
];
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
    if (tipo === 'CAMBIO_CLIENTE' && (e.estado !== 'TRABAJANDO' || !o.cliente_id)) err('Elige un cliente con la jornada iniciada');
    add(tipo, { cliente_id: o.cliente_id ?? (tipo === 'DESPLAZAMIENTO_FIN' ? e.desplazamiento?.cliente_id : null), nota: o.nota ?? null });
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
  async correccionesPendientes(org) { return db().fichajes.filter(f => f.org_id === org && f.estado === 'PENDIENTE'); },
  async revisarCorreccion(id, aprobar) { const d = db(); const f = d.fichajes.find(x => x.id === id); f.estado = aprobar ? 'APROBADA' : 'RECHAZADA'; guardar(d); },

  async clientes(org) { return db().clientes.filter(c => c.org_id === org).sort((a, b) => a.nombre.localeCompare(b.nombre)); },
  async guardarCliente(org, x) {
    const d = db();
    if (x.id) Object.assign(d.clientes.find(c => c.id === x.id), x);
    else { if (d.clientes.some(c => c.org_id === org && c.codigo === x.codigo)) throw new Error('Ya existe un registro con ese código'); d.clientes.push({ ...x, id: uid(), org_id: org, activo: true }); }
    guardar(d);
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
  async exportaciones(org) { return db().exportaciones.filter(e => e.org_id === org); },

  async horasPendientes(org, cli, desde, hasta) {
    const d = db(); const tr = (await demo.tramos(org, desde, hasta)).filter(t => t.cliente_id === cli && t.fin && t.tipo !== 'PAUSA');
    const g = {};
    tr.forEach(t => { const k = [t.user_id, t.dia, t.tipo].join('|'); g[k] = g[k] || { user_id: t.user_id, nombre: d.miembros.find(m => m.user_id === t.user_id)?.nombre, dia: t.dia, tipo: t.tipo, minutos: 0, km: 0, tramos: 0 }; g[k].minutos += t.minutos; g[k].km += t.km || 0; g[k].tramos++; });
    return Object.values(g).filter(h => !d.facturadas.includes([cli, h.user_id, h.dia, h.tipo].join('|')));
  },
  async productos() { return [{ id: 'p1', codigo: '1HTEC', descripcion_factura: 'Hora de trabajo técnico', unidad: 'h', pvp: 35, igic_pct: 7 }, { id: 'p2', codigo: 'TRANS', descripcion_factura: 'Desplazamiento', unidad: 'ud', pvp: 25, igic_pct: 7 }]; },
  async facturas(org) { return db().facturas.filter(f => f.org_id === org); },
  async factura(org, id) { return db().facturas.find(f => f.org_id === org && f.id === id) || null; },
  async emitirFactura(org, x) {
    const d = db(); const n = d.facturas.length + 1;
    const cent = l => Math.round(l.cantidad * l.pvp * (1 - (l.dto || 0) / 100) * 100);
    const base = x.lineas.reduce((s, l) => s + cent(l), 0) / 100;
    const tipos = {}; x.lineas.forEach(l => { tipos[l.igic || 0] = (tipos[l.igic || 0] || 0) + cent(l); });
    const igic_desglose = Object.entries(tipos).map(([pct, b]) => ({ pct: Number(pct), base: b / 100, cuota: Math.round(b * pct / 100) / 100 }));
    const igic = Math.round(igic_desglose.reduce((s, g) => s + g.cuota * 100, 0)) / 100;
    const irpf = Math.round(base * (x.irpf_pct || 0)) / 100;
    const o = d.orgs.find(y => y.id === org), c = d.clientes.find(y => y.id === x.cliente_id) || {};
    const lineas = x.lineas.map((l, i) => ({ linea: i + 1, codigo: l.codigo, descripcion: l.descripcion, cantidad: l.cantidad, unidad: l.unidad, pvp_ud: l.pvp,
      dto_pct: l.dto || 0, base: cent(l) / 100, igic_pct: l.igic || 0, igic: Math.round(cent(l) * (l.igic || 0) / 100) / 100 }));
    const f = { id: uid(), org_id: org, num: 'DEMO-' + String(n).padStart(4, '0'), tipo_doc: 'FACTURA', fecha: x.fecha, vencimiento: new Date(Date.parse(x.fecha) + 30 * 864e5).toISOString().slice(0, 10),
      periodo_desde: x.desde || null, periodo_hasta: x.hasta || null, cliente: { ...c }, emisor: { marca: o?.nombre, titular: o?.titular, nif: o?.nif, direccion: o?.direccion, cp: o?.cp, localidad: o?.localidad, provincia: o?.provincia, email: o?.email, telefono: o?.telefono, web: o?.web, iban: o?.iban, bic: o?.bic, pago: o?.config?.medio_pago_texto,
        ...(tipos[0] !== undefined && o?.config?.texto_exencion_igic ? { nota_igic: o.config.texto_exencion_igic } : {}) },
      base, igic, igic_desglose, irpf_pct: x.irpf_pct || 0, irpf, total: Math.round((base + igic - irpf) * 100) / 100, lineas, huella: 'demo', estado_cobro: 'PENDIENTE' };
    d.facturas.unshift(f);
    (x.horas || []).forEach(h => d.facturadas.push([x.cliente_id, h.user_id, h.dia, h.tipo].join('|')));
    guardar(d); return f;
  },
};

export const api = DEMO ? demo : supa;
