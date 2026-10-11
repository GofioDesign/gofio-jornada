-- =====================================================================
-- GOFIO · 0028 · Avisos de seguridad del linter de Supabase
--  1. search_path fijo en las funciones que no lo tenían (aviso «Function Search Path Mutable»).
--     Sin él, quien cree un objeto con el mismo nombre en otro esquema podría colarlo
--     dentro de la función. Todas las demás ya llevan «set search_path = public».
--  2. comprobar_limite_usuarios es un trigger: nadie tiene que poder llamarla por la API.
--     Los triggers se disparan igual sin permiso de ejecución.
-- No cambia el cuerpo de ninguna función.
--
-- Avisos que se quedan a propósito:
--  · api_horarios, api_resumen, api_facturas ejecutables por anon: es la API de lectura
--    con clave (0023); cada llamada valida la clave y falla si no existe o está revocada.
--  · Funciones SECURITY DEFINER ejecutables por authenticated: son las RPC que llama la app
--    (fichar, emitir_factura, sa_*, …) y cada una comprueba por dentro la empresa y el rol;
--    o son las que usan las políticas RLS (es_miembro, tiene_rol, modulo_activo, es_superadmin),
--    que se evalúan con el rol del usuario y por eso necesitan el permiso.
-- =====================================================================

-- ---------- 1. search_path fijo ----------
alter function public.puede_gestionar(uuid)              set search_path = public;
alter function public.puede_ver_facturacion(uuid)        set search_path = public;
alter function public.puede_facturar(uuid)               set search_path = public;
alter function public.tocar_actualizado()                set search_path = public;
alter function public.momento_efectivo(public.fichajes)  set search_path = public;
alter function public.fichajes_inmutables()              set search_path = public;
alter function public.facturas_inmutables()              set search_path = public;
alter function public.lineas_inmutables()                set search_path = public;
alter function public.calcular_documento(jsonb, numeric) set search_path = public;
alter function public.anulaciones_inmutables()           set search_path = public;

-- ---------- 2. Trigger fuera de la API ----------
revoke execute on function public.comprobar_limite_usuarios() from public, anon, authenticated;

-- Comprobación (en el SQL Editor, tras ejecutar este archivo): debe devolver 0 filas.
--   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.prokind = 'f'
--      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
