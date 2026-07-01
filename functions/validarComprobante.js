// validarComprobante.js
// -----------------------------------------------------------------------------
// Reglas fiscales LOCALES, sin llamar a ARCA. Corre antes de emitir para no
// quemar numeración ni cuota de servicio. Devuelve { valido, errores, tipoCbte }.
//
// Exporta validar() para que emitirFactura lo reutilice sin HTTP.
// -----------------------------------------------------------------------------

import { createClientFromRequest } from "npm:@base44/sdk";
import {
  CBTE_TIPO,
  CONCEPTO,
  DOC_TIPO,
  IVA_ALICUOTA,
  COND_IVA_RECEPTOR,
  round2,
  limpiarCuit,
} from "./arcaCore.js";

const TOL = 0.01; // tolerancia de redondeo en importes.

/**
 * Determina el tipo de comprobante correcto según condición emisor/receptor.
 * Devuelve el CbteTipo o null si la combinación está bloqueada.
 */
export function tipoComprobanteSugerido(condicionEmisor, condIvaReceptorId) {
  if (condicionEmisor === "MONOTRIBUTO") return CBTE_TIPO.FACTURA_C; // Mono -> siempre C.
  if (condicionEmisor === "EXENTO") return CBTE_TIPO.FACTURA_C;      // Exento -> C.
  if (condicionEmisor === "RI") {
    // RI a RI -> Factura A. RI a Mono/CF/Exento -> Factura B.
    return condIvaReceptorId === COND_IVA_RECEPTOR.RESPONSABLE_INSCRIPTO
      ? CBTE_TIPO.FACTURA_A
      : CBTE_TIPO.FACTURA_B;
  }
  return null;
}

/**
 * Valida un comprobante contra las reglas locales.
 * @param emisor  registro ArcaEmisor.
 * @param cbte    payload del comprobante a emitir.
 * @returns { valido, errores: string[], tipoCbte }
 */
