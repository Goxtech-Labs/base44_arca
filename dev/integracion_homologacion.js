// dev/integracion_homologacion.js
// -----------------------------------------------------------------------------
// Prueba de integración REAL contra ARCA homologación (WSAA + WSFEv1).
// DB mockeada (en memoria), pero fetch REAL: pega a los servidores de testing.
//
// Uso:
//   deno run -A dev/integracion_homologacion.js
//
// Flujo por pasos (el script te guía):
//   1) Sin clave  -> genera key.pem + solicitud.csr en dev/.homologacion/ y te
//      dice cómo subir el CSR a WSASS.
//   2) Con clave y sin cert -> te pide pegar el .crt como dev/.homologacion/cert.crt.
//   3) Con ambos -> loguea en WSAA y emite un comprobante de prueba; imprime CAE.
//
// Variables de entorno:
//   ARCA_MASTER_KEY   (obligatoria) clave para encriptar la privada.
//   ARCA_TEST_CUIT    CUIT del emisor de homologación.
//   ARCA_TEST_PV      punto de venta WSFEV1 (default 1).
//   ARCA_TEST_COND    RI | MONOTRIBUTO (default RI).
// -----------------------------------------------------------------------------

import { generarParYCsr, encriptarClave } from "../functions/arcaCore.js";
import { createMockBase44 } from "./mockBase44.js";
import { emitir } from "../functions/emitirFactura.js";

const DIR = new URL("./.homologacion/", import.meta.url);
const p = (name) => new URL(name, DIR).pathname;

async function existe(path) {
  try { await Deno.stat(path); return true; } catch { return false; }
}

async function main() {
  const master = Deno.env.get("ARCA_MASTER_KEY");
  if (!master) { console.error("✗ Falta ARCA_MASTER_KEY en el entorno."); Deno.exit(1); }

  const cuit = Deno.env.get("ARCA_TEST_CUIT") || "20111111112";
  const pv = Number(Deno.env.get("ARCA_TEST_PV") || 1);
  const cond = Deno.env.get("ARCA_TEST_COND") || "RI";

  await Deno.mkdir(DIR, { recursive: true });
  const keyPath = p("key.pem");
  const csrPath = p("solicitud.csr");
  const crtPath = p("cert.crt");

  // Paso 1: generar clave + CSR si no existen.
  if (!(await existe(keyPath))) {
    const { csrPem, privateKeyPem } = generarParYCsr({ razonSocial: "Prueba Homologacion", cuit, alias: `homo-${cuit}` });
    await Deno.writeTextFile(keyPath, privateKeyPem);
    await Deno.writeTextFile(csrPath, csrPem);
    console.log("① Generé la clave y el CSR en dev/.homologacion/");
    console.log(`   - Clave privada: ${keyPath} (NO la compartas)`);
    console.log(`   - CSR:           ${csrPath}`);
    console.log("\nSubí el CSR a WSASS (Autoservicio de Homologación), generá el");
    console.log("certificado de testing, asocialo al servicio 'wsfe', descargalo y");
    console.log(`guardalo como: ${crtPath}\nDespués volvé a correr este script.`);
    return;
  }

  // Paso 2: falta el certificado.
  if (!(await existe(crtPath))) {
    console.log("② Ya tenés la clave. Falta el certificado.");
    console.log(`Pegá el .crt de WSASS en: ${crtPath}\nDespués volvé a correr este script.`);
    return;
  }

  // Paso 3: emisión real.
  console.log("③ Clave + certificado presentes. Probando emisión real en homologación…\n");
  const keyPem = await Deno.readTextFile(keyPath);
  const crtPem = await Deno.readTextFile(crtPath);
  const clavePrivadaEnc = await encriptarClave(keyPem, master, cuit);

  const base44 = createMockBase44();
  const emisor = await base44.asServiceRole.entities.ArcaEmisor.create({
    cuit, razonSocial: "Prueba Homologacion", condicionIva: cond, puntoVenta: pv,
    ambiente: "HOMOLOGACION", certificadoCrt: crtPem, clavePrivadaEnc, estado: "ACTIVO",
  });

  const esC = cond === "MONOTRIBUTO";
  const hoy = new Date().toISOString().slice(0, 10);
  const cbte = esC
    ? { concepto: 1, docTipoReceptor: 99, docNroReceptor: "0", condicionIvaReceptorId: 5,
        impNeto: 100, impIva: 0, impTotal: 100, alicuotasIva: [], fechaCbte: hoy }
    : { concepto: 1, docTipoReceptor: 99, docNroReceptor: "0", condicionIvaReceptorId: 5,
        impNeto: 100, impIva: 21, impTotal: 121,
        alicuotasIva: [{ id: 5, baseImp: 100, importe: 21 }], fechaCbte: hoy };

  try {
    const r = await emitir(base44, emisor, cbte);
    if (r.ok) {
      console.log("✓ EMITIDO");
      console.log(`  Estado:  ${r.estado}`);
      console.log(`  Nº:      ${String(pv).padStart(4, "0")}-${String(r.comprobante.nroCbte).padStart(8, "0")}`);
      console.log(`  CAE:     ${r.comprobante.cae}`);
      console.log(`  Vto CAE: ${r.comprobante.caeVencimiento}`);
      if (r.comprobante.pdfUrl) console.log(`  PDF:     ${r.comprobante.pdfUrl}`);
    } else {
      console.log(`✗ No se emitió (${r.estado || r.etapa}):`);
      console.log(JSON.stringify(r.errores || r.observaciones, null, 2));
    }
  } catch (e) {
    console.error(`✗ Error: ${e.message}`);
    console.error("  Revisá que el cert esté adherido a 'wsfe' y el PV sea tipo WSFEV1 activo.");
  }
}

await main();
