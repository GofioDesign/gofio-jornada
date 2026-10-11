// Superadministración (solo Gofio Design): alta de unidades (empresas) y su plan y acceso a facturación.
// Crear una unidad deja una invitación de propietario: esa persona entra en la app con su email y la acepta.
import { api } from '../api.js';
import { h, montar, accion, aviso, fecha } from '../ui.js';
import { descargar } from '../lib/csv.js';
import { avisarInvitado } from './ajustes.js';
import { cuotaMensual } from '../lib/plan.js';

export async function vistaAdmin(app) {
  const [planes, extras] = await Promise.all([api.planes(), api.extras()]);
  const porAsientos = id => !!planes.find(p => p.id === id)?.por_asientos;
  // Asientos y copia automática solo tienen sentido en un plan por asientos (Pro equipo)
  const camposAsientos = (plan, asientos, copia) => {
    const pintar = () => { const si = porAsientos(plan.value); asientos.disabled = !si; copia.disabled = !si; if (!si) { asientos.value = 1; copia.checked = false; } };
    plan.addEventListener('change', pintar); pintar();
  };
  const nombrePlan = id => planes.find(p => p.id === id)?.nombre || id;
  const lista = h('div');
  const buscar = h('input', { type: 'search', placeholder: 'Buscar unidad, NIF o email…', 'aria-label': 'Buscar' });
  let empresas = [];

  // Invitación del propietario: reenviar el correo, cambiar el email o anularla
  const invitacion = (e) => {
    if (e.propietario) return null;
    const cambiar = async (btn, titulo) => {
      const email = prompt(titulo, e.invitacion_pendiente || '');
      if (!email) return;
      await accion(btn, async () => {
        await api.saInvitarPropietario(e.id, email);
        if (await avisarInvitado(email)) aviso(`Invitación enviada a ${email.trim()}`, 'ok');
        await cargar();
      });
    };
    return h('div.fila-botones.sa-invitacion', e.invitacion_pendiente ? [
      h('button.btn.mini', { type: 'button', onclick: ev => accion(ev.currentTarget, async () => { if (await avisarInvitado(e.invitacion_pendiente)) aviso(`Correo reenviado a ${e.invitacion_pendiente}`, 'ok'); }) }, 'Reenviar correo'),
      h('button.btn.mini', { type: 'button', onclick: ev => cambiar(ev.currentTarget, 'Nuevo email del propietario') }, 'Cambiar email'),
      h('button.btn.mini', { type: 'button', onclick: ev => { if (confirm(`¿Anular la invitación de ${e.invitacion_pendiente}?`)) accion(ev.currentTarget, async () => { await api.saAnularInvitacion(e.id); aviso('Invitación anulada', 'ok'); await cargar(); }); } }, 'Anular invitación'),
    ] : h('button.btn.mini', { type: 'button', onclick: ev => cambiar(ev.currentTarget, 'Email del propietario') }, 'Invitar propietario'));
  };

  const editar = (e) => {
    const plan = h('select', { 'aria-label': 'Plan' }, planes.map(p => h('option', { value: p.id, selected: p.id === e.plan_id }, p.nombre)));
    const hasta = h('input', { type: 'date', value: e.plan_hasta || '', 'aria-label': 'Plan hasta' });
    const asientos = h('input', { type: 'number', min: 1, step: 1, value: e.asientos || 1, 'aria-label': 'Asientos' });
    const copia = h('input', { type: 'checkbox', checked: e.copia_auto });
    const fact = h('input', { type: 'checkbox', checked: e.tester_facturacion });
    camposAsientos(plan, asientos, copia);
    return h('div.sa-editar',
      h('label', 'Plan', plan), h('label', 'Asientos', asientos), h('label', 'Hasta (vacío: sin fin)', hasta),
      h('label.check', copia, ' Copia automática (todos los asientos)'), h('label.check', fact, ' Facturación'),
      h('button.btn', { onclick: ev => accion(ev.currentTarget, async () => {
        await api.saActualizarEmpresa(e.id, { plan: plan.value, plan_hasta: hasta.value, asientos: asientos.value, copia_auto: copia.checked, facturacion: fact.checked });
        aviso(`${e.nombre} actualizada`, 'ok'); await cargar();
      }) }, 'Guardar'));
  };

  // Eliminar (sin empezar) o dar de baja (ya tiene fichajes o facturas: se conservan el plazo legal)
  const hoy = new Date().toISOString().slice(0, 10);
  const largo = d => new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  // la unidad puede ser la empresa del propio superadmin: se recargan sus empresas para el menú
  const recargar = async () => { if (app) await app.recargar(); else await cargar(); };
  const eliminar = (e, btn) => {
    const nombre = prompt(`Se borrará «${e.nombre}» con todos sus datos y no se podrá deshacer.\n\nEscribe el nombre de la unidad para confirmar:`);
    if (nombre === null) return;
    accion(btn, async () => { await api.saEliminarUnidad(e.id, nombre); aviso(`${e.nombre} eliminada`, 'ok'); await recargar(); });
  };
  const copia = (e, btn) => accion(btn, async () => {
    descargar(`copia-${e.nombre.replace(/[^\w-]+/g, '_')}-${hoy}.json`, JSON.stringify(await api.saCopiaUnidad(e.id), null, 2), 'application/json');
  });
  const ciclo = (e) => {
    if (e.baja_en) return h('div.sa-baja',
      h('p.ayuda', `De baja desde el ${largo(e.baja_en)}${e.baja_motivo ? ` (${e.baja_motivo})` : ''}. Sus usuarios ya no entran. `,
        e.con_registros ? `Hay que conservar sus datos hasta el ${largo(e.eliminar_desde)}.` : 'No tiene fichajes ni facturas.'),
      h('div.fila-botones',
        h('button.btn.mini', { type: 'button', onclick: ev => accion(ev.currentTarget, async () => { await api.saReactivar(e.id); aviso(`${e.nombre} reactivada`, 'ok'); await recargar(); }) }, 'Reactivar'),
        h('button.btn.mini', { type: 'button', onclick: ev => copia(e, ev.currentTarget) }, 'Descargar copia'),
        !e.con_registros || e.eliminar_desde <= hoy
          ? h('button.btn.mini.peligro', { type: 'button', onclick: ev => eliminar(e, ev.currentTarget) }, 'Eliminar definitivamente')
          : h('span.ayuda', 'Se podrá eliminar a partir de esa fecha.')));
    if (!e.con_registros) return h('div.fila-botones.sa-baja',
      h('span.ayuda', 'Aún no ha empezado (sin fichajes ni facturas): se puede eliminar.'),
      h('button.btn.mini.peligro', { type: 'button', onclick: ev => eliminar(e, ev.currentTarget) }, 'Eliminar unidad'));
    return h('div.fila-botones.sa-baja',
      h('button.btn.mini', { type: 'button', onclick: ev => copia(e, ev.currentTarget) }, 'Descargar copia'),
      h('button.btn.mini.peligro', { type: 'button', onclick: ev => {
        const motivo = prompt(`Dar de baja «${e.nombre}»: sus usuarios dejarán de entrar y sus datos se conservarán el plazo legal (4 años el registro de jornada, 6 las facturas). Se puede reactivar.\n\nMotivo (opcional):`);
        if (motivo === null) return;
        accion(ev.currentTarget, async () => {
          const hasta = await api.saDarDeBaja(e.id, motivo);
          aviso(`${e.nombre} dada de baja. Se podrá eliminar a partir del ${largo(hasta)}.`, 'ok'); await recargar();
        });
      } }, 'Dar de baja'));
  };

  const cuota = e => { const t = cuotaMensual(e, planes.find(p => p.id === e.plan_id), extras).total; return t > 0 ? `${t.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}/mes` : null; };
  const titulo = h('h2');
  const pintar = () => {
    titulo.textContent = `Todas las unidades (${empresas.length})`;
    const q = buscar.value.trim().toLowerCase();
    const r = empresas.filter(e => !q || [e.nombre, e.nif, e.propietario, e.invitacion_pendiente].some(x => String(x || '').toLowerCase().includes(q)));
    montar(lista, r.length ? h('div.lista', r.map(e => h('details.item.sa-unidad',
      h('summary',
        h('strong', e.nombre), e.baja_en ? h('span.etiqueta.baja', 'de baja') : null, ' ',
        h('span.ayuda', [e.nif, nombrePlan(e.plan_id) + (e.plan_hasta ? ` hasta ${fecha(e.plan_hasta)}` : ''),
          porAsientos(e.plan_id) ? `${e.usuarios} de ${e.asientos} asientos` : `${e.usuarios} ${e.usuarios === 1 ? 'usuario' : 'usuarios'}`,
          e.copia_auto ? 'copia automática' : null, e.tester_facturacion ? 'facturación' : null, cuota(e)].filter(Boolean).join(' · ')),
        h('div.ayuda', e.propietario ? `Propietario: ${e.propietario}` : e.invitacion_pendiente ? `Invitación pendiente: ${e.invitacion_pendiente}` : 'Sin propietario',
          ` · alta ${fecha(String(e.creado_en).slice(0, 10))}`, e.ultimo_fichaje ? ` · último fichaje ${fecha(String(e.ultimo_fichaje).slice(0, 10))}` : '')),
      e.baja_en ? null : invitacion(e), e.baja_en ? null : editar(e), ciclo(e)))) : h('p.vacio', 'No hay unidades con ese filtro.'));
  };
  const cargar = async () => { empresas = await api.saEmpresas(); pintar(); };
  buscar.addEventListener('input', pintar);

  const nombre = h('input', { id: 'sa-nombre', required: true, placeholder: 'Nombre comercial' });
  const nif = h('input', { id: 'sa-nif', placeholder: 'Opcional' });
  const email = h('input', { id: 'sa-email', type: 'email', required: true, placeholder: 'email@unidad.com' });
  const plan = h('select', { id: 'sa-plan' }, planes.map(p => h('option', { value: p.id }, p.nombre)));
  const asientos = h('input', { id: 'sa-asientos', type: 'number', min: 1, step: 1, value: 1 });
  const copiaAuto = h('input', { id: 'sa-copia', type: 'checkbox' });
  const fact = h('input', { id: 'sa-fact', type: 'checkbox' });
  camposAsientos(plan, asientos, copiaAuto);
  const form = h('form.formulario', {
    onsubmit: ev => {
      ev.preventDefault();
      accion(form.querySelector('button'), async () => {
        await api.saCrearEmpresa({ nombre: nombre.value, nif: nif.value, email: email.value, plan: plan.value, asientos: asientos.value, copia_auto: copiaAuto.checked, facturacion: fact.checked });
        if (await avisarInvitado(email.value)) aviso(`Unidad creada. Le hemos enviado a ${email.value.trim()} un correo para entrar y aceptarla.`, 'ok');
        form.reset(); plan.dispatchEvent(new Event('change')); await cargar();
      });
    },
  },
    h('div.dos', h('div', h('label', { for: 'sa-nombre' }, 'Nombre de la unidad'), nombre), h('div', h('label', { for: 'sa-nif' }, 'NIF'), nif)),
    h('div.dos', h('div', h('label', { for: 'sa-email' }, 'Email del propietario'), email), h('div', h('label', { for: 'sa-plan' }, 'Plan'), plan)),
    h('div.dos', h('div', h('label', { for: 'sa-asientos' }, 'Asientos (Pro equipo)'), asientos), h('div')),
    h('label.check', copiaAuto, ' Copia automática (todos los asientos)'),
    h('label.check', fact, ' Activar facturación'),
    h('p.ayuda', 'La unidad se crea vacía. Su propietario recibe un correo con el enlace para entrar, acepta la invitación y completa los datos de la empresa en Ajustes.'),
    h('button.btn.primario', { type: 'submit' }, 'Dar de alta'));

  await cargar();
  return h('section.pila',
    h('h1', 'Unidades'),
    h('p.ayuda', 'Modo superadmin: gestionas la plataforma, no tu empresa. Para volver, usa «Volver a mi empresa» en el menú.'),
    h('div.tarjeta', h('h2', 'Nueva unidad'), form),
    h('div.tarjeta', titulo, h('div.filtros', buscar), lista));
}
