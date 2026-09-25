// Enlaces de navegación a Waze y Google Maps para un cliente / obra.
// Si el cliente tiene coordenadas GPS guardadas se usan (más exacto); si no, la dirección.

export function direccionCompleta(c = {}) {
  return [c.direccion, [c.cp, c.localidad || c.municipio].filter(Boolean).join(' '), c.provincia, c.pais]
    .map(x => (x || '').toString().trim()).filter(Boolean).join(', ');
}

export function tieneDestino(c = {}) {
  return (isFinite(c.lat) && isFinite(c.lng) && c.lat !== null && c.lng !== null) || !!(c.direccion || c.localidad || c.municipio);
}

function coords(c) {
  return c.lat !== null && c.lat !== undefined && c.lng !== null && c.lng !== undefined && isFinite(c.lat) && isFinite(c.lng)
    ? `${Number(c.lat).toFixed(6)},${Number(c.lng).toFixed(6)}` : null;
}

export function wazeUrl(c = {}) {
  const ll = coords(c);
  return ll ? `https://waze.com/ul?ll=${ll}&navigate=yes`
            : `https://waze.com/ul?q=${encodeURIComponent(direccionCompleta(c))}&navigate=yes`;
}

export function mapsUrl(c = {}) {
  const ll = coords(c);
  const dest = ll || encodeURIComponent(direccionCompleta(c));
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}

export function navegarUrl(c, app = 'waze') {
  return app === 'maps' ? mapsUrl(c) : wazeUrl(c);
}

// Distancia en línea recta (km) entre dos puntos
export function distanciaKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 100) / 100;
}
