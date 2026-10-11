# Gofio Jornada

Control de jornada laboral y facturación para pequeñas empresas, de Gofio Design.
En producción en **<https://jornada.gofiodesign.eu>**.

Es una PWA (se instala en el móvil desde el navegador) que sustituye poco a poco a la hoja «Gofio Facturación» v7.

## Qué hace hoy

| Módulo | Estado | Qué incluye |
|---|---|---|
| **Jornada** | En uso | Fichar entrada, pausa, reanudación y salida con la hora del servidor; desplazamientos a clientes (Waze / Google Maps); GPS solo al fichar; correcciones con aprobación; vista del equipo; informe y CSV; copia completa descargable. |
| **Clientes** | En uso | Búsqueda y filtros, llamar / navegar, guardar la ubicación de la obra, horas de los últimos 30 días. |
| **Facturación** | Beta (solo testers) | Borradores con IGIC por línea e IRPF por cliente, emisión con la huella encadenada de la v7, PDF ES/EN (impresión del navegador), filtro por estado de cobro, facturar las horas fichadas, importador del histórico de la v7. |
| **Productos y proveedores** | Beta | Catálogo con familias, márgenes objetivo sobre coste, formatos de compra, costes con cuatro decimales, histórico de precios, baja lógica de proveedores. |
| **Presupuestos** | En desarrollo | Partidas libres o desde el catálogo, total estimado y solicitud de precio a proveedores por email. |

Lo que falta está en [docs/HOJA_DE_RUTA.md](docs/HOJA_DE_RUTA.md).

## Cómo está hecho

- **Frontal**: HTML + JavaScript (módulos ES) sin compilación ni dependencias, en `app/`. Se publica copiando la carpeta.
- **Base de datos**: Supabase (Postgres + Auth). Las reglas importantes (roles, límites del plan, inmutabilidad de fichajes y facturas, aislamiento entre empresas) están en SQL con RLS, así que la app no puede saltárselas.
- **Acceso**: enlace mágico o código de 6 cifras por email.
- **Multiempresa**: una sola instalación y un solo código para todas las empresas; planes gratis / pro con límites aplicados en la base de datos.

```
app/                 PWA publicada (index.html, sw.js, config.js, css/, js/, icons/)
  js/api.js          Acceso a Supabase y modo demo (localStorage)
  js/views/          Pantallas (jornada, clientes, equipo, facturación, presupuestos…)
  js/lib/            Lógica pura y probada (cálculo de jornada, facturas, precios, CSV, mapas)
supabase/migrations/ Esquema de la base de datos, en orden (0001 → 0013)
supabase/tests/      Pruebas de la base de datos (solo para CI, crean datos falsos)
tests/               Pruebas de la lógica de la app (node --test)
docs/                Despliegue y hoja de ruta
.github/workflows/   Pruebas en cada push y publicación de app/ al subir a main
```

## Trabajar en local

```bash
python -m http.server 8080 --directory app   # http://localhost:8080
```

- Con `SUPABASE_URL` vacío en `app/config.js`, o añadiendo `?demo` a la URL, la app arranca en **modo demo**: cualquier email vale y los datos se guardan solo en ese navegador.
- Con la configuración real se conecta a Supabase (añade `http://localhost:8080` a las *Redirect URLs* de Supabase).

## Pruebas

```bash
npm test                                  # lógica de la app (Node 22)
PGHOST=localhost ./supabase/tests/ejecutar.sh   # migraciones + pruebas SQL en un Postgres 16 local
```

GitHub Actions ejecuta las dos en cada push y pull request.

## Publicar una versión

1. Sube el número en **dos sitios** a la vez: `CACHE` en `app/sw.js` y `VERSION` en `app/config.js` (las pruebas fallan si no coinciden). Así los móviles descargan la versión nueva.
2. Si añades un archivo `.js`, inclúyelo también en la lista `APP` de `app/sw.js` (también lo comprueban las pruebas).
3. Los cambios de base de datos van siempre en una migración **nueva** (`0014_...sql`) y se aplican en Supabase antes de publicar el código que la usa.
4. Haz merge a `main`: se publica automáticamente si las pruebas pasan.

Más detalle en [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).

## Contacto

hola@gofiodesign.eu
