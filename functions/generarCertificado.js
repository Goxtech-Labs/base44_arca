// generarCertificado.js
// -----------------------------------------------------------------------------
// Genera el par RSA 2048 + CSR (PKCS#10) para el emisor, encripta la clave
// privada (AES-GCM) y la guarda en ArcaEmisor.clavePrivadaEnc. Devuelve el CSR
// en PEM para que el usuario lo descargue y lo suba a ARCA.
//
// NO genera el certificado final: ese lo emite ARCA (WSASS en homo / Adm. de
// Certificados en prod) a partir del CSR.
// -----------------------------------------------------------------------------

import { createClientFromRequest } from "npm:@base44/sdk";
import { generarParYCsr, encriptarClave, limpiarCuit } from "./arcaCore.js";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const admin = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));

    // Aceptamos emisorId, o cuit+razonSocial (crea el emisor si no existe).
    let emisor;
    if (body.emisorId) {
      emisor = await admin.entities.ArcaEmisor.get(body.emisorId);
      if (!emisor) return Response.json({ error: "Emisor no encontrado." }, { status: 404 });
    } else if (body.cuit && body.razonSocial) {
      emisor = { cuit: limpiarCuit(body.cuit), razonSocial: body.razonSocial };
    } else {
      return Response.json({ error: "Pasá emisorId, o cuit + razonSocial." }, { status: 400 });
    }

    const masterKey = Deno.env.get("ARCA_MASTER_KEY");
    if (!masterKey) return Response.json({ error: "Falta el secret ARCA_MASTER_KEY." }, { status: 500 });

    // 1. Par RSA + CSR.
    const alias = body.alias || `base44-${limpiarCuit(emisor.cuit)}`;
    const { csrPem, privateKeyPem } = generarParYCsr({
      razonSocial: emisor.razonSocial,
      cuit: emisor.cuit,
      alias,
    });

    // 2. Encriptar la clave privada. Nunca sale de acá en texto plano.
    const clavePrivadaEnc = await encriptarClave(privateKeyPem, masterKey, emisor.cuit);

    // 3. Persistir. Estado -> PENDIENTE_CERT (falta subir el .crt de ARCA).
    if (body.emisorId) {
      await admin.entities.ArcaEmisor.update(body.emisorId, {
        clavePrivadaEnc,
        estado: "PENDIENTE_CERT",
      });
    } else {
      emisor = await admin.entities.ArcaEmisor.create({
        cuit: limpiarCuit(emisor.cuit),
        razonSocial: emisor.razonSocial,
        condicionIva: body.condicionIva || "RI",
        puntoVenta: body.puntoVenta || 1,
        ambiente: body.ambiente || "HOMOLOGACION",
        clavePrivadaEnc,
        estado: "PENDIENTE_CERT",
      });
    }

    // 4. Devolver el CSR para descargar. La .key jamás se devuelve.
    return Response.json({
      ok: true,
      emisorId: emisor.id || body.emisorId,
      alias,
      csrPem,
      instrucciones:
        "Descargá este CSR y subilo a ARCA (WSASS en homologación / Administrador de Certificados en producción). " +
        "Bajá el .crt, asocialo al servicio wsfe y cargalo con 'cargarCertificado'.",
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
