# Arquitectura técnica — Módulo Factura Electrónica ARCA para Base44

> Documento fuente de verdad. Toda decisión técnica del módulo se justifica acá.
> Si el prompt maestro y este doc entran en conflicto, **gana este doc**.

---

## 1. Restricciones del entorno (leer antes de codear)

Base44 ejecuta las backend functions en **Deno serverless**. Esto impone tres límites que condicionan todo el diseño:

| Restricción | Consecuencia de diseño |
|---|---|
| No hay OpenSSL CLI ni acceso a shell | Keygen, CSR y firma PKCS#7 del WSAA se hacen **100% en JS con `node-forge`**. No se invoca `openssl` en ningún lado. |
| No hay filesystem persistente | El `.key`, el `.crt` y el token/sign **no se guardan en disco**. Van a la DB (encriptados) y a la tabla de cache. |
| Cada function es efímera y aislada | No se cachea token en memoria de proceso. El cache de token WSAA vive en una **entidad de DB** (`ArcaTokenCache`). |

Wrapper obligatorio de toda function:

```js
import { createClientFromRequest } from "npm:@base44/sdk";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  // lógica
  return Response.json({ ... });
});
```

Acceso admin a datos (para leer config de cualquier tenant desde el backend): `base44.asServiceRole.entities.X`.

---

## 2. Endpoints ARCA (verificados, post-migración AFIP→ARCA)

| Servicio | Homologación | Producción |
|---|---|---|
| **WSAA** (auth) | `https://wsaahomo.afip.gob.ar/ws/services/LoginCms` | `https://wsaa.afip.gob.ar/ws/services/LoginCms` |
| **WSFEv1** (factura) | `https://wswhomo.arca.gob.ar/wsfev1/service.asmx` | `https://servicios1.arca.gob.ar/wsfev1/service.asmx` |
| **WS Padrón A13** (opcional) | `https://awshomo.afip.gob.ar/sr-padron/webservices/personaServiceA13` | `https://aws.afip.gob.ar/sr-padron/webservices/personaServiceA13` |

WSDL = URL del servicio + `?WSDL`. Los dominios `afip.gob.ar` siguen activos por retrocompatibilidad; ARCA no rompió las URLs de WSAA todavía. El módulo mantiene ambas familias parametrizadas por si migran.

> ⚠️ Certificado y ambiente son **independientes**: un `.crt` de homologación (gestionado por WSASS) **no sirve** en producción, y viceversa. El emisor gestiona cada uno por separado.

---

## 3. Flujo end-to-end

```
[1] Alta emisor (auto-gestión)
      │  carga CUIT + razón social + condición IVA + punto de venta
      ▼
[2] generarCertificado()  ──► genera RSA 2048 + CSR (node-forge)
      │                        guarda la .key encriptada en DB
      │                        devuelve el .csr al usuario
      ▼
[3] Usuario sube el .csr a ARCA (WSASS homo / Adm. Cert. prod)
      │  descarga el .crt y lo pega en el módulo
      ▼
[4] wsaaLogin()  ──► arma TRA (XML) ─► firma PKCS#7 ─► LoginCms
      │                cachea Token + Sign (validez 12 h) en ArcaTokenCache
      ▼
[5] validarComprobante()  ──► reglas fiscales locales (sin llamar a ARCA)
      ▼
[6] emitirFactura()
      │  FECompUltimoAutorizado ─► nro siguiente
      │  FECAESolicitar (con Token/Sign) ─► CAE + vencimiento
      │  persiste Comprobante (estado APROBADO / RECHAZADO)
      ▼
[7] generarPdf()  ──► PDF con QR obligatorio (jsPDF + qrcode)
```

Puntos de entrada:
- **UI Base44** → llama functions vía SDK (`base44.functions.emitirFactura(...)`).
- **ERP/app externa** → pega al **HTTP endpoint** de la function (webhook) con un token de API. Esto cubre el requisito de "vincular su propio ERP".

---

## 4. Modelo de datos (entidades Base44)

