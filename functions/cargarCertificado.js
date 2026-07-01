// cargarCertificado.js
// -----------------------------------------------------------------------------
// Recibe el .crt (PEM) que ARCA emitió a partir del CSR, valida que el CUIT del
// certificado coincida con el del emisor, lo guarda y pasa el emisor a ACTIVO.
// -----------------------------------------------------------------------------

import { createClientFromRequest } from "npm:@base44/sdk";
import { leerDatosCertificado, limpiarCuit } from "./arcaCore.js";

/** Normaliza el .crt a PEM (acepta PEM directo o base64 del PEM). */
function normalizarCrt(crt) {
  const s = String(crt || "").trim();
  if (s.includes("BEGIN CERTIFICATE")) return s;
  try {
    const dec = atob(s);
    if (dec.includes("BEGIN CERTIFICATE")) return dec;
  } catch { /* no era base64 */ }
  throw new Error("El .crt no parece un PEM válido (falta 'BEGIN CERTIFICATE').");
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const admin = base44.asServiceRole;
    const { emisorId, crt } = await req.json().catch(() => ({}));

    if (!emisorId || !crt) return Response.json({ error: "Pasá emisorId y crt." }, { status: 400 });

    const emisor = await admin.entities.ArcaEmisor.get(emisorId);
    if (!emisor) return Response.json({ error: "Emisor no encontrado." }, { status: 404 });
    if (!emisor.clavePrivadaEnc)
      return Response.json({ error: "Este emisor no tiene clave generada. Corré 'generarCertificado' primero." }, { status: 400 });

    const crtPem = normalizarCrt(crt);
    const datos = leerDatosCertificado(crtPem);

    // Validar que el CUIT del certificado sea el del emisor.
    if (datos.cuit && limpiarCuit(datos.cuit) !== limpiarCuit(emisor.cuit)) {
      return Response.json(
        { error: `El certificado es del CUIT ${datos.cuit}, pero el emisor es ${emisor.cuit}. No coinciden.` },
        { status: 400 },
      );
    }
    // Avisar si está vencido.
    if (datos.notAfter && new Date(datos.notAfter).getTime() < Date.now()) {
      return Response.json({ error: `El certificado venció el ${datos.notAfter}. Regenerá uno nuevo.` }, { status: 400 });
    }

    await admin.entities.ArcaEmisor.update(emisorId, {
      certificadoCrt: crtPem,
      estado: "ACTIVO",
    });

    return Response.json({
      ok: true,
      emisorId,
      estado: "ACTIVO",
      cn: datos.cn,
      cuit: datos.cuit,
      vigenciaHasta: datos.notAfter,
      mensaje: "Certificado cargado. El emisor quedó ACTIVO y listo para emitir.",
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
