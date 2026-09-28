// Configuración pública de la app (estas claves pueden estar en el navegador: la seguridad la pone RLS en la base de datos).
// Sin URL => la app arranca en MODO DEMO y guarda los datos solo en este navegador.
export const CONFIG = {
  SUPABASE_URL: 'https://zquhugdjxfinjqtdxjna.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxdWh1Z2RqeGZpbmpxdGR4am5hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzNDc1OTUsImV4cCI6MjEwNTkyMzU5NX0.E8oca8rvGo3GsauH2tnbtDnduFWPWB-d1xjxqVxfcwc',   // anon public (pública; la seguridad la pone RLS)
  VERSION: '0.1.6',
  SOPORTE_EMAIL: 'hola@gofiodesign.eu',
};
