// Configuración pública de la app (estas claves pueden estar en el navegador: la seguridad la pone RLS en la base de datos).
// Sin URL => la app arranca en MODO DEMO y guarda los datos solo en este navegador.
export const CONFIG = {
  SUPABASE_URL: '',        // p. ej. 'https://abcdxyz.supabase.co'
  SUPABASE_ANON_KEY: '',   // Supabase ▸ Project Settings ▸ API ▸ anon public
  VERSION: '0.1.0',
  SOPORTE_EMAIL: 'hola@gofiodesign.eu',
};
