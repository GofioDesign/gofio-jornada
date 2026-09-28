# Puesta en marcha (unos 30 minutos, una sola vez)

## 1. Repositorio en GitHub
1. En GitHub: **New repository** → nombre `gofio-jornada`, **Private**, sin README.
2. Sube este código:
   ```bash
   git init && git add . && git commit -m "Gofio Jornada 0.1"
   git branch -M main
   git remote add origin https://github.com/<tu-usuario>/gofio-jornada.git
   git push -u origin main
   ```
   (O arrastra los archivos del .zip en la web de GitHub: «uploading an existing file».)
3. La pestaña **Actions** ejecutará las pruebas en cada cambio.

## 2. Base de datos en Supabase
1. Crea una cuenta en <https://supabase.com> → **New project**.
   - Región: **West EU (Ireland)** o **Central EU (Frankfurt)**, para que los datos se queden en la UE.
   - Guarda la contraseña de la base de datos en tu gestor de contraseñas.
2. **SQL Editor** → pega y ejecuta, **en orden**, cada archivo de `supabase/migrations/` (0001 → 0007).
   **No** ejecutes nada de `supabase/tests/`: son pruebas para GitHub Actions y crean datos falsos.
   *(Alternativa con la CLI: `supabase link` y después `supabase db push`.)*
3. **Authentication → Providers → Email**: activado y con **«Confirm email» ACTIVADO**. Si se desactiva, cualquiera podría darse de alta con el email de otra persona y aceptar su invitación.
4. **Authentication → URL Configuration**:
   - *Site URL*: la URL de la app (paso 3), p. ej. `https://<tu-usuario>.github.io/gofio-jornada/`
   - *Redirect URLs*: la misma URL y `http://localhost:8080` para pruebas.
5. **Authentication → Emails**: traduce al español la plantilla «Magic Link» e incluye `{{ .Token }}`, para que también llegue el código de 6 cifras (útil si el enlace se abre en otro navegador).
   Para enviar más de unos pocos correos por hora, configura un SMTP propio (p. ej. el de tu dominio o Brevo) en **Project Settings → Authentication → SMTP**.
6. **Project Settings → API**: copia `Project URL` y la clave `anon public` en `app/config.js`:
   ```js
   SUPABASE_URL: 'https://xxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJ...',
   ```
   Esta clave es pública; la seguridad la pone RLS. **Nunca** pongas en la app la clave `service_role`.

## 3. Publicar la app
**GitHub Pages** (gratis): Settings → Pages → Source: **GitHub Actions**. Cada `push` a `main` publica la carpeta `app/` si las pruebas pasan.
Para usar un dominio propio (p. ej. `jornada.gofiodesign.eu`), añádelo en Settings → Pages y crea el CNAME en tu DNS.

Otras opciones equivalentes: Cloudflare Pages o Netlify, apuntando al directorio `app/` sin comando de build.

## 4. Primer uso
1. Abre la app → escribe tu email → abre el enlace → **Crea tu empresa**.
2. Ajustes → **Importar clientes**: en tu hoja actual, abre la pestaña CLIENTES y ve a *Archivo ▸ Descargar ▸ CSV*; después elige ese archivo en la app.
3. Ajustes → **Invitar**: cada persona entra con su email y ve su invitación.
4. En el móvil: menú del navegador → **Añadir a pantalla de inicio**.

## 5. Tareas de Gofio Design (consola SQL de Supabase)
```sql
-- Activar la facturación a una empresa tester
update organizaciones set tester_facturacion = true, usa_facturacion = true where nombre = 'Gofio Design';

-- Pasar una empresa a Pro (hasta una fecha, o null = indefinido)
update organizaciones set plan_id = 'pro', plan_hasta = '2027-09-30' where id = '...';

-- Cambiar el límite del plan gratis o crear planes nuevos
update planes set max_usuarios = 3 where id = 'gratis';
```
Cuando vence `plan_hasta`, la empresa vuelve a tener los límites del plan gratis. **Sus datos no se tocan.**

## 6. Actualizar a todos los clientes
Hay un único código para todas las empresas: cada `push` a `main` actualiza la app de todas. Los cambios en la base de datos van en un **archivo de migración nuevo** (`0008_...sql`); los que ya se han aplicado no se editan.
Cada función nueva debe llevar `revoke execute on function public.<nombre>(...) from public, anon;` (las pruebas fallan si se olvida).
