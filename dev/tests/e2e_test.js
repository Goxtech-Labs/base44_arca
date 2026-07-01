// dev/tests/e2e_test.js — Capa 2: emisión completa con Base44 + ARCA mockeados.
import { assert, assertEquals } from "jsr:@std/assert";
import { createMockBase44 } from "../mockBase44.js";
import { installMockFetch, certAutofirmadoParaTest, respuestaCAE } from "../mockArca.js";
import { encriptarClave } from "../../functions/arcaCore.js";
import { emitir } from "../../functions/emitirFactura.js";
import { obtenerCredenciales } from "../../functions/wsaaLogin.js";

// Debe coincidir con el env ARCA_MASTER_KEY que usa obtenerCredenciales para
// desencriptar la clave (lo setea el runner de tests).
const MASTER = Deno.env.get("ARCA_MASTER_KEY") || "master-key-de-prueba-para-e2e-1234567890";
const CUIT = "20111111112";

async function armarEmisorActivo(base44, { condicionIva = "RI" } = {}) {
  const { crtPem, keyPem } = certAutofirmadoParaTest({ cuit: CUIT, razonSocial: "Acme SA" });
  const clavePrivadaEnc = await encriptarClave(keyPem, MASTER, CUIT);
  return base44.asServiceRole.entities.ArcaEmisor.create({
    cuit: CUIT, razonSocial: "Acme SA", condicionIva, puntoVenta: 1,
    ambiente: "HOMOLOGACION", certificadoCrt: crtPem, clavePrivadaEnc, estado: "ACTIVO",
  });
}

function facturaB() {
  return {
    concepto: 1, docTipoReceptor: 96, docNroReceptor: "12345678",
    condicionIvaReceptorId: 5, impNeto: 10000, impIva: 2100, impTotal: 12100,
    alicuotasIva: [{ id: 5, baseImp: 10000, importe: 2100 }],
    moneda: "PES", cotizacion: 1, fechaCbte: new Date().toISOString().slice(0, 10),
  };
}

Deno.test("wsaaLogin: obtiene credenciales y las cachea; el 2º llamado es cache hit", async () => {
  const base44 = createMockBase44();
  const emisor = await armarEmisorActivo(base44);
  const mock = installMockFetch();
  try {
    const c1 = await obtenerCredenciales(base44, emisor);
    assertEquals(c1.token, "TOKEN_MOCK");
    assertEquals(c1.cacheHit, false);
    const cache = await base44.asServiceRole.entities.ArcaTokenCache.filter({ cuit: CUIT, servicio: "wsfe", ambiente: "HOMOLOGACION" });
    assertEquals(cache.length, 1);

    const c2 = await obtenerCredenciales(base44, emisor);
    assertEquals(c2.cacheHit, true);
    // el WSAA se llamó una sola vez
    assertEquals(mock.calls.filter((c) => /LoginCms/.test(c.url)).length, 1);
  } finally {
    mock.restore();
  }
});

Deno.test("emitir: Factura B aprobada -> CAE, comprobante persistido y PDF", async () => {
  const base44 = createMockBase44();
  const emisor = await armarEmisorActivo(base44);
  const mock = installMockFetch();
  try {
    const r = await emitir(base44, emisor, facturaB());
    assert(r.ok, "debe aprobar");
    assertEquals(r.estado, "APROBADO");
    assertEquals(r.comprobante.cae, "74123456789012");
    assertEquals(r.comprobante.nroCbte, 43); // último 42 + 1
    assertEquals(r.comprobante.caeVencimiento, "2026-07-10");

    // persistió el comprobante
    const guardados = await base44.asServiceRole.entities.ArcaComprobante.filter({ emisorId: emisor.id });
    assertEquals(guardados.length, 1);
    // el QR quedó guardado; el PDF se subió (o registró pdfError si jsPDF no corre)
    assert(r.comprobante.qrPayload, "debe tener qrPayload");
    assert(r.comprobante.pdfUrl || r.comprobante.pdfError, "PDF subido o error registrado");
    // la licencia se adjunta (no bloquea): plan básica por defecto
    assertEquals(r.licencia?.plan, "basica");
  } finally {
    mock.restore();
  }
});

Deno.test("emitir: pide número siguiente con FECompUltimoAutorizado antes de emitir", async () => {
  const base44 = createMockBase44();
  const emisor = await armarEmisorActivo(base44);
  const mock = installMockFetch();
  try {
    await emitir(base44, emisor, facturaB());
    const pidioUltimo = mock.calls.some((c) => /FECompUltimoAutorizado/.test(c.body));
    assert(pidioUltimo, "debe consultar FECompUltimoAutorizado");
  } finally {
    mock.restore();
  }
});

Deno.test("emitir: validación local falla ANTES de tocar ARCA", async () => {
  const base44 = createMockBase44();
  const emisor = await armarEmisorActivo(base44);
  const mock = installMockFetch();
  try {
    const malo = { ...facturaB(), impTotal: 999999 }; // descuadre
    const r = await emitir(base44, emisor, malo);
    assert(!r.ok);
    assertEquals(r.etapa, "validacion");
    assertEquals(mock.calls.length, 0, "no debe haber ninguna llamada a ARCA");
  } finally {
    mock.restore();
  }
});

Deno.test("emitir: ARCA rechaza -> estado RECHAZADO y se guarda igual", async () => {
  const base44 = createMockBase44();
  const emisor = await armarEmisorActivo(base44);
  const mock = installMockFetch({
    cae: respuestaCAE({ resultado: "R", obs: [{ code: "10015", msg: "Punto de venta no habilitado" }] }),
  });
  try {
    const r = await emitir(base44, emisor, facturaB());
    assert(!r.ok);
    assertEquals(r.estado, "RECHAZADO");
    const guardados = await base44.asServiceRole.entities.ArcaComprobante.filter({ emisorId: emisor.id });
    assertEquals(guardados.length, 1);
    assertEquals(guardados[0].estado, "RECHAZADO");
  } finally {
    mock.restore();
  }
});
