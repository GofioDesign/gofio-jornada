# Despliegue

## Situación actual

| Pieza | Dónde |
|---|---|
| Código | GitHub: `GofioDesign/gofio-jornada` (rama `main`) |
| App publicada | <https://jornada.gofiodesign.eu> — GitHub Pages con dominio propio (archivo `CNAME`) |
| Base de datos y acceso | Supabase, proyecto `zquhugdjxfinjqtdxjna` (región UE) |
| Pruebas | GitHub Actions: `.github/workflows/pruebas.yml` en cada push y pull request |
| Publicación | GitHub Actions: `.github/workflows/publicar.yml` publica `app/` al subir a `main` si `npm test` pasa |

## Flujo de trabajo habitual

1. Trabaja en una rama y abre un pull request: se ejecutan las pruebas de la app y de la base de datos.
2. Si el cambio toca la base de datos, crea un archivo **nuevo** en `supabase/migrations/` (el siguiente número libre, hoy `0014_...sql`). Las migraciones ya aplicadas **no se editan**.
3. Cada función SQL nueva debe llevar
   `revoke execute on function public.<nombre>(...) from public, anon;`
   (las pruebas fallan si se olvida).
4. Antes del merge, aplica la migración nueva en Supabase (**SQL Editor** → pegar → ejecutar, o `supabase db push` con la CLI).
5. Sube la versión en `app/sw.js` (`CACHE`) y `app/config.js` (`VERSION`) — deben coincidir.
6. Merge a `main` → se publica para todas las empresas a la vez.

> El flujo de publicación ejecuta `npm test`, pero **no** las pruebas SQL. Espera a que el pull request esté en verde antes de hacer merge.

## Configuración de Supabase (comprobar)

- **Authentication → Providers → Email**: activado, con **«Confirm email» ACTIVADO**. Si se desactiva, cualquiera podría darse de alta con el email de otra persona y aceptar su invitación.
- **Authentication → URL Configuration**:
  - *Site URL*: `https://jornada.gofiodesign.eu`
  - *Redirect URLs*: `https://jornada.gofiodesign.eu` y `http://localhost:8080`
- **Authentication → Emails**: plantilla «Magic Link» en español e incluyendo `{{ .Token }}` (código de 6 cifras, útil si el enlace se abre en otro navegador).
- **SMTP propio** (Project Settings → Authentication → SMTP) para enviar más de unos pocos correos por hora.
- **Project Settings → API**: en `app/config.js` solo van `Project URL` y la clave `anon public`. Esa clave es pública por diseño (la seguridad la pone RLS). **Nunca** pongas la clave `service_role` en la app ni en el repositorio.

## Tareas de Gofio Design (consola SQL de Supabase)

```sql
-- Activar la facturación a una empresa tester
update organizaciones set tester_facturacion = true, usa_facturacion = true where nombre = 'Gofio Design';

-- Pasar una empresa a Pro (hasta una fecha, o null = indefinido)
update organizaciones set plan_id = 'pro', plan_hasta = '2027-09-30' where id = '...';

-- Cambiar el límite del plan gratis o crear planes nuevos
update planes set max_usuarios = 3 where id = 'gratis';
```

Cuando vence `plan_hasta`, la empresa vuelve a los límites del plan gratis. **Sus datos no se tocan.**
(Mientras no exista el cobro con Stripe, el plan Pro se activa así, a mano.)

## Primer uso de una empresa nueva

1. Abre la app → email → enlace o código → **Crea tu empresa**.
2. Ajustes → **Importar clientes**: en la hoja v7, pestaña CLIENTES → *Archivo ▸ Descargar ▸ CSV* → elegir el archivo en la app.
3. Ajustes → **Invitar**: cada persona entra con su email y ve su invitación.
4. En el móvil: menú del navegador → **Añadir a pantalla de inicio**.

## Hosting y visibilidad del repositorio

GitHub Pages solo publica desde repositorios **públicos** en el plan gratuito de GitHub. Para hacer el repositorio privado hay dos caminos:

- **GitHub Pro** (de pago): Pages sigue funcionando desde el repositorio privado sin cambiar nada más. La web sigue siendo pública.
- **Cloudflare Pages** (gratis): conectar el repositorio privado, sin comando de build obligatorio (o `npm test`), con `app` como directorio de salida, y mover allí el dominio `jornada.gofiodesign.eu`. Después se desactiva GitHub Pages y se borra `publicar.yml`.

Hacer privado el repositorio no oculta nada de la web: el navegador sigue descargando `app/` (incluida la clave `anon`). Lo que deja de verse es el historial, las migraciones SQL y las pruebas.

## Montar una instalación desde cero

Solo hace falta para un entorno nuevo (por ejemplo, de pruebas).

1. **Supabase** → New project, región **West EU (Ireland)** o **Central EU (Frankfurt)**.
2. **SQL Editor** → ejecuta **en orden** todos los archivos de `supabase/migrations/` (0001 → la última). **No** ejecutes nada de `supabase/tests/`: crean datos falsos.
   *(Alternativa: `supabase link` y `supabase db push`.)*
3. Aplica la configuración de la sección «Configuración de Supabase» con la URL del nuevo entorno.
4. Pon `SUPABASE_URL` y `SUPABASE_ANON_KEY` del proyecto nuevo en `app/config.js`.
5. Publica `app/` en cualquier hosting estático (GitHub Pages con *Source: GitHub Actions*, Cloudflare Pages o Netlify), sin build.
