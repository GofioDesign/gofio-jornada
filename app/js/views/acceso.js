import { api, DEMO } from '../api.js';
import { h, accion, aviso, preferencia } from '../ui.js';
import { USOS, TAREAS_PROPUESTAS, usaPersonal, clientesDesdeCSV } from '../lib/personal.js';
import { cajaCSVClientes } from './clientes.js';

export async function vistaLogin() {
  const email = h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'tu@email.com', id: 'email' });
  const codigo = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxLength: 8, id: 'codigo' });
  const paso2 = h('div.paso2', { hidden: true },
    h('p.ayuda', 'Te hemos enviado un enlace y un código. Abre el enlace en este dispositivo o escribe el código:'),
    h('label', { for: 'codigo' }, 'Código'), codigo,
    h('button.btn.primario', { type: 'button', onclick: e => accion(e.currentTarget, async () => { await api.entrarConCodigo(email.value.trim(), codigo.value.trim()); location.reload(); }) }, 'Entrar'));
  const form = h('form.tarjeta.acceso', {
    onsubmit: e => {
      e.preventDefault();
      accion(form.querySelector('button'), async () => { await api.entrarConEmail(email.value.trim()); paso2.hidden = false; aviso('Revisa tu correo'); });
    },
  },
    h('h1', 'Entrar'),
    h('p.ayuda', DEMO ? 'Modo demo: escribe cualquier email. Los datos se guardan solo en este navegador.'
                      : 'Sin contraseñas: te enviamos un enlace de acceso a tu correo.'),
    h('label', { for: 'email' }, 'Email'), email,
    h('button.btn.primario', { type: 'submit' }, DEMO ? 'Probar la demo' : 'Enviarme el enlace'),
    paso2);
  return form;
}

