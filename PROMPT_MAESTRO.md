# PROMPT MAESTRO — Generador del módulo Factura Electrónica ARCA (Base44)

> **Cómo usar este archivo:** copiá el bloque de abajo (todo lo que está dentro de `=== PROMPT ===`) y pegalo en Claude Code, en el builder de Base44, o en el agente que uses. Ajustá solo la sección `[CONTEXTO DEL PROYECTO]` con los datos de tu app. El resto no se toca: encoda las decisiones de arquitectura verificadas y los errores clásicos de ARCA ya resueltos.

---

## === PROMPT ===

Sos un ingeniero senior especializado en integraciones fiscales argentinas (ARCA/ex-AFIP) y en la plataforma Base44 (backend Deno serverless). Vas a construir un **módulo de factura electrónica ARCA reutilizable, configurable y de auto-gestión** dentro de una app Base44.

### [CONTEXTO DEL PROYECTO]
- Nombre de la app: `<COMPLETAR>`
- Objetivo: permitir que cualquier tenant cargue su CUIT, genere su certificado, se vincule a ARCA y emita comprobantes electrónicos válidos (con CAE), consultables desde la UI y desde un ERP externo vía webhook.
- Idioma de la UI y mensajes: español rioplatense, claro y directo.

### RESTRICCIONES DEL ENTORNO (obligatorias, no las violes)
1. Runtime **Deno**. Toda function usa el wrapper `Deno.serve(async (req) => { ... })` y devuelve `Response`. Importás con specifiers `npm:`.
2. **No hay OpenSSL CLI ni shell ni filesystem persistente.** Toda la criptografía (generación de par RSA, CSR, y firma PKCS#7 del WSAA) se hace en JS puro con `npm:node-forge`. Prohibido invocar procesos externos o escribir archivos a disco.
3. El cache del token WSAA vive en una **entidad de base de datos**, nunca en memoria de proceso.
4. La clave privada `.key` **nunca** se guarda en texto plano, ni se loguea, ni se devuelve al frontend. Se encripta con AES-GCM usando un master key guardado en Base44 secrets (`ARCA_MASTER_KEY`), con el CUIT como salt. Se desencripta solo en runtime dentro de `wsaaLogin`.
5. Usás el SDK: `import { createClientFromRequest } from "npm:@base44/sdk"`. Acceso admin a datos con `base44.asServiceRole.entities.X`.

### ENDPOINTS ARCA (parametrizá por ambiente, no los hardcodees sueltos)
- WSAA homo: `https://wsaahomo.afip.gob.ar/ws/services/LoginCms` · prod: `https://wsaa.afip.gob.ar/ws/services/LoginCms`
- WSFEv1 homo: `https://wswhomo.arca.gob.ar/wsfev1/service.asmx` · prod: `https://servicios1.arca.gob.ar/wsfev1/service.asmx`
- Padrón A13 homo: `https://awshomo.afip.gob.ar/sr-padron/webservices/personaServiceA13` · prod: `https://aws.afip.gob.ar/sr-padron/webservices/personaServiceA13`

### ENTIDADES A CREAR
Creá exactamente estas entidades con estos campos:

**ArcaEmisor**: cuit, razonSocial, condicionIva (enum RI|MONOTRIBUTO|EXENTO), puntoVenta (int), ambiente (enum HOMOLOGACION|PRODUCCION), certificadoCrt (text), clavePrivadaEnc (text), estado (enum PENDIENTE_CERT|ACTIVO|ERROR).

**ArcaTokenCache**: cuit, servicio (default "wsfe"), ambiente, token (text), sign (text), expiraEn (datetime).

**ArcaComprobante**: emisorId (ref), tipoCbte (int), puntoVenta (int), nroCbte (int), concepto (int), docTipoReceptor (int), docNroReceptor (string), condicionIvaReceptorId (int), impNeto, impIva, impTrib, impTotConc, impOpEx, impTotal (decimales), alicuotasIva (json array de {id, baseImp, importe}), moneda (default "PES"), cotizacion (default 1), fechaCbte (date), cae (string), caeVencimiento (date), estado (enum APROBADO|RECHAZADO|OBSERVADO), observaciones (json), qrPayload (text), pdfUrl (text).

### BACKEND FUNCTIONS A IMPLEMENTAR

**1. `generarCertificado`**
Input: emisorId (o cuit + razonSocial). Genera par RSA 2048 con node-forge. Arma un CSR (PKCS#10) con subject `/C=AR/O=<razonSocial>/CN=<alias>/serialNumber=CUIT <cuit>`. Encripta la clave privada (AES-GCM + master key) y la guarda en `ArcaEmisor.clavePrivadaEnc`. Setea estado `PENDIENTE_CERT`. Devuelve el CSR en PEM para que el usuario lo descargue y lo suba a ARCA. **No** genera el certificado final: ese lo emite ARCA.

**2. `cargarCertificado`**
Input: emisorId + `.crt` (PEM/base64). Valida que el CN/serialNumber del `.crt` corresponda al CUIT del emisor. Guarda en `certificadoCrt`, pasa estado a `ACTIVO`.

**3. `wsaaLogin`**
Reutilizá token vigente de `ArcaTokenCache` si `expiraEn > ahora`. Si no: armá el TRA (XML) con uniqueId, generationTime (ahora −10min UTC), expirationTime (ahora +10min UTC) y `<service>wsfe</service>`. Firmalo como CMS/PKCS#7 SignedData (SMIME, DER→base64) con `forge.pkcs7` usando el `.crt` + `.key` desencriptada. POST SOAP a LoginCms. Parseá token/sign/expirationTime del loginTicketResponse y cacheá. Manejá el error de reloj desfasado con mensaje claro.

**4. `validarComprobante`**
Reglas locales, sin llamar a ARCA (ver detalle en la sección REGLAS DE VALIDACIÓN). Devuelve `{valido: bool, errores: [...]}`.

**5. `verificarEmisor`**
Consulta Padrón A13 (o valida config local) para confirmar CUIT activo, condición frente al IVA y puntos de venta habilitados. Avisa si hay desalineación con `ArcaEmisor`.

**6. `emitirFactura`**
Orquesta: `validarComprobante` → si inválido, corta y devuelve errores. Si válido: `wsaaLogin` → `FECompUltimoAutorizado` (nro siguiente) → armá `FECAESolicitar` como XML SOAP y posteá con fetch → parseá Resultado (A=aprobado, R=rechazado, O=observado), CAE, CAEFchVto, y Observaciones/Errores. Persistí `ArcaComprobante` con estado. Si aprobó, llamá `generarPdf`. Devolvé el comprobante completo.

**7. `generarPdf`**
Con `npm:jspdf` + `npm:qrcode`. Genera el PDF legal del comprobante con: datos del emisor, receptor, ítems, discriminación de IVA (si aplica), CAE + vencimiento, y el **QR obligatorio** (ver sección QR). Devuelve/guarda `pdfUrl`.

**8. Endpoint webhook `apiEmitir`** (HTTP endpoint de la function)
Recibe POST de un ERP externo con un API token propio del tenant + payload de comprobante. Autentica, mapea el payload al formato interno, y reutiliza la lógica de `emitirFactura`. Devuelve CAE + pdfUrl. Este es el punto de vinculación con ERPs/apps de terceros.

### TABLAS DE PARÁMETROS (constantes)
- CbteTipo: 1=Fac A, 6=Fac B, 11=Fac C, 51=Fac M, 2/7/12=ND A/B/C, 3/8/13=NC A/B/C
- Concepto: 1=Productos, 2=Servicios, 3=Ambos
- DocTipo receptor: 80=CUIT, 86=CUIL, 96=DNI, 99=Consumidor Final
- Iva.Id: 3=0%, 4=10.5%, 5=21%, 6=27%, 8=5%, 9=2.5%
- CondicionIVAReceptorId (RG 5616): 1=RI, 4=Exento, 5=Cons.Final, 6=Monotributo, 7=No Categorizado, 8=Prov.Exterior, 9=Cliente Exterior, 10=IVA Liberado L.19640, 13=Monotrib.Social, 15=IVA No Alcanzado, 16=Monotrib.Trab.Indep.Promovido

### REGLAS DE VALIDACIÓN (implementar en `validarComprobante`)
1. Tipo de comprobante coherente: Emisor RI + receptor RI → Fac A. Emisor RI + receptor Monotributo/CF/Exento → Fac B. Emisor Monotributo → Fac C a cualquiera. **Bloquear Fac A a Consumidor Final.**
2. `impTotal == impNeto + impIva + impTrib + impTotConc + impOpEx` (tolerancia ±0.01).
3. Σ `alicuotasIva[].importe == impIva`; Σ `alicuotasIva[].baseImp == impNeto` cuando aplique.
4. Factura C: impIva=0, impNeto=importe (el subtotal va en ImpNeto), sin array de IVA, impTotal=impNeto(+impTrib). AFIP espera el monto en ImpNeto, no en ImpTotConc.
5. `condicionIvaReceptorId` presente (RG 5616) y coherente con `docTipoReceptor` (CF sin CUIT → doc 99 → cond 5).
6. Fecha: concepto Productos → `fechaCbte` no más de 10 días atrás ni a futuro. Servicios → exigir FchServDesde/Hasta y FchVtoPago.
7. puntoVenta numérico > 0.

### QR OBLIGATORIO (RG 4892)
Contenido = `https://www.afip.gob.ar/fe/qr/?p=` + base64(JSON) con campos: ver=1, fecha, cuit, ptoVta, tipoCmp, nroCmp, importe, moneda, ctz, tipoDocRec, nroDocRec, tipoCodAut="E", codAut=<CAE>.

### LIBRERÍAS
`npm:node-forge`, `npm:fast-xml-parser`, `npm:jspdf`, `npm:qrcode`, `npm:@base44/sdk`. **No** uses una librería SOAP monolítica: armá el XML del request WSFEv1 a mano y posteá con `fetch`, así tenés control del `<soap:Fault>` y mejor debug.

### MANEJO DE ERRORES ARCA (traducí a mensajes útiles)
- "Método no certificado…" → certificado no asociado al WS o CUIT sin adherir WSFE.
- "El punto de venta no existe / no está habilitado" → alta de PV tipo WSFEV1 en ARCA.
- "CbteNro no correlativo" → usar siempre FECompUltimoAutorizado antes de emitir.
- "Fecha del comprobante fuera de rango" → regla de 10 días.
- Token/sign inválido o vencido → forzar re-login WSAA.

### LICENCIAMIENTO GOXTECH (gratis, no bloqueante)
Integrá el sistema de licencias de GoxTech (el mismo de FactuSol), llaveado por CUIT y compartido entre productos. **La emisión es siempre gratis (plan `basica`) y NUNCA se bloquea**: la licencia solo registra el CUIT y trackea versión/uso.
- Base API (parametrizá por env `ARCA_LICENSE_URL`): `https://goxtech.com.ar/arca_factusol/api`. Versión por env `ARCA_MODULE_VERSION`.
- Entidad `ArcaLicencia`: cuit, plan (enum basica|monthly|completa), active, valid_until, message, appVersion, cachedAt. Cache-first 7 días.
- Function `licencia`: `verificarLicencia(cuit)` → `GET /licenses/check?cuit=&v=` con cache 7 días y fallback offline (si no hay internet, opera en `basica`, nunca falla). `registrarLicenciaGratis({cuit,email,companyName})` → `POST /licenses/free`. Helpers `tieneCompleta`/`esPago` para features pagas futuras.
- `emitirFactura` llama a `verificarLicencia` (no bloqueante) y adjunta `licencia` en la respuesta. La UI muestra el plan y permite registrar la licencia gratis con el email del emisor.

### ENTREGABLES
1. Definición de las entidades.
2. El código de cada backend function (Deno, comentado en español).
3. Un helper compartido `arcaCore.js` con: parametrización de ambiente, cripto (keygen/CSR/PKCS#7/AES-GCM), armado y parseo de SOAP.
4. Componentes de UI mínimos: alta de emisor, wizard de certificado (generar CSR → subir → pegar CRT), formulario de emisión con validación en vivo, y listado de comprobantes con acción "ver PDF".
5. README de instalación por tenant.

Empezá por `arcaCore.js` y las entidades. Antes de escribir código, listá los supuestos que estás tomando y confirmá el orden de implementación.

## === FIN DEL PROMPT ===

---

## Notas para quien mantiene el repo

- El prompt está calibrado para que el agente **no** alucine una librería SOAP ni intente usar OpenSSL: esos dos son los desvíos más comunes y rompen en Deno.
- Si ARCA publica una nueva versión de WSFEv1 (como pasó con RG 5616), actualizá la tabla de `CondicionIVAReceptorId` y los campos nuevos en la sección de tablas de parámetros; el resto del prompt queda estable.
- Para monotributistas puros el flujo es idéntico pero simplificado (siempre Factura C, sin discriminación de IVA). Vale documentar un "modo mono" en el README.
