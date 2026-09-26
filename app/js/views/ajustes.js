import { api, DEMO } from '../api.js';
import { CONFIG } from '../../config.js';
import { h, accion, aviso, preferencia, ROLES, puedeGestionar, hoyISO } from '../ui.js';
import { toCSV, parseCSV, numES, descargar } from '../lib/csv.js';

export async function vistaAjustes(app, seccion) {
  const e = app.e;
  const gestiona = puedeGestionar(app.rol);
  const bloques = [cuenta(app)];
  if (gestiona) {
    const [miembros, invitaciones, exportaciones] = await Promise.all([api.miembros(app.org), api.invitaciones(app.org), api.exportaciones(app.org).catch(() => [])]);
    bloques.push(usuarios(app, miembros, invitaciones), plan(app, miembros, exportaciones), empresa(app), importar(app));
  }
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
        aviso(`Invitación creada. Dile a ${email.value.trim()} que entre en la app con ese email.`, 'ok');
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
    invitaciones.length ? [h('h3', 'Invitaciones pendientes'), invitaciones.map(i => h('div.fila', h('span', `${i.email} · ${ROLES[i.rol]}`),
      h('button.btn.enlace', { onclick: ev => accion(ev.currentTarget, async () => { await api.borrarInvitacion(i.id); window.dispatchEvent(new HashChangeEvent('hashchange')); }) }, 'Anular')))] : null,
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
  const form = h('form.formulario', {
    onsubmit: ev => {
      ev.preventDefault();
      const v = k => form.querySelector('#e-' + k).value.trim() || null;
      accion(form.querySelector('button'), async () => {
        await api.guardarEmpresa(app.org, { nombre: v('nombre'), titular: v('titular'), nif: v('nif'), direccion: v('direccion'), cp: v('cp'), localidad: v('localidad'),
          provincia: v('provincia'), email: v('email'), telefono: v('telefono'),
          ...(app.facturacion ? { web: v('web'), iban: v('iban'), bic: v('bic') } : {}),
          config: { ...cfg, jornada_horas_dia: Number(horas.value) || 8, jornada_geolocalizar: geo.checked,
                    ...(app.facturacion ? { medio_pago_texto: form.querySelector('#e-pago').value.trim() || null } : {}) } });
        aviso('Datos guardados', 'ok'); await app.recargar();
      });
    },
  },
    campo('nombre', 'Nombre comercial', { required: true }), campo('titular', 'Titular fiscal'), campo('nif', 'NIF'),
    campo('direccion', 'Dirección'), h('div.dos', h('div', campo('cp', 'CP')), h('div', campo('localidad', 'Localidad'))), campo('provincia', 'Provincia'),
    h('div.dos', h('div', campo('email', 'Email', { type: 'email' })), h('div', campo('telefono', 'Teléfono'))),
    app.facturacion ? [
      h('h3', 'Datos para las facturas'),
      campo('web', 'Web'),
      h('div.dos', h('div', campo('iban', 'IBAN')), h('div', campo('bic', 'BIC'))),
      h('label', { for: 'e-pago' }, 'Forma de pago (texto que sale en la factura)'),
      h('input', { id: 'e-pago', value: cfg.medio_pago_texto ?? '', placeholder: 'Transferencia bancaria' }),
      h('p.ayuda', 'Estos datos se copian en cada factura al emitirla. Las ya emitidas no cambian.'),
    ] : null,
    h('h3', 'Jornada'),
    h('label', { for: 'e-horas' }, 'Horas de jornada al día (para avisar de excesos)'), horas,
    h('label.check', geo, ' Guardar la ubicación GPS al fichar'),
    h('p.ayuda', 'Si activas la ubicación, informa a tu equipo: solo se guarda en el momento de fichar, nunca de forma continua.'),
    h('button.btn.primario', { type: 'submit' }, 'Guardar'));
  return h('div.tarjeta', { id: 'empresa' }, h('h2', 'Empresa'), form);
}

/** Importa CLIENTES desde la hoja "Gofio Facturación" v7 (Archivo ▸ Descargar ▸ CSV de la pestaña CLIENTES). */
function importar(app) {
  const input = h('input', { type: 'file', accept: '.csv,text/csv', id: 'imp-csv' });
  const resultado = h('div');
  input.addEventListener('change', () => accion(null, async () => {
    const f = input.files[0]; if (!f) return;
    const filas = parseCSV(await f.text());
    const clientes = filas.filter(r => r.ID_CLIENTE && r.NOMBRE).map(r => ({
      codigo: r.ID_CLIENTE.toUpperCase(), nombre: r.NOMBRE, tipo: ['PARTICULAR', 'EMPRESA', 'AUTONOMO', 'ADMINISTRACION'].includes((r.TIPO || '').toUpperCase()) ? r.TIPO.toUpperCase() : 'PARTICULAR',
      aplica_irpf: (r.APLICA_IRPF || '').toUpperCase() === 'SI', irpf_pct: numES(r.IRPF_PCT), direccion: r.DIRECCION || null, cp: r.CP || null,
      localidad: r.LOCALIDAD || null, municipio: r.MUNICIPIO || null, provincia: r.PROVINCIA || null, pais: r.PAIS || 'ESPAÑA',
      email: r.EMAIL || null, telefono: r.TELEFONO || null, notas: r.NOTAS || null, idioma: ['ES', 'DE', 'EN'].includes((r.IDIOMA || '').toUpperCase()) ? r.IDIOMA.toUpperCase() : 'ES',
    }));
    if (!clientes.length) throw new Error('No se encontraron clientes. ¿Es el CSV de la pestaña CLIENTES (con columnas ID_CLIENTE y NOMBRE)?');
    const existentes = new Set((await api.clientes(app.org)).map(c => c.codigo));
    let n = 0, saltados = 0;
    for (const c of clientes) { if (existentes.has(c.codigo)) { saltados++; continue; } await api.guardarCliente(app.org, c); n++; }
    resultado.replaceChildren(h('p', `✔ ${n} clientes importados${saltados ? `, ${saltados} ya existían` : ''}.`));
    input.value = '';
  }));
  return h('div.tarjeta', { id: 'importar' },
    h('h2', 'Importar clientes'),
    h('p.ayuda', 'Desde tu hoja de Google: abre la pestaña CLIENTES ▸ Archivo ▸ Descargar ▸ CSV. Después elige el archivo aquí.'),
    input, resultado,
    h('button.btn.enlace', { onclick: () => descargar('plantilla-clientes.csv', toCSV([], ['ID_CLIENTE', 'NOMBRE', 'TIPO', 'DIRECCION', 'CP', 'LOCALIDAD', 'MUNICIPIO', 'PROVINCIA', 'PAIS', 'EMAIL', 'TELEFONO', 'NOTAS'])) }, 'Descargar plantilla vacía'));
}