### `ArcaEmisor` — configuración fiscal por tenant
| Campo | Tipo | Notas |
|---|---|---|
| `cuit` | string(11) | sin guiones |
| `razonSocial` | string | |
| `condicionIva` | enum | `RI` / `MONOTRIBUTO` / `EXENTO` |
| `puntoVenta` | int | debe ser tipo WSFEV1 y estar activo en ARCA |
| `ambiente` | enum | `HOMOLOGACION` / `PRODUCCION` |
| `certificadoCrt` | text | `.crt` en base64/PEM |
| `clavePrivadaEnc` | text | `.key` **encriptada** (ver §7) |
| `estado` | enum | `PENDIENTE_CERT` / `ACTIVO` / `ERROR` |

### `ArcaTokenCache` — token WSAA vigente
| Campo | Tipo | Notas |
|---|---|---|
| `cuit` | string | |
| `servicio` | string | `wsfe` |
| `ambiente` | enum | |
| `token` | text | |
| `sign` | text | |
| `expiraEn` | datetime | `expirationTime` del TA |

Antes de cada emisión: si existe token no vencido para `(cuit, servicio, ambiente)` → se reutiliza. Si no → `wsaaLogin()`.

### `ArcaComprobante` — factura emitida
| Campo | Tipo | Notas |
|---|---|---|
| `emisorId` | ref | |
| `tipoCbte` | int | ver tabla §5 |
| `puntoVenta` | int | |
| `nroCbte` | int | devuelto por ARCA |
| `concepto` | int | 1/2/3 |
| `docTipoReceptor` | int | 80/86/96/99 |
| `docNroReceptor` | string | |
| `condicionIvaReceptorId` | int | **obligatorio RG 5616** |
| `impNeto` / `impIva` / `impTrib` / `impTotConc` / `impOpEx` / `impTotal` | decimal | |
| `alicuotasIva` | json | `[{id, baseImp, importe}]` |
| `moneda` / `cotizacion` | string / decimal | `PES` = 1 |
| `fechaCbte` | date | |
| `cae` | string | |
| `caeVencimiento` | date | |
| `estado` | enum | `APROBADO` / `RECHAZADO` / `OBSERVADO` |
| `observaciones` | json | array de `{code, msg}` de ARCA |
| `qrPayload` | text | base64 del JSON del QR |
| `pdfUrl` | text | |

---

## 5. Tablas de parámetros WSFEv1 (hardcodear como constantes)

**Tipo de comprobante** (`CbteTipo`):
`1` Factura A · `6` Factura B · `11` Factura C · `51` Factura M · `2/7/12` Nota Débito A/B/C · `3/8/13` Nota Crédito A/B/C

**Concepto**: `1` Productos · `2` Servicios · `3` Productos y Servicios

**Tipo de documento receptor**: `80` CUIT · `86` CUIL · `96` DNI · `99` Consumidor Final sin identificar

**Alícuotas IVA** (`Iva.Id`):
`3` 0% · `4` 10,5% · `5` 21% · `6` 27% · `8` 5% · `9` 2,5%

**Condición IVA del receptor** (RG 5616 — `CondicionIVAReceptorId`):
`1` Responsable Inscripto · `4` Exento · `5` Consumidor Final · `6` Monotributo · `7` No Categorizado · `8` Proveedor del Exterior · `9` Cliente del Exterior · `10` IVA Liberado Ley 19.640 · `13` Monotributista Social · `15` IVA No Alcanzado · `16` Monotributo Trab. Independiente Promovido

---

## 6. Lógica de validación (`validarComprobante`)

Corre **antes** de tocar ARCA. Rechaza local para no quemar numeración ni cuota de servicio.

1. **Tipo de comprobante según condición emisor/receptor**
   - Emisor RI + receptor RI → Factura A (1)
   - Emisor RI + receptor Monotributo/CF/Exento → Factura B (6)
   - Emisor Monotributo → Factura C (11), a cualquier receptor
   - Bloquear Factura A a Consumidor Final.
2. **Coherencia de importes**
   - `impTotal == impNeto + impIva + impTrib + impTotConc + impOpEx` (tolerancia ±0,01 por redondeo).
   - Σ `alicuotasIva[].importe == impIva`.
   - Σ `alicuotasIva[].baseImp == impNeto` (cuando aplica).
   - Factura C: `impIva = 0`, `impNeto = importe` (el subtotal va en ImpNeto), `impTotal = impNeto (+ impTrib)`; no se manda array de IVA. (AFIP espera el monto en ImpNeto, no en ImpTotConc.)
