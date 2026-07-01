// emitirFactura.js
// -----------------------------------------------------------------------------
// Orquesta la emisión completa:
//   validar (local) -> wsaaLogin -> FECompUltimoAutorizado -> FECAESolicitar
//   -> persistir ArcaComprobante -> generarPdf (si aprobó).
//
// Exporta emitir() para reutilizar desde el webhook apiEmitir.
// -----------------------------------------------------------------------------

import { createClientFromRequest } from "npm:@base44/sdk";
import {
  endpointsPara,
  postSoap,
  buscarProfundo,
  soapUltimoAutorizado,
  soapFECAESolicitar,
  soapActionFEV1,
  traducirErrorArca,
  fechaDesdeAfip,
  construirQr,
  round2,
} from "./arcaCore.js";
import { obtenerCredenciales } from "./wsaaLogin.js";
import { validar } from "./validarComprobante.js";
import { generarPdfComprobante } from "./generarPdf.js";
import { verificarLicencia, MODULE_VERSION } from "./licencia.js";

/** Normaliza un nodo que puede venir como objeto único o array. */
function comoArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/** Extrae [{code,msg}] de un nodo Errors/Observaciones de ARCA. */
function extraerMensajes(nodo, tagItem) {
  const items = comoArray(buscarProfundo(nodo, tagItem));
  return items
    .map((o) => ({ code: o?.Code ?? o?.code ?? "", msg: o?.Msg ?? o?.msg ?? "" }))
    .filter((o) => o.code || o.msg);
}

/**
 * Emite un comprobante. Devuelve el registro ArcaComprobante creado.
 * @param base44  cliente Base44.
 * @param emisor  registro ArcaEmisor.
 * @param cbte    payload del comprobante.
 */
