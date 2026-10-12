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

// ---- Contraste: el texto sobre el color del espacio va en negro o en blanco, el que se lea mejor (WCAG 2.1)
const canales = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const lineal = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminancia = hex => { const [r, g, b] = canales(hex).map(lineal); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contraste = (a, b) => { const [x, y] = [luminancia(a), luminancia(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

/** '#000000' si el negro contrasta más que el blanco sobre ese fondo; si no, '#ffffff'. */
export const textoSobre = fondo => contraste(fondo, '#000000') > contraste(fondo, '#ffffff') ? '#000000' : '#ffffff';

/** Mezcla dos colores como color-mix(in srgb, a p, b) del CSS. */
export function mezcla(a, b, p) {
  const [x, y] = [canales(a), canales(b)];
  return '#' + x.map((c, i) => Math.round(c * p + y[i] * (1 - p)).toString(16).padStart(2, '0')).join('');
}

/** Colores de texto sobre la cabecera y sobre los botones principales, en tema claro u oscuro (las mismas mezclas que el CSS). */
export function textosEspacio(color, oscuro = false) {
  return oscuro
    ? { barra: textoSobre(mezcla(color, '#121513', 0.45)), boton: textoSobre(mezcla(color, '#ffffff', 0.55)) }
    : { barra: textoSobre(color), boton: textoSobre(color) };
}