/** Primera vez: crear empresa o aceptar invitaciones. Empieza con un sondeo («¿Cómo piensas usar Jornada?») que deja la app preconfigurada. */
export async function vistaAlta(app) {
  const invit = await api.misInvitaciones().catch(() => []);
  let uso = null, nClientes = null;

  const nombre = h('input', { placeholder: 'Nombre de tu empresa o el tuyo como autónomo', id: 'alta-nombre' });
  const nif = h('input', { placeholder: 'NIF / CIF (opcional)', id: 'alta-nif' });
  const tuNombre = h('input', { required: true, placeholder: 'Tu nombre y apellidos', id: 'alta-tu' });

  // ---- clientes (profesional / ambos)
  const filasCli = [1, 2, 3].map(n => {
    const nom = h('input', { placeholder: `Cliente ${n}`, 'aria-label': `Nombre del cliente ${n}` });
    const doc = h('input', { placeholder: 'NIF (opcional)', 'aria-label': `NIF del cliente ${n}` });
    return { nodo: h('div.dos', h('div', nom), h('div', doc)), nom, doc };
  });
  const csv = cajaCSVClientes();
  const botonesN = [['1', '1'], ['2', '2'], ['3', '3'], ['mas', 'Más de 3']].map(([v, t]) =>
    h('button.btn', { type: 'button', 'aria-pressed': 'false', onclick: () => { nClientes = nClientes === v ? null : v; pintar(); } }, t));
  const secClientes = h('div.pila',
    h('h3', '¿A cuántos clientes facturas?'),
    h('div.opciones', botonesN),
    filasCli.map(f => f.nodo),
    h('div.csv', h('p.ayuda', 'Con más de 3, súbelos de una vez con un CSV (puedes exportarlo de Excel o Google Sheets). También puedes hacerlo luego desde Clientes.'), csv.nodo));

  // ---- tareas personales (personal / ambos)
  const checks = h('div.checks', TAREAS_PROPUESTAS.map((t, i) => h('label', h('input', { type: 'checkbox', value: t, checked: i < 5 }), t)));
  const otra = h('input', { placeholder: 'Añade la tuya, p. ej. Planchar', maxLength: 60, 'aria-label': 'Otra tarea' });
  const anadir = () => {
    const t = otra.value.trim(); if (!t) return;
    checks.append(h('label', h('input', { type: 'checkbox', value: t, checked: true }), t)); otra.value = ''; otra.focus();
  };
  otra.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); anadir(); } });
  const secTareas = h('div.pila',
    h('h3', 'Tus tareas'),
    h('p.ayuda', 'Elige qué quieres medir. Funcionan como proyectos a los que das tiempo con un toque. Solo las ves tú y no son fichajes.'),
    checks, h('div.fila', otra, h('button.btn', { type: 'button', onclick: anadir }, 'Añadir')));

  const secEmpresa = h('div',
    h('label', { for: 'alta-nombre' }, 'Empresa'), nombre,
    h('label', { for: 'alta-nif' }, 'NIF'), nif);
  const ayudaPlan = h('p.ayuda', 'Empiezas con Jornada, para una persona. Si trabajáis varios, Jornada Pro equipo se contrata por asientos.');
  const crear = h('button.btn.primario', { type: 'submit' }, 'Crear y empezar');
  const resto = h('div.pila', secEmpresa, h('div', h('label', { for: 'alta-tu' }, 'Tu nombre'), tuNombre), secClientes, secTareas, ayudaPlan, crear);
  const botonesUso = Object.entries(USOS).map(([v, t]) =>
    h('button.btn', { type: 'button', 'aria-pressed': 'false', onclick: () => { uso = v; pintar(); } }, t));

  const pintar = () => {
    botonesUso.forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(USOS)[i] === uso)));
    botonesN.forEach((b, i) => b.setAttribute('aria-pressed', String(['1', '2', '3', 'mas'][i] === nClientes)));
    resto.hidden = !uso;
    secEmpresa.hidden = uso === 'personal';
    nombre.required = uso !== 'personal';
    secClientes.hidden = !['profesional', 'ambos'].includes(uso);
    secTareas.hidden = !usaPersonal(uso);
    const n = Number(nClientes) || 0;
    filasCli.forEach((f, i) => { f.nodo.hidden = i >= n; });
    csv.nodo.parentNode.hidden = nClientes !== 'mas';
    ayudaPlan.hidden = uso === 'personal';
  };

  const clientesElegidos = () => {
    if (secClientes.hidden || !nClientes) return [];
    if (nClientes === 'mas') return csv.clientes();
    return clientesDesdeCSV(filasCli.slice(0, Number(nClientes)).filter(f => f.nom.value.trim())
      .map(f => ({ nombre: f.nom.value.trim(), nif: f.doc.value.trim() }))).clientes;
  };

  const form = h('form.tarjeta.pila', {
    onsubmit: e => {
      e.preventDefault();
      accion(crear, async () => {
        const tu = tuNombre.value.trim();
        const id = await api.crearEmpresa(uso === 'personal' ? `Personal · ${tu}` : nombre.value.trim(), uso === 'personal' ? '' : nif.value.trim(), tu);
        const nueva = (await api.misEmpresas()).find(x => x.id === id);
        await api.guardarEmpresa(id, { config: { ...(nueva?.config || {}), uso } });
        const clientes = clientesElegidos();
        const tareas = secTareas.hidden ? [] : [...checks.querySelectorAll('input:checked')].map(c => c.value);
        try {
          if (clientes.length) await api.importarClientes(id, clientes);
          if (tareas.length) await api.crearTareasPersonales(tareas);
        } catch (err) { aviso(`Ya puedes empezar, pero no se pudo guardar todo (${err.message}). Revísalo en Clientes o en Mi tiempo.`, 'error'); }
        preferencia('org', id);
        aviso(uso === 'personal' ? 'Listo: toca una tarea para empezar a contar' : 'Empresa creada', 'ok');
        location.hash = uso === 'personal' ? '#/personal' : '#/';
        await app.recargar();
      });
    },
  },
    h('h2', '¿Cómo piensas usar Jornada?'),
    h('p.ayuda', 'Lo dejamos preparado según tu respuesta. Puedes cambiarlo cuando quieras en Ajustes.'),
    h('div.opciones', botonesUso),
    resto);
  pintar();

  return h('section.pila',
    h('h1', 'Bienvenido'),
    invit.length ? h('div.tarjeta',
      h('h2', 'Te han invitado'),
      invit.map(i => h('div.fila',
        h('div', h('strong', i.org_nombre), h('div.ayuda', 'como ' + i.rol)),
        h('button.btn.primario', { onclick: e => accion(e.currentTarget, async () => { await api.aceptarInvitacion(i.token, tuNombre.value.trim() || null); await app.recargar(); }) }, 'Unirme')))) : null,
    form,
    app.superadmin ? h('a.btn', { href: '#/sa' }, 'Entrar en modo superadmin') : null,
    h('button.btn.enlace', { onclick: async () => { await api.salir(); location.reload(); } }, 'Salir'));
}
