// CSV para Excel / Google Sheets en español (separador ; y coma decimal).

export function toCSV(rows, columnas) {
  if (!rows.length && !columnas) return '﻿';
  const cols = columnas || Object.keys(rows[0]);
  const esc = v => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    const s = String(v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(';'), ...rows.map(r => cols.map(c => esc(r[c])).join(';'))].join('\r\n') + '\r\n';
}

/** Lee un CSV exportado de Google Sheets (separador , o ; autodetectado). Devuelve objetos por cabecera. */
export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const primera = text.split(/\r?\n/, 1)[0];
  const sep = (primera.match(/;/g) || []).length > (primera.match(/,/g) || []).length ? ';' : ',';
  const filas = []; let fila = [], campo = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { campo += '"'; i++; } else q = false; }
      else campo += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { fila.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else campo += ch;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  const [cab, ...datos] = filas.filter(f => f.some(c => c.trim() !== ''));
  if (!cab) return [];
  return datos.map(f => Object.fromEntries(cab.map((c, i) => [c.trim(), (f[i] ?? '').trim()])));
}

/** "1.234,56 €" -> 1234.56 · "15,00%" -> 15 · "" -> null */
export function numES(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[€%\s]/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return isFinite(n) ? n : null;
}

/** "26/10/2025" -> "2025-10-26" */
export function fechaES(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : (String(v || '').match(/^\d{4}-\d{2}-\d{2}/) ? String(v).slice(0, 10) : null);
}

export function descargar(nombre, contenido, tipo = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
