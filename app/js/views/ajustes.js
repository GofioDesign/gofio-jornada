import { api, DEMO } from '../api.js';
import { CONFIG } from '../../config.js';
import { h, montar, accion, aviso, preferencia, ROLES, puedeGestionar, puedeVerEquipo, hoyISO, dialogo, sumarDias, fecha } from '../ui.js';
import { tarjetaFirma } from './firma.js';
import { descargar } from '../lib/csv.js';
import { plantillasObs } from '../lib/factura.js';
import { USOS, usaPersonal } from '../lib/personal.js';
import { DIAS, previstoPeriodo, errorHorario } from '../lib/horario.js';
import { fmtMin } from '../lib/jornada.js';

export async function vistaAjustes(app, seccion) {
  const e = app.e;
  const gestiona = puedeGestionar(app.rol);
  const profesional = app.uso !== 'personal';
  const bloques = [cuenta(app), usoJornada(app), profesional && tarjetaFirma(app), etiquetasNfc()].filter(Boolean);
  if (profesional && puedeVerEquipo(app.rol)) bloques.push(await puntosQr(app));
  if (gestiona) {
    const [miembros, invitaciones, exportaciones] = await Promise.all([api.miembros(app.org), api.invitaciones(app.org), api.exportaciones(app.org).catch(() => [])]);
    bloques.push(usuarios(app, miembros, invitaciones), plan(app, miembros, exportaciones), empresa(app));
    if (profesional) bloques.push(await horarioTrabajo(app, miembros));
    if (app.facturacion) bloques.push(observaciones(app));
    if (app.rol === 'propietario') bloques.push(await accesoApi(app));
  }
  if (app.superadmin) bloques.unshift(h('div.tarjeta.destacada', { id: 'superadmin' },
    h('h2', 'Superadministración'),
    h('p.ayuda', 'Gestión de la plataforma Gofio Jornada: alta de unidades, planes y acceso a facturación. Es aparte de tu empresa.'),
    h('a.btn.primario', { href: '#/sa' }, 'Entrar en modo superadmin')));
  const raiz = h('section.pila', h('h1', 'Ajustes'), bloques,
    h('p.ayuda.pie', `Gofio Jornada ${CONFIG.VERSION}${DEMO ? ' · modo demo' : ''} · ${CONFIG.SOPORTE_EMAIL}`));
  if (seccion) queueMicrotask(() => raiz.querySelector('#' + seccion)?.scrollIntoView({ behavior: 'smooth' }));
  return raiz;
}

function cuenta(app) {
  const nav = h('select', { id: 'pref-nav', onchange: ev => { preferencia('nav', ev.target.value); aviso('Guardado', 'ok'); } },
    [['waze', 'Waze'], ['maps', 'Google Maps'], ['no', 'No abrir']].map(([v, t]) => h('option', { value: v, selected: (preferencia('nav') || 'waze') === v }, t)));
  return h('div.tarjeta', { id: 'cuenta' },
    h('h2', 'Mi cuenta'),
    h('p', h('strong', app.e.mi_nombre || ''), ' · ', app.e.usuario_email || '', ' · ', ROLES[app.rol]),
    h('label', { for: 'pref-nav' }, 'Navegación al salir hacia un cliente'), nav,
    h('button.btn', { onclick: async () => { await api.salir(); location.hash = '#/'; location.reload(); } }, 'Cerrar sesión'));
}

// Cómo se usa Jornada (lo que se eligió en el sondeo inicial). El uso es de la empresa; «Mi tiempo» se puede añadir al menú de cada persona.
function usoJornada(app) {
  const uso = app.uso || 'indeciso';
  const sel = h('select', { id: 'uso-jornada', disabled: !puedeGestionar(app.rol), onchange: ev => accion(null, async () => {
    await api.guardarEmpresa(app.org, { config: { ...(app.e.config || {}), uso: ev.target.value } });
    aviso('Guardado', 'ok'); await app.recargar();
  }) }, Object.entries(USOS).map(([v, t]) => h('option', { value: v, selected: v === uso }, t)));
  const miTiempo = h('input', { type: 'checkbox', checked: preferencia('mi-tiempo') === 'si', onchange: ev => {
    preferencia('mi-tiempo', ev.target.checked ? 'si' : 'no'); window.dispatchEvent(new HashChangeEvent('hashchange'));
  } });
  return h('div.tarjeta', { id: 'uso' },
    h('h2', 'Cómo usas Jornada'),
    h('label', { for: 'uso-jornada' }, 'Uso'), sel,
    h('p.ayuda', {
      personal: 'Personal: el menú muestra «Mi tiempo» para medir tus tareas y la Jornada; se ocultan clientes, equipo y facturación.',
      profesional: 'Profesional: fichaje, clientes, proyectos y equipo.',
      ambos: 'Ambos: lo profesional y, además, «Mi tiempo» para tus tareas personales.',
      indeciso: 'Como profesional, de momento. Cámbialo cuando lo tengas claro.',
    }[uso]),
    usaPersonal(uso) ? null : h('label.check', miTiempo, ' Mostrar «Mi tiempo» en mi menú (tareas personales, solo las ves tú)'));
}

