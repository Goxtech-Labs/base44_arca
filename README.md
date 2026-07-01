# Módulo Factura Electrónica ARCA para Base44

Módulo **open-source, configurable y de auto-gestión** para emitir facturas electrónicas de ARCA (ex-AFIP) desde cualquier app de [Base44](https://base44.com). Pensado para que cualquier PyME o desarrollador conecte su app o su ERP a ARCA sin pelearse con SOAP, certificados ni la burocracia de los web services.

> Con el SDK y los web services **gratuitos** de ARCA. Sin licencias, sin costos de servicio.

---

## Qué hace

- 🧾 **Emite comprobantes** A, B, C y M con obtención de **CAE** vía WSFEv1.
- 🔐 **Auto-gestión de certificados**: generás la clave privada y el CSR desde el mismo módulo, a partir de tu CUIT. Sin OpenSSL, sin archivos sueltos.
- ✅ **Valida antes de emitir**: tipo de comprobante según condición emisor/receptor, cuadre de importes, coherencia de IVA y de la condición IVA del receptor (RG 5616).
- 🏢 **Multi-tenant**: cada CUIT es un emisor independiente con su propio certificado.
- 🔌 **Vinculás tu ERP o app**: endpoint webhook para emitir desde sistemas externos.
- 📄 **PDF con QR obligatorio** (RG 4892) generado automáticamente.
- 🧪 Soporta **homologación y producción** con la misma base de código.
- 🆓 **Licencia gratis de GoxTech** (la misma de FactuSol, por CUIT): la emisión nunca se bloquea; solo registra el CUIT y trackea uso.

---

## Cómo está armado el repo

| Archivo | Para qué |
|---|---|
| **[`PROMPT_MAESTRO.md`](./PROMPT_MAESTRO.md)** | El prompt para generar el módulo con Claude Code o el builder de Base44. Copiás, pegás, ajustás el contexto y listo. |
| **[`entities/`](./entities)** | Definiciones JSON Schema de las entidades (`ArcaEmisor`, `ArcaTokenCache`, `ArcaComprobante`). |
| **[`functions/`](./functions)** | Backend functions Deno (`arcaCore.js` + las 8 functions: certificado, WSAA, validación, emisión, PDF, webhook). |
| **[`components/`](./components)** | UI React: alta de emisor, wizard de certificado, formulario de emisión y listado de comprobantes. |
| **[`INSTALL.md`](./INSTALL.md)** | Instalación técnica del módulo (entidades, secret, deploy de functions, webhook). |
| **[`docs/ARQUITECTURA.md`](./docs/ARQUITECTURA.md)** | Fuente de verdad técnica: modelo de datos, endpoints, flujo WSAA, validaciones, seguridad de la clave privada. |
| **[`docs/GUIA_INSTALACION.md`](./docs/GUIA_INSTALACION.md)** | Paso a paso para el usuario final: cargar CUIT, generar certificado, vincular ARCA, emitir. Sin saber programar. |

---

## Cómo se usa (resumen)

1. Generás el módulo en tu app Base44 usando el **prompt maestro**.
2. Cargás tu CUIT y datos fiscales.
3. El módulo genera tu **CSR**; lo subís a ARCA y bajás el `.crt`.
4. Pegás el `.crt` en el módulo → quedás vinculado.
5. Emitís (desde la UI o desde tu ERP vía webhook) → recibís **CAE + PDF con QR**.

El detalle completo está en la [guía de instalación](./docs/GUIA_INSTALACION.md).

---

## Requisitos

- Una app en Base44 (backend functions habilitadas — corren en Deno).
- Clave fiscal ARCA nivel 3.
- Un punto de venta tipo **WSFEV1** dado de alta en ARCA.

---

## Nota de seguridad (importante)

Este módulo guarda la **clave privada del certificado encriptada** (AES-GCM) dentro de la base de datos de tu app, protegida por un master key que vos manejás en los secrets de Base44. Es el patrón pragmático para auto-gestión multi-tenant, pero implica que **el operador del deploy es responsable de la custodia del master key y del control de acceso a la base**. Leé la sección de seguridad en [`ARQUITECTURA.md`](./docs/ARQUITECTURA.md#7-seguridad-de-la-clave-privada-no-negociable-en-repo-público) antes de ir a producción.

---

## Descargo de responsabilidad

Este es un proyecto comunitario, **no oficial de ARCA**. Los comprobantes que emitas tienen efectos fiscales reales en producción: probá siempre primero en homologación y validá con tu contador. Las tablas de parámetros y las resoluciones (RG 5616, RG 4892, etc.) pueden cambiar; revisá la documentación oficial de ARCA ante cualquier duda.

## Licencia

Se sugiere **AGPL v3** (coherente con un módulo de servicio open-source que se ofrece a terceros). Ajustá según tu criterio antes de publicar.

## Contribuir

PRs bienvenidos. Si ARCA saca una nueva versión de WSFEv1 o cambia una tabla de parámetros, actualizá `ARQUITECTURA.md` y la sección de tablas del prompt maestro — el resto queda estable.

---

*Si no damos soluciones, somos parte del problema.*