3. **`condicionIvaReceptorId` presente y coherente** con `docTipoReceptor` (ej: CF sin CUIT → doc 99 → cond 5).
4. **Fecha**: para concepto Productos, `fechaCbte` no más de 10 días hacia atrás ni a futuro respecto de hoy. Para Servicios el rango se amplía y requiere `FchServDesde/Hasta` y `FchVtoPago`.
5. **Punto de venta**: numérico, > 0. (La verificación de que sea tipo WSFEV1 y esté activo la hace ARCA; se captura el error y se traduce a mensaje claro.)

`verificarAjustesCuitEmisor`: consulta al Padrón A13 (o valida contra la config del emisor) que el CUIT esté activo, su condición frente al IVA y los puntos de venta habilitados, y avisa si hay desalineación con lo cargado en `ArcaEmisor`.

---

## 7. Seguridad de la clave privada (no negociable en repo público)

La `.key` es el equivalente a la firma fiscal del emisor. **Nunca** se guarda en texto plano ni se loguea.

Patrón recomendado del módulo:
- Un **master key** de la app se guarda en Base44 secrets (`ARCA_MASTER_KEY`), fuera de la DB.
- Al generar el certificado, la `.key` se encripta con AES-GCM derivando la clave del master + `cuit` (salt) y se guarda en `clavePrivadaEnc`.
- Se desencripta **solo en runtime dentro de `wsaaLogin`**, nunca se devuelve al frontend ni entra en respuestas de API.

> Advertencia honesta para el README: cualquier esquema donde la key vive en la DB de la app es un tradeoff. Es el patrón pragmático para auto-gestión multi-tenant, pero el operador del deploy es responsable de la custodia del master key y del control de acceso a la DB. Documentarlo, no esconderlo.

---

## 8. WSAA — armado y firma del TRA

1. Construir el TRA (XML) con `uniqueId`, `generationTime` (ahora −10 min), `expirationTime` (ahora +10 min) y `<service>wsfe</service>`.
2. Firmar el TRA como **CMS/PKCS#7 SignedData** (formato SMIME, DER→base64) usando `.crt` + `.key` con `forge.pkcs7`.
3. POST SOAP a `LoginCms` con el CMS en base64.
4. Parsear el `loginTicketResponse`: extraer `token`, `sign`, `expirationTime`.
5. Guardar en `ArcaTokenCache`.

El TRA vencido o con reloj desfasado es la causa #1 de error de login. Usar UTC y el margen de ±10 min.

---

## 9. QR obligatorio (RG 4892)

Contenido del QR = URL `https://www.afip.gob.ar/fe/qr/?p=` + base64 de este JSON:

```json
{
  "ver": 1,
  "fecha": "2026-06-30",
  "cuit": 20111111112,
  "ptoVta": 1,
  "tipoCmp": 6,
  "nroCmp": 143,
  "importe": 12100.00,
  "moneda": "PES",
  "ctz": 1,
  "tipoDocRec": 96,
  "nroDocRec": 12345678,
  "tipoCodAut": "E",
  "codAut": 74123456789012
}
```

`tipoCodAut` = `"E"` (CAE). `codAut` = el CAE numérico. El PDF incluye este QR más los datos legales del comprobante.

---

## 10. Librerías npm (todas vía `npm:` specifier en Deno)

- `npm:node-forge` — RSA keygen, CSR (PKCS#10), firma PKCS#7 del WSAA, parseo de PEM.
- `npm:fast-xml-parser` — armar/parsear SOAP y el loginTicketResponse (evita dependencias SOAP pesadas).
- `npm:jspdf` + `npm:qrcode` — PDF y QR.
- `npm:@base44/sdk` — cliente y acceso a entidades.

Se evita a propósito una librería SOAP monolítica: el request WSFEv1 se arma como XML plano y se postea con `fetch`. Más control, menos peso, mejor debug del `<soap:Fault>`.
