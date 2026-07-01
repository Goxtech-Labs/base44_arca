// generarPdf.js
// -----------------------------------------------------------------------------
// Genera el PDF legal del comprobante con jsPDF + el QR obligatorio (RG 4892),
// lo sube al storage de Base44 y devuelve la URL pública.
//
// Exporta generarPdfComprobante() para que emitirFactura lo use inline.
// -----------------------------------------------------------------------------

import { createClientFromRequest } from "npm:@base44/sdk";
import { jsPDF } from "npm:jspdf";
import QRCode from "npm:qrcode";
import { CBTE_TIPO, IVA_ALICUOTA, COND_IVA_RECEPTOR, construirQr } from "./arcaCore.js";

const NOMBRE_CBTE = {
  1: "FACTURA A", 6: "FACTURA B", 11: "FACTURA C", 51: "FACTURA M",
  2: "NOTA DE DÉBITO A", 7: "NOTA DE DÉBITO B", 12: "NOTA DE DÉBITO C",
  3: "NOTA DE CRÉDITO A", 8: "NOTA DE CRÉDITO B", 13: "NOTA DE CRÉDITO C",
};

const LETRA_CBTE = { 1: "A", 2: "A", 3: "A", 6: "B", 7: "B", 8: "B", 11: "C", 12: "C", 13: "C", 51: "M" };

const NOMBRE_COND_RECEPTOR = Object.fromEntries(
  Object.entries(COND_IVA_RECEPTOR).map(([k, v]) => [v, k.replaceAll("_", " ")]),
);

function fmtMoneda(n) {
  return new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n || 0));
}

function fmtCuit(cuit) {
  const s = String(cuit || "").replace(/\D/g, "");
  return s.length === 11 ? `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}` : s;
}

/**
 * Dibuja y sube el PDF. `qr` opcional: si no viene, se reconstruye desde el
 * comprobante persistido (para regenerar PDFs).
 * @returns URL del PDF, o null si no se pudo subir.
 */