export function validar(emisor, cbte) {
  const errores = [];
  const esC = emisor.condicionIva === "MONOTRIBUTO" || emisor.condicionIva === "EXENTO";

  // --- 1. Tipo de comprobante coherente ---
  const sugerido = tipoComprobanteSugerido(emisor.condicionIva, Number(cbte.condicionIvaReceptorId));
  let tipoCbte = cbte.tipoCbte ? Number(cbte.tipoCbte) : sugerido;

  // Bloqueo duro: Factura A a Consumidor Final.
  if (
    tipoCbte === CBTE_TIPO.FACTURA_A &&
    (Number(cbte.condicionIvaReceptorId) === COND_IVA_RECEPTOR.CONSUMIDOR_FINAL ||
      Number(cbte.docTipoReceptor) === DOC_TIPO.CONSUMIDOR_FINAL)
  ) {
    errores.push("No se puede emitir Factura A a Consumidor Final. Corresponde Factura B (RI) o C (Monotributo).");
  }
  if (sugerido && tipoCbte && tipoCbte !== sugerido && [1, 6, 11].includes(tipoCbte)) {
    errores.push(
      `El tipo de comprobante ${tipoCbte} no coincide con el sugerido (${sugerido}) para emisor ${emisor.condicionIva} y receptor cond. IVA ${cbte.condicionIvaReceptorId}.`,
    );
  }

  // --- 2. condicionIvaReceptorId presente y coherente (RG 5616) ---
  const condRec = Number(cbte.condicionIvaReceptorId);
  if (!condRec) {
    errores.push("Falta condicionIvaReceptorId (obligatorio por RG 5616).");
  }
  const docTipo = Number(cbte.docTipoReceptor);
  if (condRec === COND_IVA_RECEPTOR.CONSUMIDOR_FINAL && docTipo === DOC_TIPO.CUIT && limpiarCuit(cbte.docNroReceptor)) {
    // CF normalmente no lleva CUIT; no bloqueamos, pero avisamos si es incoherente con monto alto.
  }
  if (docTipo === DOC_TIPO.CUIT && limpiarCuit(cbte.docNroReceptor).length !== 11) {
    errores.push("docTipoReceptor=CUIT (80) exige un CUIT de 11 dígitos en docNroReceptor.");
  }

  // --- 3. Coherencia de importes ---
  const impNeto = Number(cbte.impNeto || 0);
  const impIva = Number(cbte.impIva || 0);
  const impTrib = Number(cbte.impTrib || 0);
  const impTotConc = Number(cbte.impTotConc || 0);
  const impOpEx = Number(cbte.impOpEx || 0);
  const impTotal = Number(cbte.impTotal || 0);

  const sumado = round2(impNeto + impIva + impTrib + impTotConc + impOpEx);
  if (Math.abs(sumado - round2(impTotal)) > TOL) {
    errores.push(`impTotal (${impTotal}) != impNeto+impIva+impTrib+impTotConc+impOpEx (${sumado}).`);
  }

  // --- 4. Reglas específicas de Factura C ---
  if (esC || tipoCbte === CBTE_TIPO.FACTURA_C) {
    if (impIva !== 0) errores.push("Factura C: impIva debe ser 0 (no se discrimina IVA).");
    if (impNeto !== 0) errores.push("Factura C: impNeto debe ser 0; el total va como no gravado en impTotal.");
    if (Array.isArray(cbte.alicuotasIva) && cbte.alicuotasIva.length > 0) {
      errores.push("Factura C: no se envía array de alícuotas de IVA.");
    }
  } else {
    // --- 5. Cuadre de alícuotas IVA (A/B) ---
    const alic = Array.isArray(cbte.alicuotasIva) ? cbte.alicuotasIva : [];
    if (impIva > 0 && alic.length === 0) {
      errores.push("Hay impIva > 0 pero no se enviaron alícuotas de IVA.");
    }
    let sumaImporte = 0;
    let sumaBase = 0;
    for (const a of alic) {
      if (!(Number(a.id) in IVA_ALICUOTA)) {
        errores.push(`Alícuota IVA con Id inválido: ${a.id}. Válidos: ${Object.keys(IVA_ALICUOTA).join(", ")}.`);
        continue;
      }
      // Chequeo de que baseImp * pct ≈ importe.
      const pct = IVA_ALICUOTA[Number(a.id)];
      const esperado = round2(Number(a.baseImp) * (pct / 100));
      if (Math.abs(esperado - round2(a.importe)) > Math.max(TOL, Number(a.baseImp) * 0.001)) {
        errores.push(`Alícuota Id ${a.id} (${pct}%): importe ${a.importe} no cuadra con base ${a.baseImp} (esperado ~${esperado}).`);
      }
      sumaImporte += Number(a.importe || 0);
      sumaBase += Number(a.baseImp || 0);
    }
    if (alic.length && Math.abs(round2(sumaImporte) - round2(impIva)) > TOL) {
      errores.push(`Σ importes de alícuotas (${round2(sumaImporte)}) != impIva (${round2(impIva)}).`);
    }
    if (alic.length && Math.abs(round2(sumaBase) - round2(impNeto)) > TOL) {
      errores.push(`Σ bases de alícuotas (${round2(sumaBase)}) != impNeto (${round2(impNeto)}).`);
    }
  }

  // --- 6. Fecha ---
  const concepto = Number(cbte.concepto);
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const fecha = new Date(`${cbte.fechaCbte}T00:00:00`);
  if (isNaN(fecha.getTime())) {
    errores.push("fechaCbte inválida (formato YYYY-MM-DD).");
  } else if (concepto === CONCEPTO.PRODUCTOS) {
    const diffDias = Math.round((hoy - fecha) / (1000 * 60 * 60 * 24));
    if (diffDias > 10) errores.push("Concepto Productos: fechaCbte no puede ser más de 10 días hacia atrás.");
    if (diffDias < 0) errores.push("Concepto Productos: no se puede facturar con fecha futura.");
  } else if (concepto === CONCEPTO.SERVICIOS || concepto === CONCEPTO.AMBOS) {
    if (!cbte.fchServDesde || !cbte.fchServHasta || !cbte.fchVtoPago) {
      errores.push("Concepto Servicios/Ambos: exige FchServDesde, FchServHasta y FchVtoPago.");
    }
  }

  // --- 7. Punto de venta ---
  const pv = Number(cbte.puntoVenta || emisor.puntoVenta);
  if (!(pv > 0)) errores.push("puntoVenta debe ser numérico y mayor a 0.");

  return { valido: errores.length === 0, errores, tipoCbte };
}

// --- Wrapper HTTP ------------------------------------------------------------
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { emisorId, ...cbte } = body;
    if (!emisorId) return Response.json({ error: "Falta emisorId." }, { status: 400 });

    const emisor = await base44.asServiceRole.entities.ArcaEmisor.get(emisorId);
    if (!emisor) return Response.json({ error: "Emisor no encontrado." }, { status: 404 });

    const r = validar(emisor, cbte);
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
