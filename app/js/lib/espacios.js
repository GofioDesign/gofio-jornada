// Espacios de la app: cada uno decide qué secciones salen en el menú de la cabecera. Se cambia con los botones de abajo.
// Hoy hay dos (Personal y Pro); «Hogar» llegará más adelante como un tercero con sus propias secciones.
import { usaPersonal, usaProfesional } from './personal.js';

export const ESPACIOS = {
  personal: { nombre: 'Personal', icono: 'crono', inicio: '#/personal', color: '#b5541c' },   // naranja
  pro: { nombre: 'Pro', icono: 'maletin', inicio: '#/', color: '#1f3a2e' },                   // el verde de siempre
};

/** Color principal de un espacio: el que eligió la persona en Ajustes (#rrggbb) o el de serie. */
export function colorEspacio(espacio, elegido) {
  return /^#[0-9a-f]{6}$/i.test(elegido || '') ? elegido.toLowerCase() : ESPACIOS[espacio]?.color || ESPACIOS.pro.color;
}

/** Espacios que ve esta persona según el sondeo («Cómo usas Jornada») y si añadió «Mi tiempo» por su cuenta. */
export function espaciosDisponibles(uso, miTiempo = false) {
  return [
    (usaPersonal(uso) || miTiempo) && 'personal',
    usaProfesional(uso) && 'pro',
  ].filter(Boolean);
}

// Secciones propias de cada espacio (Ajustes está en todos)
const SECCIONES = { personal: ['personal'], pro: ['', 'jornada', 'clientes', 'proyectos', 'equipo', 'tiempos', 'facturacion'] };

/** Espacio al que pertenece una ruta, o null si vale para cualquiera (Ajustes). */
export function espacioDeRuta(ruta) {
  const seccion = (ruta || '#/').replace(/^#\/?/, '').split('/')[0];
  return Object.keys(SECCIONES).find(e => SECCIONES[e].includes(seccion)) || null;
}

/** Espacio activo: el de la ruta si está disponible; si no, el último elegido; si no, el primero. */
export function espacioActivo(disponibles, ruta, guardado) {
  const deRuta = espacioDeRuta(ruta);
  if (disponibles.includes(deRuta)) return deRuta;
  if (disponibles.includes(guardado)) return guardado;
  return disponibles[0] || null;
}

/** Secciones del menú de la cabecera: [href, texto, icono]. */
export function menuDe(espacio, { uso, verEquipo = false, facturacion = false } = {}) {
  if (espacio === 'personal') return [
    ['#/personal', 'Mi tiempo', 'crono'],
    // Quien solo usa lo personal también puede fichar su jornada
    !usaProfesional(uso) && ['#/jornada', 'Jornada', 'reloj'],
    ['#/ajustes', 'Ajustes', 'ajustes'],
  ].filter(Boolean);
  return [
    ['#/', 'Jornada', 'reloj'],
    ['#/clientes', 'Clientes', 'pin'],
    ['#/proyectos', 'Proyectos', 'carpeta'],
    verEquipo && ['#/equipo', 'Equipo', 'equipo'],
    verEquipo && ['#/tiempos', 'Tiempos', 'reparto'],
    facturacion && ['#/facturacion', 'Facturación', 'factura'],
    ['#/ajustes', 'Ajustes', 'ajustes'],
  ].filter(Boolean);
}
