// MI TIEMPO: cronómetro privado por tareas personales (cocinar, tender la ropa…).
// No es un fichaje: no entra en el registro de jornada ni en la facturación, y solo lo ve quien lo apunta.
import { api } from '../api.js';
import { h, montar, accion, aviso, hora, hoyISO, sumarDias } from '../ui.js';
import { fmtMin } from '../lib/jornada.js';
import { TAREAS_PROPUESTAS, totalesPorTarea, cronometro, minutosDe, diaLocal, separarTareas } from '../lib/personal.js';

export async function vistaPersonal(app) {
  const raiz = h('section.pila.personal');
  const cuerpo = h('div.pila');
  let tareas = [], tiempos = [], reloj;

  const cargar = async () => {
    const hoy = hoyISO(app.tz);
    [tareas, tiempos] = await Promise.all([api.tareasPersonales(), api.tiemposPersonales(sumarDias(hoy, -6), hoy)]);
    pintar();
  };
  const nombre = id => tareas.find(t => t.id === id)?.nombre || 'Tarea borrada';

  const pintar = () => {
    clearInterval(reloj);
    const hoy = hoyISO(app.tz), lunes = sumarDias(hoy, -((new Date(hoy + 'T12:00:00Z').getUTCDay() + 6) % 7));
    const enMarcha = tiempos.find(t => !t.fin);
    const deHoy = tiempos.filter(t => diaLocal(t.inicio, app.tz) === hoy);
    const deSemana = tiempos.filter(t => diaLocal(t.inicio, app.tz) >= lunes);
    const activas = tareas.filter(t => t.activa !== false);

    const marcador = h('strong.cronometro', enMarcha ? cronometro(enMarcha.inicio) : '');
    if (enMarcha) reloj = setInterval(() => { if (!marcador.isConnected) return clearInterval(reloj); marcador.textContent = cronometro(enMarcha.inicio); }, 1000);

    montar(cuerpo,
      h('div.tarjeta.estado-personal', enMarcha
        ? [h('p', 'Ahora: ', h('strong', nombre(enMarcha.tarea_id))), marcador,
           h('button.btn.peligro', { onclick: e => accion(e.currentTarget, async () => { await api.pararPersonal(); await cargar(); }) }, 'Parar')]
        : h('p.ayuda', 'Toca una tarea para empezar a contar. Al tocar otra, la anterior se para sola.')),
      activas.length
        ? h('div.tareas-personales', activas.map(t => h('button.btn.tarea' + (enMarcha?.tarea_id === t.id ? '.activa' : ''), {
            type: 'button', 'aria-pressed': String(enMarcha?.tarea_id === t.id),
            onclick: e => accion(e.currentTarget, async () => {
              if (enMarcha?.tarea_id === t.id) await api.pararPersonal(); else await api.empezarPersonal(t.id);
              await cargar();
            }),
          }, t.nombre)))
        : h('p.vacio', 'Aún no tienes tareas. Añade la primera abajo.'),
      h('div.tarjeta',
        h('h2', 'Hoy'),
        resumen(deHoy),
        deHoy.length ? h('ul.lista-simple', deHoy.slice().reverse().map(t => h('li',
          h('span', `${hora(t.inicio, app.tz)}–${t.fin ? hora(t.fin, app.tz) : 'ahora'} · ${nombre(t.tarea_id)} · ${fmtMin(minutosDe(t))}`),
          h('button.btn.enlace.mini', { onclick: e => accion(e.currentTarget, async () => {
            if (!confirm('¿Borrar este tiempo?')) return;
            await api.borrarTiempoPersonal(t.id); await cargar();
          }) }, 'Borrar')))) : null),
      h('div.tarjeta', h('h2', 'Esta semana'), resumen(deSemana)),
      gestionar(activas));
  };

  const resumen = lista => {
    const filas = totalesPorTarea(lista);
    if (!filas.length) return h('p.ayuda', 'Sin tiempo apuntado.');
    const total = filas.reduce((s, f) => s + f.minutos, 0);
    return h('table.tabla', h('tbody', filas.map(f => h('tr', h('td', nombre(f.tarea_id)), h('td.num', fmtMin(f.minutos)),
      h('td.num', total ? Math.round(f.minutos * 100 / total) + ' %' : '')))),
      h('tfoot', h('tr', h('td', 'Total'), h('td.num', fmtMin(total)), h('td'))));
  };

  const gestionar = activas => {
    const nueva = h('input', { placeholder: 'Nuevas tareas separadas por comas: Planchar, Regar…', 'aria-label': 'Nuevas tareas' });
    const propuestas = TAREAS_PROPUESTAS.filter(n => !tareas.some(t => t.nombre.toLowerCase() === n.toLowerCase()));
    const crear = async (nombre, recargar = true) => {
      const previa = tareas.find(t => t.nombre.toLowerCase() === nombre.toLowerCase());
      if (previa) await api.guardarTareaPersonal({ id: previa.id, activa: true });
      else tareas.push(await api.guardarTareaPersonal({ nombre, orden: tareas.length }));
      if (recargar) await cargar();
    };
    return h('details.tarjeta', h('summary', h('strong', 'Mis tareas')),
      h('form.fila', { onsubmit: e => {
        e.preventDefault(); const nombres = separarTareas(nueva.value);
        if (nombres.length) accion(e.target.querySelector('button'), async () => { for (const n of nombres) await crear(n, false); await cargar(); });
      } },
        nueva, h('button.btn', { type: 'submit' }, 'Añadir')),
      propuestas.length ? h('div.fila-botones', h('small.ayuda', 'Ideas: '), propuestas.map(n => h('button.btn.mini', { type: 'button', onclick: e => accion(e.currentTarget, () => crear(n)) }, '+ ' + n))) : null,
      h('ul.lista-simple', activas.map(t => h('li', h('span', t.nombre),
        h('span',
          h('button.btn.enlace.mini', { onclick: e => accion(e.currentTarget, async () => {
            const n = prompt('Nuevo nombre', t.nombre)?.trim();
            if (n && n !== t.nombre) { await api.guardarTareaPersonal({ id: t.id, nombre: n }); await cargar(); }
          }) }, 'Renombrar'),
          h('button.btn.enlace.mini', { onclick: e => accion(e.currentTarget, async () => {
            await api.guardarTareaPersonal({ id: t.id, activa: false }); aviso(`«${t.nombre}» quitada; su tiempo se conserva`, 'ok'); await cargar();
          }) }, 'Quitar'))))));
  };

  await cargar();
  montar(raiz,
    h('h1', 'Mi tiempo'),
    h('p.ayuda', '🔒 Solo lo ves tú. No es un fichaje: no cuenta en el registro de jornada ni se factura.'),
    cuerpo);
  return raiz;
}
