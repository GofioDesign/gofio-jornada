// Utilidades de interfaz sin dependencias.

/** h('button.btn.primario', {onclick}, 'Texto') -> elemento DOM */
export function h(sel, attrs, ...hijos) {
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { hijos.unshift(attrs); attrs = {}; }
  const [tag, ...clases] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (clases.length) el.className = clases.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of hijos.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Como replaceChildren, pero ignora null/undefined/false (replaceChildren los pintaría como texto "null"). */
export function montar(destino, ...nodos) { destino.replaceChildren(...nodos.flat().filter(n => n != null && n !== false)); }

let tt;
export function aviso(msg, tipo = 'info') {
  const el = document.getElementById('aviso');
  el.textContent = msg; el.className = 'aviso visible ' + tipo;
  clearTimeout(tt); tt = setTimeout(() => el.classList.remove('visible'), tipo === 'error' ? 6000 : 3000);
}

/** Ejecuta una acción con el botón bloqueado y muestra errores legibles. */
export async function accion(btn, fn) {
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.classList.add('cargando'); }
  try { return await fn(); }
  catch (e) { console.error(e); aviso(e.message || String(e), 'error'); if (e.limitePlan) location.hash = '#/ajustes/plan'; }
  finally { if (btn) { btn.disabled = false; btn.classList.remove('cargando'); } }
}

/** Diálogo modal. Devuelve una promesa con el valor que pase cerrar(). */
export function dialogo(titulo, contenido, botones = [{ texto: 'Cerrar', valor: null }]) {
  return new Promise(res => {
    const d = h('dialog.dialogo',
      h('h3', titulo),
      h('div.dialogo-cuerpo', contenido),
      h('div.dialogo-botones', botones.map(b => h('button.btn' + (b.clase ? '.' + b.clase : ''), {
        type: 'button',
        onclick: async () => { const v = typeof b.valor === 'function' ? await b.valor(d) : b.valor; if (v === undefined) return; d.close(); d.remove(); res(v); },
      }, b.texto))));
    d.addEventListener('cancel', () => { d.remove(); res(null); });
    document.body.append(d); d.showModal();
  });
}

export const hoyISO = (tz = 'Atlantic/Canary') => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const hora = (x, tz = 'Atlantic/Canary') => x ? new Date(x).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: tz }) : '—';
export const fecha = (x) => x ? new Date(x + (String(x).length === 10 ? 'T12:00:00' : '')).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }) : '—';
export const eur = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
export const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Posición GPS (o null si no hay permiso / tarda demasiado). No bloquea el fichaje. */
export function posicion(timeout = 8000) {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, precision: Math.round(p.coords.accuracy) }),
      () => res(null), { enableHighAccuracy: true, timeout, maximumAge: 30000 });
  });
}

export function preferencia(clave, valor) {
  try {
    if (valor === undefined) return localStorage.getItem('gofio:' + clave);
    localStorage.setItem('gofio:' + clave, valor);
  } catch { return null; }
}

export const ROLES = { propietario: 'Propietario', admin: 'Administrador', responsable: 'Responsable', empleado: 'Empleado', gestoria: 'Gestoría' };
export const puedeVerEquipo = rol => ['propietario', 'admin', 'responsable'].includes(rol);
export const puedeGestionar = rol => ['propietario', 'admin'].includes(rol);
