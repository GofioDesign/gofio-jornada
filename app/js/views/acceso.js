import { api, DEMO } from '../api.js';
import { h, accion, aviso, preferencia } from '../ui.js';

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

/** Primera vez: crear empresa o aceptar invitaciones. Es la "configuración fácil desde la primera hoja". */
export async function vistaAlta(app) {
  const invit = await api.misInvitaciones().catch(() => []);
  const nombre = h('input', { required: true, placeholder: 'Nombre de tu empresa', id: 'alta-nombre' });
  const nif = h('input', { placeholder: 'NIF / CIF (opcional)', id: 'alta-nif' });
  const tuNombre = h('input', { required: true, placeholder: 'Tu nombre y apellidos', id: 'alta-tu' });
  const form = h('form.tarjeta', {
    onsubmit: e => {
      e.preventDefault();
      accion(form.querySelector('button'), async () => {
        const id = await api.crearEmpresa(nombre.value.trim(), nif.value.trim(), tuNombre.value.trim());
        preferencia('org', id); aviso('Empresa creada'); await app.recargar();
      });
    },
  },
    h('h2', 'Crea tu empresa'),
    h('p.ayuda', 'Empiezas con el plan gratuito de control horario (hasta 5 personas). Podrás invitar a tu equipo desde Ajustes.'),
    h('label', { for: 'alta-nombre' }, 'Empresa'), nombre,
    h('label', { for: 'alta-nif' }, 'NIF'), nif,
    h('label', { for: 'alta-tu' }, 'Tu nombre'), tuNombre,
    h('button.btn.primario', { type: 'submit' }, 'Crear y empezar'));

  return h('section.pila',
    h('h1', 'Bienvenido'),
    invit.length ? h('div.tarjeta',
      h('h2', 'Te han invitado'),
      invit.map(i => h('div.fila',
        h('div', h('strong', i.org_nombre), h('div.ayuda', 'como ' + i.rol)),
        h('button.btn.primario', { onclick: e => accion(e.currentTarget, async () => { await api.aceptarInvitacion(i.token, tuNombre.value.trim() || null); await app.recargar(); }) }, 'Unirme')))) : null,
    form,
    h('button.btn.enlace', { onclick: async () => { await api.salir(); location.reload(); } }, 'Salir'));
}