// Etiquetas NFC: una pegatina con esta dirección abre la app y pregunta qué fichar (p. ej. «¿Has terminado?» al dejar el móvil en el soporte del coche).
function etiquetasNfc() {
  const nombre = h('input', { id: 'nfc-nombre', value: 'coche', maxLength: 40 });
  const url = () => `${location.origin}${location.pathname}?nfc=${encodeURIComponent(nombre.value.trim() || 'coche')}`;
  const salida = h('code.nfc-url', url());
  nombre.addEventListener('input', () => { salida.textContent = url(); });
  return h('div.tarjeta', { id: 'nfc' },
    h('h2', 'Etiqueta NFC'),
    h('p.ayuda', 'Graba esta dirección en una pegatina NFC (con una app como «NFC Tools», como registro de tipo URL) y pégala, por ejemplo, en el soporte del coche. Al acercar el móvil se abre la app y te pregunta si has terminado, si has llegado o si empiezas.'),
    h('label', { for: 'nfc-nombre' }, 'Nombre de la etiqueta'), nombre, salida,
    h('button.btn', { onclick: async () => { await navigator.clipboard?.writeText(url()).catch(() => { }); aviso('Dirección copiada', 'ok'); } }, 'Copiar dirección'),
    h('p.ayuda', 'En iPhone aparece un aviso al acercarlo: tócalo para abrir la app. En Android se abre directamente.'));
}

