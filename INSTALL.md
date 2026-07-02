# Instalación del módulo en tu app Base44

Guía técnica para desplegar el módulo. Para el paso a paso del usuario final (cargar CUIT, generar certificado, emitir) ver [`docs/GUIA_INSTALACION.md`](./docs/GUIA_INSTALACION.md).

## Estructura del módulo

```
entities/          Definiciones JSON Schema de las entidades Base44
  ArcaEmisor.json
  ArcaTokenCache.json
  ArcaComprobante.json
  ArcaLicencia.json    cache del plan GoxTech por CUIT (7 días)
functions/         Backend functions (Deno). arcaCore.js es el helper compartido.
  arcaCore.js          cripto + ambiente + SOAP (no es un endpoint)
  generarCertificado.js
  cargarCertificado.js
  wsaaLogin.js
  validarComprobante.js
  emitirFactura.js
  generarPdf.js
  verificarEmisor.js
  apiEmitir.js         webhook para ERPs externos
  licencia.js          verificación/registro de licencia GoxTech (gratis)
components/        UI React
  EmisorForm.jsx
  CertificadoWizard.jsx
  EmisionForm.jsx
  ComprobantesList.jsx
  LicenciaBadge.jsx    estado del plan + registro gratis
```

## Pasos

1. **Entidades.** Creá `ArcaEmisor`, `ArcaTokenCache`, `ArcaComprobante` y `ArcaLicencia` con los campos de `entities/*.json`.

2. **Secret obligatorio.** En la configuración del proyecto (secrets), creá:
   ```
   ARCA_MASTER_KEY = <cadena aleatoria larga, ej. 48+ chars>
   ```
   Protege la clave privada de todos los emisores. **Guardala aparte**: si la perdés, hay que regenerar los certificados.

3. **Backend functions.** Subí los archivos de `functions/`. Todos importan `./arcaCore.js` con path relativo, así que deben deployarse juntos. Dependencias npm (se resuelven solas vía `npm:` en Deno): `node-forge`, `fast-xml-parser`, `jspdf`, `qrcode`, `@base44/sdk`.

4. **UI.** Montá los componentes de `components/` en tus páginas. Usan `@/api/entities` y `@/api/functions` (convención Base44).

5. **Storage (PDF).** `generarPdf` sube el PDF con `base44.integrations.Core.UploadFile`. Si tu versión del SDK expone otra API de subida, ajustá esa llamada en `functions/generarPdf.js`.

## Endpoint webhook (ERP externo)

Cada emisor tiene un campo `apiToken`. Generá uno (cadena aleatoria) y guardalo en el `ArcaEmisor`. El ERP emite así:

```bash
curl -X POST "https://<TU-APP>.base44.app/functions/apiEmitir" \
  -H "Authorization: Bearer <API_TOKEN_DEL_EMISOR>" \
  -H "Content-Type: application/json" \
  -d '{
    "emisorId": "...",
    "tipoCbte": 6,
    "concepto": 1,
    "docTipoReceptor": 96,
    "docNroReceptor": "12345678",
    "condicionIvaReceptorId": 5,
    "impNeto": 10000,
    "alicuotasIva": [{ "id": 5, "baseImp": 10000, "importe": 2100 }],
    "impIva": 2100,
    "impTotal": 12100,
    "fechaCbte": "2026-06-30"
  }'
```

Respuesta: `{ ok, estado, cae, caeVencimiento, nroCbte, pdfUrl, comprobanteId }`.

## Licenciamiento GoxTech (gratis)

El módulo se engancha al sistema de licencias de GoxTech (el mismo de FactuSol),
llaveado por **CUIT**. La emisión es **siempre gratis** (plan `basica`) y **nunca
se bloquea**: la licencia solo registra el CUIT y trackea versión/uso, y deja
lista la base para activar features pagas más adelante.

- `licencia.js` verifica contra `GET /licenses/check` (cache-first, 7 días en
  `ArcaLicencia`, con fallback offline: si no hay conexión, sigue en modo básico).
- `emitirFactura` adjunta el estado de licencia en su respuesta (campo `licencia`),
  sin condicionar la emisión.
- El componente `LicenciaBadge` muestra el plan y permite registrar la licencia
  gratis (`POST /licenses/free`) con el email del emisor.

Variables de entorno **opcionales** (tienen default productivo):

```
ARCA_LICENSE_URL    = https://goxtech.com.ar/base44_arca/api     # mount propio de base44 (default)
ARCA_MODULE_ID      = base44_arca                                # identidad de producto
ARCA_MODULE_VERSION = 1.0.0                                      # versión del módulo
```

El módulo tiene su **mount propio** en el server de licencias (`/base44_arca/api`),
que proxya al **mismo backend y la misma base** que FactuSol (la licencia es por
CUIT). Requiere que en el server esté aplicada la `location` de Nginx (ver
`nginx_snippet.conf` / `BASE44_MOUNT.md` en el repo `GoxTech_ARCA_Site`). Hasta
que se despliegue, podés apuntar `ARCA_LICENSE_URL` al path histórico
`https://goxtech.com.ar/arca_factusol/api` — pega al mismo backend. Si el endpoint
no responde, la verificación cae a modo básico sin romper la emisión.

Además se identifica enviando `v=base44_arca/1.0.0` (`ARCA_MODULE_ID/ARCA_MODULE_VERSION`)
en `/licenses/check`. El server lo guarda como `app_version`, así en el panel
admin se distingue este módulo de FactuSol u otros clientes del mismo CUIT.

Como la licencia se comparte por CUIT entre productos, un CUIT con plan Completo
en FactuSol también lo verá acá.

## Notas de implementación

- **Firma WSAA en SHA-256.** Si el WSAA rechazara la firma en algún entorno, cambiá `DIGEST` en `arcaCore.js` a `forge.pki.oids.sha1` y `forge.md.sha1` en la generación del CSR.
- **Reloj.** El TRA usa UTC con margen ±10 min. El desfasaje de hora es la causa #1 de fallo de login.
- **Token cache.** Se guarda en `ArcaTokenCache` y se renueva 5 min antes de vencer. No se cachea en memoria (cada function es efímera).
- **Certificado por ambiente.** El `.crt` de homologación no sirve en producción. Cada `ArcaEmisor` tiene su `ambiente`.
