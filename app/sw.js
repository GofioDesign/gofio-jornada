// Service worker: la app se abre al instante y funciona sin cobertura (los datos se piden al servidor al fichar).
const CACHE = 'gofio-jornada-v0.1.35';
const APP = ['./', 'index.html', 'config.js', 'css/app.css', 'manifest.webmanifest', 'icons/icono.svg', 'icons/icono-192.png',
  'js/main.js', 'js/api.js', 'js/ui.js', 'js/lib/jornada.js', 'js/lib/mapas.js', 'js/lib/csv.js',
  'js/lib/factura.js', 'js/lib/precios.js', 'js/views/acceso.js', 'js/views/jornada.js',
  'js/views/clientes.js', 'js/views/proyectos.js', 'js/views/equipo.js', 'js/views/ajustes.js', 'js/views/facturacion.js',
  'js/views/factura.js', 'js/views/borrador.js', 'js/views/maestros.js', 'js/views/presupuestos.js'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Archivos de la app: primero red y caché como respaldo. Datos (Supabase): siempre red.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.endsWith('supabase.co')) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const cached = await c.match(e.request, { ignoreSearch: u.origin === location.origin });
    try {
      // Los archivos propios se revalidan siempre (no-cache): así una versión recién publicada llega con la primera recarga
      // en vez de esperar a que caduque la caché HTTP del hosting (10 min). Las navegaciones no admiten opciones.
      const propio = u.origin === location.origin && e.request.mode !== 'navigate';
      const red = await fetch(e.request, propio ? { cache: 'no-cache' } : undefined);
      if (red.ok && (u.origin === location.origin || u.hostname === 'cdn.jsdelivr.net')) {
        c.put(e.request, red.clone());
      }
      return red;
    } catch {
      return cached || Response.error();
    }
  }));
});