export async function emitir(base44, emisor, cbte) {
  const admin = base44.asServiceRole;

  // 1. Validación local. Si falla, cortamos SIN tocar ARCA.
  const val = validar(emisor, cbte);
  if (!val.valido) {
    return { ok: false, etapa: "validacion", errores: val.errores };
  }
  const tipoCbte = val.tipoCbte || Number(cbte.tipoCbte);
  const ptoVta = Number(cbte.puntoVenta || emisor.puntoVenta);

  // Licencia GoxTech (no bloqueante): trackea el CUIT y su versión. La emisión
  // es gratis en cualquier plan; esto solo registra uso. Cache-first (7 días).
  const licencia = await verificarLicencia(base44, emisor.cuit, { version: MODULE_VERSION }).catch(() => null);

  // 2. Credenciales WSAA (reusa cache).
  const cred = await obtenerCredenciales(base44, emisor);
  const auth = { token: cred.token, sign: cred.sign, cuit: emisor.cuit };
  const { wsfe } = endpointsPara(emisor.ambiente);

  // 3. Número siguiente (FECompUltimoAutorizado). Nunca lo adivinamos.
  const ultimoRes = await postSoap(
    wsfe,
    soapUltimoAutorizado(auth, ptoVta, tipoCbte),
    soapActionFEV1("FECompUltimoAutorizado"),
  );
  const ultimoResult = buscarProfundo(ultimoRes.parsed, "FECompUltimoAutorizadoResult");
  const errUltimo = extraerMensajes(ultimoResult, "Err");
  if (errUltimo.length) {
    return { ok: false, etapa: "ultimoAutorizado", errores: traducirErrorArca(errUltimo) };
  }
  const ultimoNro = Number(buscarProfundo(ultimoResult, "CbteNro") || 0);
  const nroCbte = ultimoNro + 1;

  // 4. Solicitar CAE (FECAESolicitar).
  const det = { ...cbte, cbteNro: nroCbte };
  const caeRes = await postSoap(
    wsfe,
    soapFECAESolicitar(auth, ptoVta, tipoCbte, det),
    soapActionFEV1("FECAESolicitar"),
  );
  const result = buscarProfundo(caeRes.parsed, "FECAESolicitarResult");

  const erroresTop = extraerMensajes(result, "Err");
  const detResp = buscarProfundo(result, "FECAEDetResponse");
  const resultadoCab = buscarProfundo(buscarProfundo(result, "FeCabResp") || {}, "Resultado");
  const resultadoDet = buscarProfundo(detResp || {}, "Resultado");
  const resultado = resultadoDet || resultadoCab; // A=aprobado, R=rechazado, O=observado

  const cae = buscarProfundo(detResp || {}, "CAE");
  const caeVto = buscarProfundo(detResp || {}, "CAEFchVto");
  const observaciones = [
    ...extraerMensajes(detResp, "Obs"),
    ...erroresTop,
  ];

  const estado = resultado === "A" ? "APROBADO" : resultado === "O" ? "OBSERVADO" : "RECHAZADO";

  // 5. Persistir el comprobante (aprobado, observado o rechazado — todo queda registrado).
  const registro = {
    emisorId: emisor.id,
    tipoCbte,
    puntoVenta: ptoVta,
    nroCbte: estado === "RECHAZADO" ? null : nroCbte,
    concepto: Number(cbte.concepto),
    docTipoReceptor: Number(cbte.docTipoReceptor),
    docNroReceptor: String(cbte.docNroReceptor || ""),
    condicionIvaReceptorId: Number(cbte.condicionIvaReceptorId),
    impNeto: round2(cbte.impNeto || 0),
    impIva: round2(cbte.impIva || 0),
    impTrib: round2(cbte.impTrib || 0),
    impTotConc: round2(cbte.impTotConc || 0),
    impOpEx: round2(cbte.impOpEx || 0),
    impTotal: round2(cbte.impTotal || 0),
    alicuotasIva: cbte.alicuotasIva || [],
    moneda: cbte.moneda || "PES",
    cotizacion: Number(cbte.cotizacion) || 1,
    fechaCbte: cbte.fechaCbte,
    fchServDesde: cbte.fchServDesde || null,
    fchServHasta: cbte.fchServHasta || null,
    fchVtoPago: cbte.fchVtoPago || null,
    cae: cae || null,
    caeVencimiento: caeVto ? fechaDesdeAfip(caeVto) : null,
    estado,
    observaciones,
  };

  // QR + PDF solo si aprobó (u observado con CAE).
  if (cae) {
    const qr = construirQr({
      cuit: emisor.cuit,
      ptoVta,
      tipoCmp: tipoCbte,
      nroCmp: nroCbte,
      importe: cbte.impTotal,
      moneda: cbte.moneda || "PES",
      ctz: cbte.cotizacion || 1,
      tipoDocRec: cbte.docTipoReceptor,
      nroDocRec: cbte.docNroReceptor,
      cae,
      fecha: cbte.fechaCbte,
    });
    registro.qrPayload = qr.b64;

    const comprobante = await admin.entities.ArcaComprobante.create(registro);
    try {
      const pdfUrl = await generarPdfComprobante(base44, emisor, comprobante, qr);
      if (pdfUrl) {
        await admin.entities.ArcaComprobante.update(comprobante.id, { pdfUrl });
        comprobante.pdfUrl = pdfUrl;
      }
    } catch (e) {
      // El comprobante ya es válido aunque el PDF falle; se puede regenerar.
      comprobante.pdfError = e.message;
    }
    return { ok: estado !== "RECHAZADO", estado, comprobante, licencia, observaciones: traducirErrorArca(observaciones) };
  }

  // Rechazado: guardamos igual para trazabilidad.
  const comprobante = await admin.entities.ArcaComprobante.create(registro);
  return { ok: false, estado, comprobante, licencia, errores: traducirErrorArca(observaciones) };
}

// --- Wrapper HTTP ------------------------------------------------------------
if (!Deno.env.get("ARCA_NO_SERVE")) Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { emisorId, ...cbte } = body;
    if (!emisorId) return Response.json({ error: "Falta emisorId." }, { status: 400 });

    const emisor = await base44.asServiceRole.entities.ArcaEmisor.get(emisorId);
    if (!emisor) return Response.json({ error: "Emisor no encontrado." }, { status: 404 });

    const r = await emitir(base44, emisor, cbte);
    return Response.json(r, { status: r.ok ? 200 : 422 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