// Códigos QR para fichar: uno por sitio (taller, local, obra). Se imprime y se pega a la entrada.
// Al escanearlo con la cámara del móvil se abre la app y pregunta qué fichar; el fichaje queda marcado con el punto.
const urlQr = token => `${location.origin}${location.pathname}?qr=${token}`;
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function imprimirQr(p, donde) {
  const w = window.open('', '_blank');   // dentro del toque, para que el navegador no la bloquee
  if (!w) return aviso('Permite las ventanas emergentes para imprimir el código', 'error');
  const m = await import('qrcode-generator'); const qrcode = m.default || m.qrcode;
  const q = qrcode(0, 'M'); q.addData(urlQr(p.token)); q.make();
  w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>QR · ${esc(p.nombre)}</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;margin:2cm 1cm;color:#1f3a2e}svg{width:min(80vw,11cm);height:auto}
h1{font-size:2rem;margin:0 0 .3rem}p{margin:.4rem 0}.pie{color:#555;font-size:.8rem;word-break:break-all}</style></head><body>
<h1>${esc(p.nombre)}</h1>${donde ? `<p>${esc(donde)}</p>` : ''}${q.createSvgTag({ cellSize: 8, margin: 4, scalable: true })}
<p><strong>Para fichar, escanea este código con la cámara del móvil</strong></p><p class="pie">Gofio Jornada · ${esc(urlQr(p.token))}</p>
<script>onload = () => print();<\/script></body></html>`);
  w.document.close();
}

async function puntosQr(app) {
  const [puntos, clientes, proyectos] = await Promise.all([api.puntosQr(app.org), api.clientes(app.org), api.proyectos(app.org).catch(() => [])]);
  const donde = p => [proyectos.find(x => x.id === p.proyecto_id)?.nombre && '📁 ' + proyectos.find(x => x.id === p.proyecto_id).nombre,
    clientes.find(x => x.id === p.cliente_id)?.nombre].filter(Boolean).join(' · ');
  const recargar = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const opciones = (sel = '') => [h('option', { value: '' }, 'Sin cliente ni proyecto (se elige al fichar)'),
    proyectos.some(x => x.activo !== false) ? h('optgroup', { label: 'Proyectos' }, proyectos.filter(x => x.activo !== false).map(x => h('option', { value: 'p:' + x.id, selected: sel === 'p:' + x.id }, x.nombre))) : null,
    h('optgroup', { label: 'Clientes' }, clientes.filter(x => x.activo !== false).map(x => h('option', { value: 'c:' + x.id, selected: sel === 'c:' + x.id }, x.nombre)))];
  const leer = v => ({ cliente_id: v.startsWith('c:') ? v.slice(2) : null, proyecto_id: v.startsWith('p:') ? v.slice(2) : null });

  const nombre = h('input', { id: 'qr-nombre', maxLength: 60, placeholder: 'Taller, Local de la calle Mayor, Obra El Jardín…', required: true });
  const sitio = h('select', { id: 'qr-sitio' }, opciones());
  const form = h('form.formulario', { onsubmit: ev => {
    ev.preventDefault();
    accion(form.querySelector('button'), async () => {
      await api.guardarPuntoQr(app.org, { nombre: nombre.value.trim(), ...leer(sitio.value) });
      aviso('Código creado. Imprímelo y pégalo en ese sitio.', 'ok'); recargar();
    });
  } }, h('h3', 'Nuevo código'),
    h('label', { for: 'qr-nombre' }, 'Nombre del sitio'), nombre,
    h('label', { for: 'qr-sitio' }, 'Al empezar a trabajar aquí, se ficha en'), sitio,
    h('button.btn.primario', { type: 'submit' }, 'Crear código QR'));

  const editar = async p => {
    const n = h('input', { value: p.nombre, maxLength: 60, 'aria-label': 'Nombre' });
    const s = h('select', { 'aria-label': 'Se ficha en' }, opciones(p.proyecto_id ? 'p:' + p.proyecto_id : p.cliente_id ? 'c:' + p.cliente_id : ''));
    const ok = await dialogo('Editar código QR', [h('label', 'Nombre del sitio'), n, h('label', 'Al empezar a trabajar aquí, se ficha en'), s],
      [{ texto: 'Cancelar', valor: false }, { texto: 'Guardar', clase: 'primario', valor: true }]);
    if (ok) await accion(null, async () => { await api.guardarPuntoQr(app.org, { ...p, nombre: n.value.trim(), ...leer(s.value) }); aviso('Guardado', 'ok'); recargar(); });
  };

  const lista = h('div.lista', puntos.map(p => h('div.item' + (p.activo === false ? '.inactivo' : ''),
    h('div', h('strong', p.nombre), h('small', p.activo === false ? 'Desactivado' : donde(p) || 'Se elige al fichar')),
    h('div.fila-botones',
      p.activo !== false ? h('button.btn.mini', { onclick: () => imprimirQr(p, donde(p)) }, 'Imprimir') : null,
      p.activo !== false ? h('button.btn.mini', { onclick: async () => { await navigator.clipboard?.writeText(urlQr(p.token)).catch(() => { }); aviso('Dirección copiada: también sirve para una pegatina NFC', 'ok'); } }, 'Copiar dirección') : null,
      h('button.btn.mini', { onclick: () => editar(p) }, 'Editar'),
      p.activo !== false ? h('button.btn.mini', { title: 'El código impreso deja de valer y se genera otro', onclick: e => {
        if (!confirm(`¿Cambiar el código de «${p.nombre}»? El que está impreso dejará de valer y tendrás que imprimir el nuevo.`)) return;
        accion(e.currentTarget, async () => { await api.renovarQr(p.id); aviso('Código cambiado. Imprime el nuevo.', 'ok'); recargar(); });
      } }, 'Cambiar código') : null,
      h('button.btn.mini', { onclick: e => accion(e.currentTarget, async () => { await api.guardarPuntoQr(app.org, { ...p, activo: p.activo === false }); recargar(); }) },
        p.activo === false ? 'Activar' : 'Desactivar')))));

  return h('div.tarjeta', { id: 'qr' },
    h('h2', 'Códigos QR para fichar'),
    h('p.ayuda', 'Crea un código para cada sitio donde se trabaja, imprímelo y pégalo a la entrada. Al escanearlo con la cámara del móvil se abre la app y pregunta si empiezas, terminas o haces una pausa. El fichaje queda marcado con el sitio.'),
    puntos.length ? lista : h('p.vacio', 'Todavía no hay códigos.'),
    h('p.ayuda', 'Si alguien fotografía el código para fichar desde otro sitio, pulsa «Cambiar código»: el impreso deja de valer.'),
    form);
}

// Horario de trabajo: el de la empresa y, para quien trabaje distinto, uno propio.
// Sirve para comparar las horas previstas con las trabajadas en Equipo y en la Jornada; no cambia los fichajes.
async function horarioTrabajo(app, miembros) {
  let horarios = await api.horarios(app.org).catch(() => []);
  const hm = x => String(x || '').slice(0, 5);
  const aMin = x => { const [a, b] = hm(x).split(':').map(Number); return a * 60 + b; };
  const aHora = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const activos = miembros.filter(m => m.activo);
  const quien = h('select', { id: 'hor-quien' });
  const opciones = () => montar(quien, h('option', { value: '' }, 'Toda la empresa'),
    activos.map(m => h('option', { value: m.user_id, selected: m.user_id === quien.value },
      (m.nombre || 'Sin nombre') + (horarios.some(x => x.user_id === m.user_id) ? ' · horario propio' : ''))));
  const dias = h('div.horario'), estado = h('p.ayuda'), total = h('p'), botones = h('div.fila-botones');
  let tramos = [];

  const cargar = () => {
    const user = quien.value || null;
    const propios = horarios.filter(x => (x.user_id || null) === user);
    tramos = (user && !propios.length ? horarios.filter(x => !x.user_id) : propios).map(x => ({ dia_semana: Number(x.dia_semana), inicio: hm(x.inicio), fin: hm(x.fin) }));
    estado.textContent = !user ? 'Lo usa todo el equipo, salvo quien tenga un horario propio.'
      : propios.length ? 'Esta persona tiene horario propio: los días sin tramos no trabaja.'
      : 'Usa el horario de la empresa. Si trabaja distinto, cámbialo aquí y guarda: tendrá uno propio.';
    dibujar();
  };
  const nuevoTramo = d => {
    const del = tramos.filter(x => x.dia_semana === d).sort((a, b) => a.inicio.localeCompare(b.inicio));
    if (!del.length) return { dia_semana: d, inicio: '08:00', fin: '13:00' };
    const ini = Math.min(aMin(del.at(-1).fin) + 120, 23 * 60);
    return { dia_semana: d, inicio: aHora(ini), fin: aHora(Math.min(ini + 180, 23 * 60 + 59)) };
  };
  const dibujar = () => {
    montar(dias, DIAS.map((nombre, i) => {
      const d = i + 1;
      const del = tramos.filter(x => x.dia_semana === d).sort((a, b) => a.inicio.localeCompare(b.inicio));
      const campo = (t, k) => h('input', { type: 'time', value: t[k], 'aria-label': `${nombre}, ${k === 'inicio' ? 'desde' : 'hasta'}`,
        onchange: ev => { t[k] = ev.target.value; pintarTotal(); } });
      return h('div.horario-dia',
        h('strong', nombre),
        h('div.horario-tramos', del.length ? del.map(t => h('div.horario-tramo', campo(t, 'inicio'), h('span', '–'), campo(t, 'fin'),
            h('button.btn.mini', { type: 'button', title: 'Quitar este tramo', 'aria-label': `Quitar tramo de ${nombre}`,
              onclick: () => { tramos.splice(tramos.indexOf(t), 1); dibujar(); } }, '×')))
          : h('span.ayuda', 'No se trabaja')),
        h('button.btn.mini', { type: 'button', onclick: () => { tramos.push(nuevoTramo(d)); dibujar(); } }, '+ Tramo'));
    }));
    pintarTotal();
    const user = quien.value || null;
    montar(botones,
      h('button.btn', { type: 'button', title: 'Pone los tramos del lunes de martes a viernes', onclick: () => {
        tramos = [...tramos.filter(x => x.dia_semana === 1 || x.dia_semana > 5),
          ...[2, 3, 4, 5].flatMap(d => tramos.filter(x => x.dia_semana === 1).map(x => ({ ...x, dia_semana: d })))];
        dibujar();
      } }, 'Copiar el lunes de martes a viernes'),
      h('button.btn.primario', { type: 'button', onclick: e => guardarTramos(e.currentTarget, user, tramos) }, 'Guardar horario'),
      user && horarios.some(x => x.user_id === user) ? h('button.btn', { type: 'button', onclick: e => guardarTramos(e.currentTarget, user, []) }, 'Usar el de la empresa') : null);
  };
  // Total semanal: una semana cualquiera de lunes a domingo
  const pintarTotal = () => { total.textContent = `Total semana: ${fmtMin(previstoPeriodo(tramos, '2024-01-01', '2024-01-07'))}`; };
  const guardarTramos = (btn, user, lista) => accion(btn, async () => {
    const error = errorHorario(lista);
    if (error) throw new Error(error);
    await api.guardarHorario(app.org, user, lista);
    horarios = await api.horarios(app.org);
    aviso(lista.length || !user ? 'Horario guardado' : 'Ahora usa el horario de la empresa', 'ok');
    opciones(); cargar();
  });
  quien.addEventListener('change', cargar);
  opciones(); cargar();

  return h('div.tarjeta', { id: 'horario' },
    h('h2', 'Horario de trabajo'),
    h('p.ayuda', 'Las horas que se espera que trabaje cada persona. En Equipo verás las previstas junto a las trabajadas, y cada persona ve su horario del día en la Jornada. Para una jornada partida, pon dos tramos el mismo día: el hueco entre ellos es el descanso.'),
    h('label', { for: 'hor-quien' }, 'Horario de'), quien, estado,
    dias, total, botones);
}

// Correo de acceso a la persona invitada. Si no sale (p. ej. Supabase sin SMTP propio), la invitación sigue valiendo.
export async function avisarInvitado(email) {
  try { await api.avisarInvitado(email); return true; }
  catch (e) { aviso(`La invitación está creada, pero no se pudo enviar el correo (${e.message}). Dile a ${email} que entre en la app con ese email.`, 'error'); return false; }
}

function usuarios(app, miembros, invitaciones) {
  const max = app.e.plan?.max_usuarios;
  const activos = miembros.filter(m => m.activo).length;
  const email = h('input', { type: 'email', required: true, placeholder: 'email@ejemplo.com', id: 'inv-email' });
  const nombre = h('input', { placeholder: 'Nombre (opcional)', id: 'inv-nombre' });
  const rol = h('select', { id: 'inv-rol' }, ['empleado', 'responsable', 'admin', 'gestoria'].map(r => h('option', { value: r }, ROLES[r])));
  const form = h('form.formulario', {
    onsubmit: ev => {
      ev.preventDefault();
      accion(form.querySelector('button'), async () => {
        await api.invitar(app.org, email.value.trim(), rol.value, nombre.value.trim());
        if (await avisarInvitado(email.value.trim())) aviso(`Invitación enviada a ${email.value.trim()}: le llega un correo con el enlace para entrar.`, 'ok');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
    },
  }, h('h3', 'Invitar'), h('div.dos', h('div', h('label', { for: 'inv-email' }, 'Email'), email), h('div', h('label', { for: 'inv-nombre' }, 'Nombre'), nombre)),
    h('label', { for: 'inv-rol' }, 'Rol'), rol, h('button.btn.primario', { type: 'submit' }, 'Invitar'));

  return h('div.tarjeta', { id: 'usuarios' },
    h('h2', 'Usuarios'),
    h('p.ayuda', max ? `${activos} de ${max} usuarios activos en tu plan.` : `${activos} usuarios activos.`),
    h('table.tabla', h('tbody', miembros.map(m => h('tr',
      h('td', h('strong', m.nombre || '—'), m.user_id === app.e.user_id ? h('small', ' (tú)') : null),
      h('td', m.rol === 'propietario' ? ROLES.propietario : h('select', {
        'aria-label': 'Rol', onchange: ev => accion(null, async () => { await api.actualizarMiembro(app.org, m.user_id, { rol: ev.target.value }); aviso('Rol cambiado', 'ok'); }),
      }, ['admin', 'responsable', 'empleado', 'gestoria'].map(r => h('option', { value: r, selected: m.rol === r }, ROLES[r])))),
      h('td', m.rol === 'propietario' ? '' : h('label.check', h('input', {
        type: 'checkbox', checked: m.activo,
        onchange: ev => accion(null, async () => {
          try { await api.actualizarMiembro(app.org, m.user_id, { activo: ev.target.checked }); aviso(ev.target.checked ? 'Activado' : 'Desactivado (su registro se conserva)', 'ok'); }
          catch (err) { ev.target.checked = !ev.target.checked; throw err; }
        }),
      }), ' activo')))))),
    invitaciones.length ? [h('h3', 'Invitaciones pendientes'), invitaciones.map(i => h('div.fila',
      h('span', `${i.email} · ${ROLES[i.rol]}`, h('small.ayuda', ` · ${fecha(String(i.creada_en).slice(0, 10))}`)),
      h('div.fila-botones',
        h('button.btn.mini', { onclick: ev => accion(ev.currentTarget, async () => { if (await avisarInvitado(i.email)) aviso(`Correo reenviado a ${i.email}`, 'ok'); }) }, 'Reenviar correo'),
        h('button.btn.mini', { onclick: ev => { if (confirm(`¿Eliminar la invitación de ${i.email}? Ya no podrá unirse con ella.`)) accion(ev.currentTarget, async () => { await api.borrarInvitacion(i.id); aviso('Invitación eliminada', 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange')); }); } }, 'Eliminar'))))] : null,
    form);
}

function plan(app, miembros, exportaciones) {
  const p = app.e.plan || {};
  const pro = !!p.backup_auto;
  return h('div.tarjeta', { id: 'plan' },
    h('h2', 'Plan y copias de seguridad'),
    h('p', 'Plan actual: ', h('strong', p.nombre || app.e.plan_id), app.e.plan_hasta ? ` (hasta ${app.e.plan_hasta})` : ''),
    h('ul.ventajas',
      h('li', p.max_usuarios ? `Hasta ${p.max_usuarios} usuarios` : 'Usuarios ilimitados'),
      h('li', pro ? 'Copia de seguridad automática diaria en tu Google Drive' : 'Copias de seguridad manuales (botón de abajo)'),
      h('li', pro ? 'Exportación automática mensual del registro (CSV) para gestoría e Inspección' : 'Exportación manual del registro en CSV')),
    !pro ? h('p.ayuda', 'Con Jornada Pro las copias y exportaciones se hacen solas. Escríbenos a ', h('a', { href: 'mailto:' + CONFIG.SOPORTE_EMAIL + '?subject=Jornada%20Pro' }, CONFIG.SOPORTE_EMAIL), '.') :
      h('p.ayuda', app.e.backup_drive_carpeta ? '📁 Carpeta de Drive configurada.' : 'Falta conectar la carpeta de Google Drive: escríbenos y la dejamos lista.'),
    h('div.fila-botones',
      h('button.btn.primario', {
        onclick: ev => accion(ev.currentTarget, async () => {
          const copia = await api.copia(app.org);
          descargar(`copia-gofio-jornada_${hoyISO(app.tz)}.json`, JSON.stringify(copia, null, 1), 'application/json');
          await api.registrarExportacion(app.org, 'MANUAL_COPIA', hoyISO(app.tz)).catch(() => { });
          aviso('Copia descargada. Guárdala en un lugar seguro.', 'ok');
        }),
      }, 'Descargar copia completa'),
      h('a.btn', { href: '#/equipo' }, 'Exportar registro (CSV)')),
    exportaciones.length ? h('details', h('summary', 'Historial de copias'), h('ul', exportaciones.map(x => h('li', `${new Date(x.hecha_en).toLocaleString('es-ES')} · ${x.tipo.replace('_', ' ').toLowerCase()}${x.ok ? '' : ' · ERROR'}`)))) : h('p.ayuda', 'Aún no has hecho ninguna copia.'),
    app.e.tester_facturacion ? h('label.check', h('input', {
      type: 'checkbox', checked: app.e.usa_facturacion,
      onchange: ev => accion(null, async () => { await api.guardarEmpresa(app.org, { usa_facturacion: ev.target.checked }); await app.recargar(); }),
    }), ' Mostrar el módulo de Facturación (acceso de tester)') : null);
}

function empresa(app) {
  const e = app.e; const cfg = e.config || {};
  const campo = (k, t, attrs = {}) => [h('label', { for: 'e-' + k }, t), h('input', { id: 'e-' + k, value: e[k] ?? '', ...attrs })];
  const horas = h('input', { id: 'e-horas', type: 'number', min: 1, max: 12, step: 0.5, value: cfg.jornada_horas_dia ?? 8 });
  const geo = h('input', { id: 'e-geo', type: 'checkbox', checked: cfg.jornada_geolocalizar !== false });
  // Logo: se reduce en el navegador y se guarda como imagen dentro de la empresa (logo_url).
  let logo = e.logo_url || null;
  const vistaLogo = h('img.logo-previa', { alt: 'Logo' });
  const pintarLogo = () => { vistaLogo.hidden = !logo; if (logo) vistaLogo.src = logo; quitarLogo.style.display = logo ? '' : 'none'; };
  const TAMANOS = { S: 'Pequeño', M: 'Mediano', L: 'Grande' };
  const tamLogo = h('select', { id: 'e-logo-tam' }, Object.entries(TAMANOS).map(([v, t]) => h('option', { value: v, selected: (cfg.logo_tamano || 'M') === v }, t)));
  const quitarLogo = h('button.btn.enlace', { type: 'button', onclick: () => { logo = null; pintarLogo(); } }, 'Quitar logo');
  const subirLogo = h('input', { id: 'e-logo', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
    onchange: ev => accion(null, async () => { const f = ev.target.files[0]; if (f) { logo = await reducirImagen(f); pintarLogo(); } }) });
  pintarLogo();
  const form = h('form.formulario', {
    onsubmit: ev => {
      ev.preventDefault();
      const v = k => form.querySelector('#e-' + k).value.trim() || null;
      accion(form.querySelector('button[type=submit]'), async () => {
        await api.guardarEmpresa(app.org, { nombre: v('nombre'), titular: v('titular'), nif: v('nif'), direccion: v('direccion'), cp: v('cp'), localidad: v('localidad'),
          provincia: v('provincia'), email: v('email'), telefono: v('telefono'),
          ...(app.facturacion ? { web: v('web'), iban: v('iban'), bic: v('bic'), logo_url: logo } : {}),
          config: { ...cfg, jornada_horas_dia: Number(horas.value) || 8, jornada_geolocalizar: geo.checked,
                    ...(app.facturacion ? { medio_pago_texto: form.querySelector('#e-pago').value.trim() || null,
                      igic_defecto: Number(form.querySelector('#e-igic').value) || 0, logo_tamano: tamLogo.value,
                      texto_exencion_igic: form.querySelector('#e-exencion').value.trim() || null } : {}) } });
        aviso('Datos guardados', 'ok'); await app.recargar();
      });
    },
  },
    campo('nombre', 'Nombre comercial', { required: true }), campo('titular', 'Titular fiscal'), campo('nif', 'NIF'),
    campo('direccion', 'Dirección'), h('div.dos', h('div', campo('cp', 'CP')), h('div', campo('localidad', 'Localidad'))), campo('provincia', 'Provincia'),
    h('div.dos', h('div', campo('email', 'Email', { type: 'email' })), h('div', campo('telefono', 'Teléfono'))),
    app.facturacion ? [
      h('h3', 'Datos para las facturas'),
      h('label', { for: 'e-logo' }, 'Logo (sale en el PDF de las facturas)'),
      h('div.logo-campo', vistaLogo, subirLogo, quitarLogo),
      h('label', { for: 'e-logo-tam' }, 'Tamaño del logo en la factura'), tamLogo,
      campo('web', 'Web'),
      h('div.dos', h('div', campo('iban', 'IBAN')), h('div', campo('bic', 'BIC'))),
      h('label', { for: 'e-pago' }, 'Forma de pago (texto que sale en la factura)'),
      h('input', { id: 'e-pago', value: cfg.medio_pago_texto ?? '', placeholder: 'Transferencia bancaria' }),
      h('label', { for: 'e-igic' }, 'IGIC por defecto (%)'),
      h('input', { id: 'e-igic', type: 'number', min: 0, max: 20, step: 0.5, value: cfg.igic_defecto ?? 7 }),
      h('label', { for: 'e-exencion' }, 'Aclaración para IGIC 0 % (sale en la factura si alguna línea va al 0 %)'),
      h('textarea', { id: 'e-exencion', rows: 2, placeholder: 'Motivo de la exención que te indique tu gestoría', value: cfg.texto_exencion_igic ?? '' }),
      h('p.ayuda', 'Estos datos se copian en cada factura al emitirla: las ya emitidas no cambian. El logo es la excepción: el PDF usa siempre el logo actual.'),
    ] : null,
    h('h3', 'Jornada'),
    h('label', { for: 'e-horas' }, 'Horas de jornada al día (para avisar de excesos)'), horas,
    h('label.check', geo, ' Guardar la ubicación GPS al fichar'),
    h('p.ayuda', 'Si activas la ubicación, informa a tu equipo: solo se guarda en el momento de fichar, nunca de forma continua.'),
    h('button.btn.primario', { type: 'submit' }, 'Guardar'));
  return h('div.tarjeta', { id: 'empresa' }, h('h2', 'Empresa'), form);
}

// Recorta los márgenes vacíos (transparentes o blancos), reduce la imagen a 900×360 px como máximo
// y la devuelve como data URL (PNG para conservar la transparencia).
async function reducirImagen(archivo) {
  const url = URL.createObjectURL(archivo);
  try {
    const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => mal(new Error('No se ha podido leer la imagen')); i.src = url; });
    const r = recorteUtil(img);
    const k = Math.min(1, 900 / r.w, 360 / r.h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(r.w * k)); c.height = Math.max(1, Math.round(r.h * k));
    c.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    const datos = c.toDataURL('image/png');
    if (datos.length > 500_000) throw new Error('El logo es demasiado pesado. Prueba con una imagen más sencilla.');
    return datos;
  } finally { URL.revokeObjectURL(url); }
}

// Rectángulo con contenido de la imagen: descarta bordes transparentes o casi blancos (si no hay nada, la imagen entera).
function recorteUtil(img) {
  const W = img.naturalWidth || 600, H = img.naturalHeight || 240;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
  let d;
  try { d = x.getImageData(0, 0, W, H).data; } catch { return { x: 0, y: 0, w: W, h: H }; }
  const vacio = i => d[i + 3] < 16 || (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
    if (vacio((y * W + xx) * 4)) continue;
    if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { x: 0, y: 0, w: W, h: H };
  const m = Math.round(Math.min(W, H) * 0.02);   // un pequeño margen para no pegar el contenido al borde
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Observaciones recurrentes: textos que se añaden a la factura con un clic desde el borrador.
function observaciones(app) {
  const filas = h('div.pila');
  const fila = (p = {}) => {
    const titulo = h('input', { value: p.titulo || '', placeholder: 'Nombre (p. ej. Garantía 6 meses)', 'aria-label': 'Nombre' });
    const texto = h('textarea', { rows: 4, value: p.texto || '', placeholder: 'Texto que sale en la factura', 'aria-label': 'Texto' });
    const caja = h('div.obs-plantilla', titulo, texto,
      h('button.btn.enlace', { type: 'button', onclick: () => caja.remove() }, 'Quitar'));
    caja.datos = () => ({ titulo: titulo.value.trim(), texto: texto.value.trim() });
    return caja;
  };
  filas.append(...plantillasObs(app.e.config).map(fila));
  const form = h('form.formulario', {
    onsubmit: ev => {
      ev.preventDefault();
      const lista = [...filas.children].map(c => c.datos()).filter(p => p.texto);
      accion(form.querySelector('button[type=submit]'), async () => {
        await api.guardarEmpresa(app.org, { config: { ...(app.e.config || {}), observaciones_plantillas: lista } });
        aviso('Observaciones guardadas', 'ok'); await app.recargar();
      });
    },
  },
    h('p.ayuda', 'Como las firmas del correo: en el borrador de la factura las añades a las observaciones con un clic, y luego puedes retocarlas.'),
    filas,
    h('div.acciones',
      h('button.btn', { type: 'button', onclick: () => { const c = fila(); filas.append(c); c.querySelector('input').focus(); } }, '+ Añadir'),
      h('button.btn.primario', { type: 'submit' }, 'Guardar')));
  return h('div.tarjeta', { id: 'observaciones' }, h('h2', 'Observaciones recurrentes'), form);
}

// Claves de API de solo lectura: horarios, registro de jornada y facturas para hojas de cálculo, Zapier o la gestoría
async function accesoApi(app) {
  const lista = h('div');
  const pintar = async () => {
    const claves = await api.clavesApi(app.org);
    lista.replaceChildren(claves.length ? h('table.tabla',
      h('thead', h('tr', h('th', 'Nombre'), h('th', 'Clave'), h('th', 'Creada'), h('th', ''))),
      h('tbody', claves.map(k => h('tr', h('td', k.nombre), h('td', h('code', k.prefijo + '…')), h('td', new Date(k.creada_en).toLocaleDateString('es-ES')),
        h('td', k.revocada_en ? h('span.ayuda', 'Revocada') : h('button.btn.mini.peligro', {
          onclick: ev => accion(ev.currentTarget, async () => {
            if (!confirm(`¿Revocar la clave «${k.nombre}»? Lo que la use dejará de funcionar.`)) return;
            await api.revocarClaveApi(k.id); aviso('Clave revocada', 'ok'); await pintar();
          }) }, 'Revocar'))))))
      : h('p.ayuda', 'Aún no has creado ninguna clave.'));
  };
  const nombre = h('input', { id: 'api-nombre', maxLength: 80, placeholder: 'Para qué es (p. ej. Hoja de horarios)' });
  const crear = h('button.btn', { type: 'button', onclick: ev => accion(ev.currentTarget, async () => {
    const clave = await api.crearClaveApi(app.org, nombre.value);
    nombre.value = ''; await pintar();
    const hoy = hoyISO(app.tz), desde = sumarDias(hoy, -30);
    const url = q => `${CONFIG.SUPABASE_URL || 'https://<proyecto>.supabase.co'}/rest/v1/rpc/${q}?clave=${clave}&desde=${desde}&hasta=${hoy}`;
    const campo = v => h('input', { readOnly: true, value: v, onfocus: e => e.target.select() });
    await dialogo('Clave de API creada', [
      h('p', h('strong', 'Cópiala ahora: no se volverá a mostrar.'), ' Quien la tenga puede leer los horarios', app.facturacion ? ' y las facturas' : '', ' de la empresa.'),
      campo(clave),
      h('p.ayuda', 'Horarios (un tramo por fila):'), campo(url('api_horarios')),
      h('p.ayuda', 'Registro de jornada (una fila por persona y día):'), campo(url('api_resumen')),
      app.facturacion ? [h('p.ayuda', 'Facturas emitidas:'), campo(url('api_facturas'))] : null,
      h('p.ayuda', 'Cada petición necesita además la cabecera ', h('code', 'apikey'), ' con la clave pública de la app:'), campo(CONFIG.SUPABASE_ANON_KEY || ''),
      h('p.ayuda', 'Cambia las fechas desde y hasta (AAAA-MM-DD, como máximo un año). Las respuestas son JSON; con la cabecera Accept: text/csv salen en CSV.'),
    ], [{ texto: 'Copiar clave', valor: async () => { await navigator.clipboard?.writeText(clave).catch(() => { }); aviso('Clave copiada', 'ok'); return undefined; } }, { texto: 'Hecho', valor: true, clase: 'primario' }]);
  }) }, 'Crear clave');
  await pintar();
  return h('div.tarjeta', { id: 'api' }, h('h2', 'Acceso por API'),
    h('p.ayuda', 'Para que otros programas (Google Sheets, Zapier, tu gestoría) lean los horarios', app.facturacion ? ' y las facturas' : '', ' sin entrar en la app. Las claves solo sirven para leer, nunca para cambiar nada.'),
    lista, h('div.filtros', nombre, crear));
}
