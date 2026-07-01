# dev/ — Desarrollo y pruebas locales (sin deploy a Base44)

Todo lo de esta carpeta es **para probar el módulo localmente con Deno**. No se
deploya a Base44. Base44 corre Deno, así que los tests ejercitan los mismos
archivos de `functions/` tal cual.

## Requisitos

- [Deno](https://deno.com) 2.x. En Windows: `winget install DenoLand.Deno`.

## Capas de prueba

| Capa | Archivo | Necesita |
|---|---|---|
| 1 · Lógica pura | `tests/crypto_test.js`, `tests/validar_test.js`, `tests/soap_qr_test.js` | nada (offline) |
| 2 · End-to-end mockeado | `tests/e2e_test.js` | nada (offline) |
| 3 · ARCA real homologación | `integracion_homologacion.js` | certificado de homologación |

`mockBase44.js` = cliente Base44 falso (entidades en memoria + storage falso).
`mockArca.js` = intercepta `fetch` con respuestas SOAP de ejemplo + genera un
certificado autofirmado para los tests.

## Correr los tests (capas 1 y 2)

```bash
# El guard ARCA_NO_SERVE evita que las functions levanten el server al importarlas.
ARCA_NO_SERVE=1 ARCA_MASTER_KEY=cualquier-cosa-larga deno test -A dev/tests/
```

o con la task:

```bash
ARCA_NO_SERVE=1 ARCA_MASTER_KEY=cualquier-cosa-larga deno task test
```

## Integración real contra homologación (capa 3)

Necesitás clave fiscal ARCA y acceso a WSASS. El script te guía por pasos:

```bash
export ARCA_MASTER_KEY=una-clave-larga
export ARCA_TEST_CUIT=20111111112
export ARCA_TEST_PV=1
export ARCA_TEST_COND=RI          # o MONOTRIBUTO

deno run -A dev/integracion_homologacion.js
```

1. **1ª corrida** → genera `dev/.homologacion/key.pem` + `solicitud.csr`. Subí el
   CSR a **WSASS**, generá el certificado de testing, asocialo al servicio
   `wsfe`, descargalo y guardalo como `dev/.homologacion/cert.crt`.
2. **2ª corrida** → loguea en WSAA y emite un comprobante de prueba. Imprime el
   **CAE** o el error traducido de ARCA.

> `dev/.homologacion/` está en `.gitignore`: la clave privada y el certificado
> **nunca** se commitean.