export async function generarPdfComprobante(base44, emisor, cbte, qr) {
  // Reconstruir el QR si hace falta.
  if (!qr) {
    qr = construirQr({
      cuit: emisor.cuit,
      ptoVta: cbte.puntoVenta,
      tipoCmp: cbte.tipoCbte,
      nroCmp: cbte.nroCbte,
      importe: cbte.impTotal,
      moneda: cbte.moneda,
      ctz: cbte.cotizacion,
      tipoDocRec: cbte.docTipoReceptor,
      nroDocRec: cbte.docNroReceptor,
      cae: cbte.cae,
      fecha: cbte.fechaCbte,
    });
  }

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const letra = LETRA_CBTE[cbte.tipoCbte] || "";
  const nombre = NOMBRE_CBTE[cbte.tipoCbte] || `COMPROBANTE ${cbte.tipoCbte}`;

  // --- Encabezado con recuadro de la letra ---
  doc.setDrawColor(0);
  doc.rect(10, 10, W - 20, 28);
  doc.line(W / 2, 10, W / 2, 38);
  // Cuadrito de la letra al centro.
  doc.rect(W / 2 - 8, 8, 16, 14);
  doc.setFontSize(22).setFont("helvetica", "bold");
  doc.text(letra, W / 2, 18, { align: "center" });
  doc.setFontSize(7).setFont("helvetica", "normal");
  doc.text(`COD. ${String(cbte.tipoCbte).padStart(3, "0")}`, W / 2, 21.5, { align: "center" });

  // Emisor (izquierda).
  doc.setFontSize(13).setFont("helvetica", "bold");
  doc.text(String(emisor.razonSocial || ""), 14, 18);
  doc.setFontSize(9).setFont("helvetica", "normal");
  doc.text(`CUIT: ${fmtCuit(emisor.cuit)}`, 14, 24);
  doc.text(`Condición IVA: ${emisor.condicionIva}`, 14, 29);
  doc.text(emisor.ambiente === "HOMOLOGACION" ? "*** HOMOLOGACIÓN - SIN VALIDEZ FISCAL ***" : "", 14, 34);

  // Comprobante (derecha).
  doc.setFontSize(13).setFont("helvetica", "bold");
  doc.text(nombre, W - 14, 18, { align: "right" });
  doc.setFontSize(9).setFont("helvetica", "normal");
  doc.text(`Punto de Venta: ${String(cbte.puntoVenta).padStart(5, "0")}`, W - 14, 24, { align: "right" });
  doc.text(`Comp. Nro: ${String(cbte.nroCbte || "").padStart(8, "0")}`, W - 14, 29, { align: "right" });
  doc.text(`Fecha: ${cbte.fechaCbte}`, W - 14, 34, { align: "right" });

  // --- Datos del receptor ---
  let y = 46;
  doc.rect(10, y, W - 20, 16);
  doc.setFontSize(9);
  const docTipoNombre = { 80: "CUIT", 86: "CUIL", 96: "DNI", 99: "Consumidor Final" }[cbte.docTipoReceptor] || "Doc";
  doc.text(`${docTipoNombre}: ${cbte.docNroReceptor || "-"}`, 14, y + 6);
  doc.text(`Condición IVA receptor: ${NOMBRE_COND_RECEPTOR[cbte.condicionIvaReceptorId] || cbte.condicionIvaReceptorId}`, 14, y + 11);
  const conceptoTxt = { 1: "Productos", 2: "Servicios", 3: "Productos y Servicios" }[cbte.concepto] || "";
  doc.text(`Concepto: ${conceptoTxt}`, W - 14, y + 6, { align: "right" });

  // --- Discriminación de importes ---
  y += 24;
  doc.setFont("helvetica", "bold").text("Detalle de importes", 14, y);
  doc.setFont("helvetica", "normal");
  y += 6;

  const filas = [];
  if (cbte.tipoCbte === CBTE_TIPO.FACTURA_C) {
    filas.push(["Importe total (no discrimina IVA)", fmtMoneda(cbte.impTotal)]);
  } else {
    filas.push(["Importe Neto Gravado", fmtMoneda(cbte.impNeto)]);
    for (const a of cbte.alicuotasIva || []) {
      filas.push([`IVA ${IVA_ALICUOTA[a.id] ?? "?"}% (base ${fmtMoneda(a.baseImp)})`, fmtMoneda(a.importe)]);
    }
    if (cbte.impTotConc) filas.push(["Importe No Gravado", fmtMoneda(cbte.impTotConc)]);
    if (cbte.impOpEx) filas.push(["Importe Exento", fmtMoneda(cbte.impOpEx)]);
    if (cbte.impTrib) filas.push(["Otros Tributos", fmtMoneda(cbte.impTrib)]);
  }
  for (const [label, val] of filas) {
    doc.text(label, 14, y);
    doc.text(`$ ${val}`, W - 14, y, { align: "right" });
    y += 6;
  }
  doc.setFont("helvetica", "bold").setFontSize(11);
  doc.text("TOTAL", 14, y + 2);
  doc.text(`$ ${fmtMoneda(cbte.impTotal)}`, W - 14, y + 2, { align: "right" });
  doc.setFont("helvetica", "normal").setFontSize(9);

  // --- QR + CAE ---
  y += 16;
  const qrDataUrl = await QRCode.toDataURL(qr.url, { margin: 1, width: 220 });
  doc.addImage(qrDataUrl, "PNG", 14, y, 32, 32);
  doc.setFontSize(10).setFont("helvetica", "bold");
  doc.text(`CAE N°: ${cbte.cae || "-"}`, 52, y + 8);
  doc.text(`Vencimiento CAE: ${cbte.caeVencimiento || "-"}`, 52, y + 15);
  doc.setFont("helvetica", "normal").setFontSize(8);
  doc.text("Comprobante autorizado por ARCA (ex-AFIP).", 52, y + 22);

  // --- Salida y subida al storage de Base44 ---
  const arrayBuffer = doc.output("arraybuffer");
  const blob = new Blob([arrayBuffer], { type: "application/pdf" });
  const nombreArchivo = `cbte-${cbte.puntoVenta}-${cbte.nroCbte}-${Date.now()}.pdf`;

  try {
    const file = new File([blob], nombreArchivo, { type: "application/pdf" });
    // API de subida de Base44 (Core Integrations). Ajustar si tu versión difiere.
    const up = await base44.integrations.Core.UploadFile({ file });
    return up?.file_url || up?.url || null;
  } catch (_e) {
    // Si el storage no está disponible, devolvemos null: el comprobante sigue válido.
    return null;
  }
}

// --- Wrapper HTTP (regenerar PDF de un comprobante existente) ----------------
if (!Deno.env.get("ARCA_NO_SERVE")) Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { comprobanteId } = await req.json().catch(() => ({}));
    if (!comprobanteId) return Response.json({ error: "Falta comprobanteId." }, { status: 400 });

    const admin = base44.asServiceRole;
    const cbte = await admin.entities.ArcaComprobante.get(comprobanteId);
    if (!cbte) return Response.json({ error: "Comprobante no encontrado." }, { status: 404 });
    if (!cbte.cae) return Response.json({ error: "El comprobante no tiene CAE (no aprobado)." }, { status: 400 });

    const emisor = await admin.entities.ArcaEmisor.get(cbte.emisorId);
    const pdfUrl = await generarPdfComprobante(base44, emisor, cbte);
    if (pdfUrl) await admin.entities.ArcaComprobante.update(comprobanteId, { pdfUrl });

    return Response.json({ ok: !!pdfUrl, pdfUrl });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
