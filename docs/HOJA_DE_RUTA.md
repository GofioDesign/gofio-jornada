# Hoja de ruta de la migración

La hoja «Gofio Facturación» v7 **sigue funcionando** mientras tanto. No se apaga nada hasta que su sustituto esté probado.

## Fase 0 · Hecho (v0.1)
- Esquema multiempresa con usuarios, roles, planes gratis/pro y límites aplicados en la base de datos.
- Módulo **Jornada** completo:
  - Fichar entrada, pausa, reanudación y salida.
  - Desplazamientos hacia un cliente, que abren Waze o Google Maps.
  - Cambio de cliente a mitad del día, con la ubicación GPS guardada en el momento de fichar.
  - Correcciones con aprobación, vista del equipo, informe y CSV del registro, copia completa descargable.
- **Clientes**: búsqueda y filtros, Waze/Maps/llamar, «guardar la ubicación de la obra» y horas de los últimos 30 días.
- **Facturación (testers)**: esquema completo, emisión con el cálculo y la huella de la v7, histórico importable y **facturar las horas fichadas de un cliente**.
- Pruebas automáticas: base de datos (roles, límites, inmutabilidad, aislamiento, totales y cadena v7) y lógica de la app.

## Fase 1 · Poner en producción la Jornada (1–2 semanas)
- [ ] Crear el proyecto de Supabase y el repositorio (docs/DESPLIEGUE.md).
- [ ] Probarla internamente en Gofio Design con 2 o 3 personas durante una semana.
- [ ] Textos legales: aviso de privacidad del registro horario y de la geolocalización, y contrato de encargado de tratamiento para las empresas cliente.
- [ ] **Copia automática Pro**: una Edge Function programada cada noche (pg_cron) que:
  1. recorre `v_copias_pendientes`;
  2. genera `copia_jornada()` y el CSV del mes;
  3. los sube a la carpeta de Drive de la empresa (cuenta de servicio de Google con la carpeta compartida, o OAuth del propietario);
  4. anota el resultado en `exportaciones`.
- [ ] Cobro del plan Pro (Stripe Checkout + webhook que actualiza `plan_id` y `plan_hasta`).
- [ ] Aviso a quien lleva más de X horas sin fichar la salida (notificación push o email).

## Fase 2 · Facturación para testers (paridad con la v7)
Por orden de uso real:
1. [x] Importador del histórico: validación conjunta de FACTURAS + LINEAS + COBROS en CSV, importación idempotente y conservación de la huella.
2. [ ] Productos y proveedores: importar CSV, y una pantalla de lista con filtros por familia y activo.
3. [ ] Editor de factura y presupuesto: líneas desde productos, IGIC por línea, IRPF por cliente y borradores.
4. [ ] **PDF** (idiomas ES/EN), guardado en Supabase Storage con copia opcional en Drive.
5. [ ] Cobros, estado pendiente/vencida y recordatorios.
6. [ ] Gastos con foto del ticket, cuadre bancario (importar el extracto) y resumen IGIC 420 / IRPF 130.
7. [ ] Presupuesto → factura (con anticipo) y rectificativas desde la interfaz.
8. [ ] **Verifactu** (obligatorio para autónomos desde el 1-7-2027): generar el registro de facturación con su huella oficial y el QR, y enviarlo a la AEAT. La huella actual está pensada para esa migración. **Antes de ofrecer la facturación a terceros**, Gofio Design, como productor del software, debe presentar la *declaración responsable* del sistema informático de facturación.

## Fase 3 · Apagar la v7
- Exportar la última versión de cada pestaña, importar el histórico y comprobar la integridad de la cadena.
- Dejar la hoja en solo lectura como archivo.

## Decisiones tomadas
| Decisión | Motivo |
|---|---|
| Supabase (Postgres) en lugar de Apps Script | Velocidad, varios usuarios por empresa, reglas en la base de datos, un solo código para todos |
| HTML + JS sin compilación | Se publica copiando la carpeta; sin dependencias que mantener; es fácil de retocar |
| Reglas críticas en SQL | La app no puede saltárselas y sirven igual para una futura app nativa o una API |
| Hora del servidor al fichar | El registro de jornada no se puede falsear cambiando la hora del móvil |
| GPS solo al fichar (se puede desactivar) | Proporcionalidad (RGPD): nada de seguimiento continuo |
| Clientes comunes a Jornada y Facturación | Las horas por cliente pasan a factura sin volver a teclearlas |
