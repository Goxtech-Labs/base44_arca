// apiEmitir.js
// -----------------------------------------------------------------------------
// Endpoint webhook para que un ERP/app externa emita comprobantes.
// Autentica con el apiToken del emisor (header Authorization: Bearer <token>),
// mapea el payload al formato interno y reutiliza la lógica de emitirFactura.
//
// Ejemplo:
//   curl -X POST https://<APP>.base44.app/functions/apiEmitir \
//     -H "Authorization: Bearer <API_TOKEN>" \
//     -H "Content-Type: application/json" \
//     -d '{ "emisorId": "...", "tipoCbte": 6, ... }'
// -----------------------------------------------------------------------------

import { createClientFromRequest } from "npm:@base44/sdk";
import { emitir } from "./emitirFactura.js";

/** Comparación de tokens en tiempo (casi) constante para no filtrar longitud. */
function tokensIguales(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return Response.json({ error: "Usá POST." }, { status: 405 });

    const admin = createClientFromRequest(req).asServiceRole;
    const body = await req.json().catch(() => ({}));

    // 1. Autenticación por token del tenant.
    const authHeader = req.headers.get("authorization") || "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    const tokenRecibido = bearer || body.apiToken;
    if (!tokenRecibido) return Response.json({ error: "Falta el token de API (Authorization: Bearer)." }, { status: 401 });
    if (!body.emisorId) return Response.json({ error: "Falta emisorId." }, { status: 400 });

    const emisor = await admin.entities.ArcaEmisor.get(body.emisorId);
    if (!emisor) return Response.json({ error: "Emisor no encontrado." }, { status: 404 });
    if (!emisor.apiToken || !tokensIguales(tokenRecibido, emisor.apiToken)) {
      return Response.json({ error: "Token de API inválido para este emisor." }, { status: 403 });
    }

    // 2. Mapeo del payload externo -> formato interno.
    // Aceptamos tanto los nombres internos como algunos alias comunes de ERPs.
    const cbte = {
      tipoCbte: body.tipoCbte ?? body.cbteTipo,
      puntoVenta: body.puntoVenta ?? body.ptoVta ?? emisor.puntoVenta,
      concepto: body.concepto ?? 1,
      docTipoReceptor: body.docTipoReceptor ?? body.docTipo ?? 99,
      docNroReceptor: body.docNroReceptor ?? body.docNro ?? "0",
      condicionIvaReceptorId: body.condicionIvaReceptorId ?? body.condIvaReceptor,
      impNeto: body.impNeto ?? 0,
      impIva: body.impIva ?? 0,
      impTrib: body.impTrib ?? 0,
      impTotConc: body.impTotConc ?? 0,
      impOpEx: body.impOpEx ?? 0,
      impTotal: body.impTotal,
      alicuotasIva: body.alicuotasIva ?? body.iva ?? [],
      moneda: body.moneda ?? "PES",
      cotizacion: body.cotizacion ?? 1,
      fechaCbte: body.fechaCbte ?? new Date().toISOString().slice(0, 10),
      fchServDesde: body.fchServDesde,
      fchServHasta: body.fchServHasta,
      fchVtoPago: body.fchVtoPago,
    };

    // 3. Reutilizar la lógica de emisión.
    const r = await emitir(createClientFromRequest(req), emisor, cbte);

    if (!r.ok) {
      return Response.json(
        { ok: false, estado: r.estado, etapa: r.etapa, errores: r.errores || r.observaciones },
        { status: 422 },
      );
    }
    return Response.json({
      ok: true,
      estado: r.estado,
      cae: r.comprobante.cae,
      caeVencimiento: r.comprobante.caeVencimiento,
      nroCbte: r.comprobante.nroCbte,
      pdfUrl: r.comprobante.pdfUrl || null,
      comprobanteId: r.comprobante.id,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
