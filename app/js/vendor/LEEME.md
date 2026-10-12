# autoscript.js

Script oficial del Gobierno de España para que una página web firme con **AutoFirma** (Cliente @firma).

- Origen: https://github.com/ctt-gob-es/clienteafirma, `afirma-ui-miniapplet-deploy/src/main/webapp/js/autoscript.js`
- Versión: 1.10.1 (copiado sin cambios el 2026-10-12)
- Licencia: doble, GPL 2+ o EUPL 1.1 (la del proyecto clienteafirma)

Lo usa `js/lib/autofirma.js` y solo se carga cuando alguien elige firmar con certificado.
En el ordenador habla con AutoFirma por un WebSocket local, sin servidor intermedio.
