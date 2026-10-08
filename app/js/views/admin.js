// Superadministración (solo Gofio Design): alta de unidades (empresas) y su plan y acceso a facturación.
// Crear una unidad deja una invitación de propietario: esa persona entra en la app con su email y la acepta.
import { api } from '../api.js';
import { h, montar, accion, aviso, fecha } from '../ui.js';

export async function vistaAdmin() {
  const planes = await api.planes();
  const nombrePlan = id => planes.find(p => p.id === id)?.nombre || id;
  const lista = h('div');
  const buscar = h('input', { type: 'search', placeholder: 'Buscar unidad, NIF o email…', 'aria-label': 'Buscar' });
  let empresas = [];

  const editar = (e) => {
    const plan = h('select', { 'aria-label': 'Plan' }, planes.map(p => h('option', { value: p.id, selected: p.id === e.plan_id }, p.nombre)));
    const hasta = h('input', { type: 'date', value: e.plan_hasta || '', 'aria-label': 'Plan hasta' });
    const fact = h('input', { type: 'checkbox', checked: e.tester_facturacion });
    return h('div.sa-editar',
      h('label', 'Plan', plan), h('label', 'Hasta (vacío: sin fin)', hasta), h('label.check', fact, ' Facturación'),
      h('button.btn', { onclick: ev => accion(ev.currentTarget, async () => {
        await api.saActualizarEmpresa(e.id, { plan: plan.value, plan_hasta: hasta.value, facturacion: fact.checked });
        aviso(`${e.nombre} actualizada`, 'ok'); await cargar();
      }) }, 'Guardar'));
  };

  const pintar = () => {
    const q = buscar.value.trim().toLowerCase();
    const r = empresas.filter(e => !q || [e.nombre, e.nif, e.propietario, e.invitacion_pendiente].some(x => String(x || '').toLowerCase().includes(q)));
    montar(lista, r.length ? h('div.lista', r.map(e => h('details.item.sa-unidad',
      h('summary',
        h('strong', e.nombre), ' ',
        h('span.ayuda', [e.nif, nombrePlan(e.plan_id) + (e.plan_hasta ? ` hasta ${fecha(e.plan_hasta)}` : ''), e.tester_facturacion ? 'facturación' : null,
          `${e.usuarios} ${e.usuarios === 1 ? 'usuario' : 'usuarios'}`].filter(Boolean).join(' · ')),
        h('div.ayuda', e.propietario ? `Propietario: ${e.propietario}` : e.invitacion_pendiente ? `Invitación pendiente: ${e.invitacion_pendiente}` : 'Sin propietario',
          ` · alta ${fecha(String(e.creado_en).slice(0, 10))}`, e.ultimo_fichaje ? ` · último fichaje ${fecha(String(e.ultimo_fichaje).slice(0, 10))}` : '')),
      editar(e)))) : h('p.vacio', 'No hay unidades con ese filtro.'));
  };
  const cargar = async () => { empresas = await api.saEmpresas(); pintar(); };
  buscar.addEventListener('input', pintar);

  const nombre = h('input', { id: 'sa-nombre', required: true, placeholder: 'Nombre comercial' });
  const nif = h('input', { id: 'sa-nif', placeholder: 'Opcional' });
  const email = h('input', { id: 'sa-email', type: 'email', required: true, placeholder: 'email@unidad.com' });
  const plan = h('select', { id: 'sa-plan' }, planes.map(p => h('option', { value: p.id }, p.nombre)));
  const fact = h('input', { id: 'sa-fact', type: 'checkbox' });
  const form = h('form.formulario', {
    onsubmit: ev => {
      ev.preventDefault();
      accion(form.querySelector('button'), async () => {
        await api.saCrearEmpresa({ nombre: nombre.value, nif: nif.value, email: email.value, plan: plan.value, facturacion: fact.checked });
        aviso(`Unidad creada. Dile a ${email.value.trim()} que entre en la app con ese email para aceptarla.`, 'ok');
        form.reset(); await cargar();
      });
    },
  },
    h('div.dos', h('div', h('label', { for: 'sa-nombre' }, 'Nombre de la unidad'), nombre), h('div', h('label', { for: 'sa-nif' }, 'NIF'), nif)),
    h('div.dos', h('div', h('label', { for: 'sa-email' }, 'Email del propietario'), email), h('div', h('label', { for: 'sa-plan' }, 'Plan'), plan)),
    h('label.check', fact, ' Activar facturación'),
    h('p.ayuda', 'La unidad se crea vacía. Su propietario entra en la app con ese email, acepta la invitación y completa los datos de la empresa en Ajustes.'),
    h('button.btn.primario', { type: 'submit' }, 'Dar de alta'));

  await cargar();
  return h('section.pila',
    h('h1', 'Unidades ', h('span.etiqueta', 'superadmin')),
    h('div.tarjeta', h('h2', 'Nueva unidad'), form),
    h('div.tarjeta', h('h2', `Todas las unidades (${empresas.length})`), h('div.filtros', buscar), lista));
}
