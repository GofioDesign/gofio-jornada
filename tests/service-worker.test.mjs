import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function javascriptEn(directorio) {
  const entradas = await readdir(directorio, { withFileTypes: true });
  const archivos = await Promise.all(entradas.map(async entrada => {
    const ruta = path.join(directorio, entrada.name);
    return entrada.isDirectory() ? javascriptEn(ruta) : [ruta];
  }));
  return archivos.flat().filter(ruta => ruta.endsWith('.js'));
}

test('la precache incluye todos los modulos de la aplicacion', async () => {
  const sw = await readFile(path.join(raiz, 'app', 'sw.js'), 'utf8');
  const modulos = await javascriptEn(path.join(raiz, 'app', 'js'));

  for (const modulo of modulos) {
    const relativo = path.relative(path.join(raiz, 'app'), modulo).replaceAll('\\', '/');
    assert.match(sw, new RegExp(`['"]${relativo.replaceAll('.', '\\.') }['"]`), `${relativo} no esta en la precache`);
  }
});

test('la version de config.js coincide con la cache del service worker', async () => {
  const sw = await readFile(path.join(raiz, 'app', 'sw.js'), 'utf8');
  const config = await readFile(path.join(raiz, 'app', 'config.js'), 'utf8');
  const cache = sw.match(/CACHE\s*=\s*['"]gofio-jornada-v([^'"]+)['"]/)?.[1];
  const version = config.match(/VERSION:\s*['"]([^'"]+)['"]/)?.[1];
  assert.ok(cache && version, 'no se encuentra la version en sw.js o config.js');
  assert.equal(version, cache, 'sube a la vez CACHE en app/sw.js y VERSION en app/config.js');
});
