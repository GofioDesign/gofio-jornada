import { api, DEMO } from '../api.js';
import { CONFIG } from '../../config.js';
import { h, accion, aviso, preferencia, ROLES, puedeGestionar, hoyISO } from '../ui.js';
import { toCSV, parseCSV, numES, descargar } from '../lib/csv.js';
import { prepararHistorico, prepararMaestros } from '../lib/importacion.js';

export async function vistaAjustes(app, seccion) {
  const e = app.e;
  const gestiona = puedeGestionar(app.rol);
  const bloques = [cuenta(app)];
  if (gestiona) {
    const [miembros, invitaciones, exportaciones] = await Promise.all([api.miembros(app.org), api.invitaciones(app.org), api.exportaciones(app.org).catch(() => [])]);
    bloques.push(usuarios(app, miembros, invitaciones), plan(app, miembros, exportaciones), empresa(app), importar(app), app.facturacion ? [importarFacturacion(app), importarMaestros(app)] : null);
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
  // Logo: se reduce en el navegador y se guarda como imagen dentro de la empresa (logo_url).
  let logo = e.logo_url || null;
  const vistaLogo = h('img.logo-previa', { alt: 'Logo' });
  const pintarLogo = () => { vistaLogo.hidden = !logo; if (logo) vistaLogo.src = logo; quitarLogo.style.display = logo ? '' : 'none'; };
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
                      igic_defecto: Number(form.querySelector('#e-igic').value) || 0,
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

function importarFacturacion(app) {
  const archivos = {};
  const resultado = h('div');
  const boton = h('button.btn.primario', { type: 'button', disabled: true }, 'Importar histórico');
  let preparado = null;
  const campos = [
    ['facturas', 'FACTURAS.csv'], ['lineas', 'LINEAS.csv'], ['cobros', 'COBROS.csv'],
  ].map(([clave, etiqueta]) => {
    const input = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': etiqueta });
    input.addEventListener('change', async () => {
      archivos[clave] = input.files[0] ? parseCSV(await input.files[0].text()) : null;
      boton.disabled = true; preparado = null;
      if (!archivos.facturas || !archivos.lineas || !archivos.cobros) {
        resultado.replaceChildren(h('p.ayuda', 'Selecciona los tres archivos para validarlos.'));
        return;
      }
      const clientes = await api.clientes(app.org);
      preparado = prepararHistorico(archivos.facturas, archivos.lineas, archivos.cobros, clientes);
      const { totales, errores, avisos } = preparado;
      resultado.replaceChildren(
        h('p', h('strong', `${totales.facturas} facturas`), ` · ${totales.lineas} líneas · ${totales.cobros} cobros`),
        errores.length ? h('div.aviso-importacion.error', h('strong', `${errores.length} errores que impiden importar`), h('ul', errores.slice(0, 20).map(x => h('li', x)))) : h('p.estado-ok', 'Validación correcta. No se modificarán las facturas que ya existan.'),
        avisos.length ? h('div.aviso-importacion', h('strong', `${avisos.length} avisos`), h('ul', avisos.slice(0, 20).map(x => h('li', x)))) : null,
      );
      boton.disabled = !!errores.length || !totales.facturas;
    });
    return h('label.campo-archivo', h('span', etiqueta), input);
  });
  boton.addEventListener('click', () => accion(boton, async () => {
    if (!preparado || preparado.errores.length) return;
    const n = await api.importarHistorico(app.org, preparado.documentos);
    resultado.replaceChildren(h('p.estado-ok', `${n} facturas importadas. Las que ya existían se conservaron sin cambios.`));
    boton.disabled = true;
  }));
  return h('div.tarjeta', { id: 'importar-facturacion' },
    h('h2', 'Importar histórico de facturación'),
    h('p.ayuda', 'Exporta las pestañas FACTURAS, LINEAS y COBROS de Gofio Facturación como CSV. Primero se validan juntas; la importación no duplica números existentes.'),
    h('div.archivos-importacion', campos), resultado, boton);
}

function importarMaestros(app) {
  const archivos = {};
  const resultado = h('div');
  const boton = h('button.btn.primario', { type: 'button', disabled: true }, 'Importar catálogos');
  let preparado = null;
  const campos = [['productos', 'PRODUCTOS.csv'], ['proveedores', 'PROVEEDORES.csv'], ['precios', 'PRECIOS_PROVEEDOR.csv']].map(([clave, etiqueta]) => {
    const input = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': etiqueta });
    input.addEventListener('change', async () => {
      archivos[clave] = input.files[0] ? parseCSV(await input.files[0].text()) : null;
      boton.disabled = true; preparado = null;
      if (!archivos.productos || !archivos.proveedores || !archivos.precios) return resultado.replaceChildren(h('p.ayuda', 'Selecciona los tres archivos para validarlos.'));
      preparado = prepararMaestros(archivos.productos, archivos.proveedores, archivos.precios);
      const { totales, errores, avisos } = preparado;
      resultado.replaceChildren(h('p', h('strong', `${totales.productos} productos`), ` · ${totales.proveedores} proveedores · ${totales.precios} precios`),
        errores.length ? h('div.aviso-importacion.error', h('strong', `${errores.length} errores que impiden importar`), h('ul', errores.slice(0, 20).map(x => h('li', x)))) : h('p.estado-ok', 'Validación correcta. Los códigos existentes se actualizarán y los precios repetidos se omitirán.'),
        avisos.length ? h('div.aviso-importacion', h('ul', avisos.map(x => h('li', x)))) : null);
      boton.disabled = !!errores.length || !totales.productos;
    });
    return h('label.campo-archivo', h('span', etiqueta), input);
  });
  boton.addEventListener('click', () => accion(boton, async () => {
    if (!preparado || preparado.errores.length) return;
    const r = await api.importarMaestros(app.org, preparado);
    resultado.replaceChildren(h('p.estado-ok', `${r.productos} productos, ${r.proveedores} proveedores y ${r.precios} precios procesados.`));
    boton.disabled = true;
  }));
  return h('div.tarjeta', { id: 'importar-maestros' }, h('h2', 'Migrar productos y proveedores desde v7'),
    h('p.ayuda', 'Importación específica de Gofio Facturación v7. Actualiza productos y proveedores por código sin duplicar cotizaciones idénticas.'),
    h('div.archivos-importacion', campos), resultado, boton);
}

// Reduce una imagen a 600×240 px como máximo y la devuelve como data URL (PNG para conservar la transparencia).
async function reducirImagen(archivo) {
  const url = URL.createObjectURL(archivo);
  try {
    const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => mal(new Error('No se ha podido leer la imagen')); i.src = url; });
    const k = Math.min(1, 600 / (img.naturalWidth || 600), 240 / (img.naturalHeight || 240));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((img.naturalWidth || 600) * k)); c.height = Math.max(1, Math.round((img.naturalHeight || 240) * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const datos = c.toDataURL('image/png');
    if (datos.length > 500_000) throw new Error('El logo es demasiado pesado. Prueba con una imagen más sencilla.');
    return datos;
  } finally { URL.revokeObjectURL(url); }
}
