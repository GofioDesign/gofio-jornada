// Tiempo personal (cronómetro privado por tareas) y sondeo inicial «¿Cómo piensas usar Jornada?».

export const USOS = {
  personal: 'Personal',
  profesional: 'Profesional',
  ambos: 'Ambos',
  indeciso: 'No lo sé aún',
};

export const TAREAS_PROPUESTAS = ['Cocinar', 'Fregar la loza', 'Tender y recoger la ropa', 'Ordenar', 'Limpiar', 'Deporte', 'Compras', 'Baño', 'Estudiar'];

export const usaPersonal = uso => uso === 'personal' || uso === 'ambos';
export const usaProfesional = uso => uso !== 'personal';

const ms = x => typeof x === 'number' ? x : Date.parse(x);

/** Minutos de cada tiempo, contando hasta `ahora` el que sigue en marcha. */
export const minutosDe = (t, ahora = Date.now()) => Math.max(0, Math.round(((t.fin ? ms(t.fin) : ahora) - ms(t.inicio)) / 60000));

/** [{ tarea_id, minutos }] ordenado de más a menos. */
export function totalesPorTarea(tiempos, ahora = Date.now()) {
  const m = new Map();
  for (const t of tiempos) m.set(t.tarea_id, (m.get(t.tarea_id) || 0) + minutosDe(t, ahora));
  return [...m].map(([tarea_id, minutos]) => ({ tarea_id, minutos })).sort((a, b) => b.minutos - a.minutos);
}

/** «00:12:34» desde el inicio hasta ahora. */
export function cronometro(inicio, ahora = Date.now()) {
  const s = Math.max(0, Math.floor((ahora - ms(inicio)) / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
}

// ---- Importar clientes desde CSV (sondeo: «más de 3 clientes»)
export const CABECERAS_CLIENTES = ['nombre', 'nif', 'tipo', 'email', 'telefono', 'direccion', 'cp', 'localidad', 'municipio', 'provincia'];

const sinAcentos = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const ALIAS = {
  nombre: ['nombre', 'cliente', 'razon social', 'nombre cliente', 'name'],
  codigo: ['nif', 'cif', 'nie', 'dni', 'codigo', 'id_cliente', 'nif/cif'],
  tipo: ['tipo'],
  email: ['email', 'correo', 'e-mail', 'mail'],
  telefono: ['telefono', 'tel', 'movil', 'phone'],
  direccion: ['direccion', 'domicilio', 'calle'],
  cp: ['cp', 'codigo postal', 'c.p.'],
  localidad: ['localidad', 'poblacion', 'ciudad'],
  municipio: ['municipio'],
  provincia: ['provincia'],
};
const TIPOS = { particular: 'PARTICULAR', empresa: 'EMPRESA', autonomo: 'AUTONOMO', profesional: 'AUTONOMO', administracion: 'ADMINISTRACION' };

/** Filas de parseCSV → { clientes, errores }. Sin NIF se pone un código provisional (SIN-NIF-n) que luego se cambia. */
export function clientesDesdeCSV(filas, existentes = []) {
  const usados = new Set(existentes.map(c => String(c.codigo).toUpperCase()));
  const clientes = [], errores = [];
  let provisional = 0;
  filas.forEach((f, i) => {
    const campos = {};
    for (const [k, v] of Object.entries(f)) {
      const destino = Object.keys(ALIAS).find(d => ALIAS[d].includes(sinAcentos(k)));
      if (destino && v && !campos[destino]) campos[destino] = String(v).trim();
    }
    const linea = i + 2;   // la 1 es la cabecera
    if (!campos.nombre) { errores.push(`Línea ${linea}: falta el nombre`); return; }
    let codigo = (campos.codigo || '').toUpperCase().replace(/[\s.-]/g, '');
    if (!codigo) { do codigo = `SIN-NIF-${++provisional}`; while (usados.has(codigo)); }
    if (usados.has(codigo)) { errores.push(`Línea ${linea}: el NIF ${codigo} está repetido`); return; }
    usados.add(codigo);
    clientes.push({ ...campos, codigo, tipo: TIPOS[sinAcentos(campos.tipo)] || 'PARTICULAR' });
  });
  return { clientes, errores };
}

/** Día (AAAA-MM-DD) en la zona horaria indicada. */
export const diaLocal = (x, tz = 'Atlantic/Canary') =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms(x)));

/** «Planchar, regar las plantas; pasear al perro» → ['Planchar', 'Regar las plantas', 'Pasear al perro'] (sin repetir). */
export function separarTareas(texto) {
  const vistas = new Set();
  return String(texto || '').split(/[,;\n]/).map(t => t.trim().replace(/\s+/g, ' ').slice(0, 60)).filter(Boolean)
    .map(t => t[0].toLocaleUpperCase('es') + t.slice(1))
    .filter(t => { const k = t.toLocaleLowerCase('es'); if (vistas.has(k)) return false; vistas.add(k); return true; });
}
