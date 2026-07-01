# Instalación del módulo en tu app Base44

Guía técnica para desplegar el módulo. Para el paso a paso del usuario final (cargar CUIT, generar certificado, emitir) ver [`docs/GUIA_INSTALACION.md`](./docs/GUIA_INSTALACION.md).

## Estructura del módulo

```
entities/          Definiciones JSON Schema de las entidades Base44
  ArcaEmisor.json
  ArcaTokenCache.json
  ArcaComprobante.json
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
components/        UI React
  EmisorForm.jsx
  CertificadoWizard.jsx
  EmisionForm.jsx
  ComprobantesList.jsx
```

## Pasos

1. **Entidades.** Creá `ArcaEmisor`, `ArcaTokenCache` y `ArcaComprobante` con los campos de `entities/*.json`.

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

## Notas de implementación

- **Firma WSAA en SHA-256.** Si el WSAA rechazara la firma en algún entorno, cambiá `DIGEST` en `arcaCore.js` a `forge.pki.oids.sha1` y `forge.md.sha1` en la generación del CSR.
- **Reloj.** El TRA usa UTC con margen ±10 min. El desfasaje de hora es la causa #1 de fallo de login.
- **Token cache.** Se guarda en `ArcaTokenCache` y se renueva 5 min antes de vencer. No se cachea en memoria (cada function es efímera).
- **Certificado por ambiente.** El `.crt` de homologación no sirve en producción. Cada `ArcaEmisor` tiene su `ambiente`.
