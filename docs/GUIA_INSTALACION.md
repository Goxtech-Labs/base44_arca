# Guía de instalación y vinculación con ARCA

Esta guía es para vos, que tenés una app en Base44 y querés emitir facturas electrónicas de ARCA. No necesitás saber programar: el módulo hace el trabajo pesado. Sí necesitás **clave fiscal nivel 3** y unos minutos en el portal de ARCA.

---

## Antes de empezar

- [ ] Clave fiscal ARCA nivel 3 (o superior).
- [ ] Saber tu **condición frente al IVA**: Responsable Inscripto, Monotributo o Exento.
- [ ] Tener (o dar de alta) un **punto de venta tipo "WSFEV1"** en ARCA. Los puntos de venta de facturador en línea o talonario **no sirven** para web services.
- [ ] Definir si vas a probar primero en **homologación** (recomendado) o directo a **producción**.

> Homologación = ambiente de prueba. Las facturas **no tienen validez legal**, pero te deja verificar todo el circuito sin riesgo. Empezá por acá.

---

## Paso 1 — Instalar el módulo en tu app

1. Generá el módulo con el `PROMPT_MAESTRO.md` (en el builder de Base44 o en Claude Code).
2. En la configuración del proyecto (secrets), creá la variable `ARCA_MASTER_KEY` con un valor aleatorio largo. **Guardala aparte**: es la que protege tu clave privada. Si la perdés, tenés que regenerar el certificado.
3. Desplegá las backend functions.

---

## Paso 2 — Cargar tu emisor

En la pantalla de alta de emisor cargá:
- CUIT (sin guiones)
- Razón social
- Condición IVA
- Punto de venta (el tipo WSFEV1)
- Ambiente: empezá con **Homologación**

Guardá. El emisor queda en estado `PENDIENTE_CERT`.

---

## Paso 3 — Generar el certificado (auto-gestión)

El módulo genera por vos la clave privada y el pedido de certificado (CSR). Vos no manejás archivos sueltos ni OpenSSL.

1. Tocá **"Generar certificado"**. El módulo:
   - crea tu clave privada (queda encriptada dentro de la app, nunca se muestra),
   - genera el **CSR** (el pedido).
2. **Descargá el CSR.**

---

## Paso 4 — Subir el CSR a ARCA y bajar el certificado

**En homologación** (para probar):
1. Entrá a **WSASS** (Autoservicio de Acceso a APIs de Homologación) con clave fiscal.
2. Subí el CSR, generá el certificado de testing y **descargá el `.crt`**.
3. Asociá el certificado al servicio **wsfe**.

**En producción** (cuando ya probaste):
1. Entrá a **Administrador de Certificados Digitales** con clave fiscal.
2. Subí el CSR y **descargá el `.crt`** de producción.
3. En **Administrador de Relaciones**, agregá la relación con **"WSFE - Facturación Electrónica"** y asociá el certificado.

> El certificado de homologación y el de producción son distintos y no son intercambiables. Cada ambiente tiene el suyo.

---

## Paso 5 — Cargar el certificado en el módulo

1. Volvé al módulo, tocá **"Cargar certificado"** y pegá (o subí) el `.crt`.
2. El módulo valida que el certificado corresponda a tu CUIT y pasa el emisor a estado `ACTIVO`.

Listo: ya estás vinculado a ARCA.

---

## Paso 6 — Emitir tu primera factura de prueba

1. Andá al formulario de emisión.
2. Cargá receptor, condición IVA del receptor (**obligatorio** desde RG 5616), concepto e importes.
3. El módulo **valida antes de mandar** (tipo de comprobante correcto, cuadre de importes, IVA coherente). Si algo está mal, te lo dice antes de tocar ARCA.
4. Emitir. Si sale todo bien, recibís el **CAE** y el **PDF con QR**.

Si funciona en homologación, repetí Pasos 3 a 5 con el certificado de **producción** y cambiá el ambiente del emisor a `PRODUCCION`.

---

## Paso 7 (opcional) — Vincular tu ERP o app externa

El módulo expone un **endpoint webhook** (`apiEmitir`). Tu ERP le pega un POST con tu token de API y los datos del comprobante, y recibe el CAE + el PDF. Así emitís desde tu sistema sin entrar a la app.

Ejemplo de request:

```bash
curl -X POST "https://<TU-APP>.base44.app/functions/apiEmitir" \
  -H "Authorization: Bearer <TU_API_TOKEN>" \
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

---

## Errores frecuentes y qué significan

| Mensaje de ARCA | Qué pasó | Solución |
|---|---|---|
| Método no certificado para la CUIT | El certificado no está asociado al servicio wsfe, o no adheriste WSFE | Asociar cert al servicio y adherir WSFE en Adm. de Relaciones |
| Punto de venta no existe / no habilitado | El PV no es tipo WSFEV1 o está inactivo | Dar de alta un PV tipo WSFEV1 |
| CbteNro no correlativo | Salteaste numeración | El módulo consulta el último autorizado automáticamente; reintentá |
| Fecha fuera de rango | Facturaste con fecha vieja | Máximo 10 días hacia atrás en Productos; no se factura a futuro |
| Token/sign inválido | El token de sesión venció o el reloj está desfasado | El módulo re-loguea solo; si persiste, revisá la hora del servidor |
| Factura A a Consumidor Final | Tipo de comprobante incorrecto | A un CF le corresponde Factura B (si sos RI) o C (si sos Mono) |

---

## Preguntas rápidas

**¿Es gratis?** Sí. Los web services de ARCA (WSAA + WSFEv1) no tienen costo ni licencia. Solo necesitás el certificado digital, que también es gratuito.

**¿Puedo emitir para varias empresas?** Sí. El módulo es multi-tenant: cada CUIT es un `ArcaEmisor` independiente, con su propio certificado.

**¿Y si soy monotributista?** Igual de simple: siempre emitís Factura C, sin discriminar IVA. El módulo lo maneja automáticamente.
