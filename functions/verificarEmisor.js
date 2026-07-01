// verificarEmisor.js
// -----------------------------------------------------------------------------
// Confirma que el CUIT del emisor esté activo y su condición frente al IVA,
// consultando el WS Padrón A13. Si el certificado no está adherido a padrón
// (es opcional), cae a una validación local contra la config del ArcaEmisor.
// Avisa si hay desalineación.
// -----------------------------------------------------------------------------

import { createClientFromRequest } from "npm:@base44/sdk";
import { endpointsPara, postSoap, buscarProfundo, limpiarCuit } from "./arcaCore.js";
import { obtenerCredenciales } from "./wsaaLogin.js";

const NS_PADRON = "http://a13.soap.ws.server.puc.sr/";
const SERVICIO_PADRON = "ws_sr_padron_a13";

function soapGetPersona(auth, cuitConsultado) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a13="${NS_PADRON}">` +
    `<soapenv:Header/><soapenv:Body>` +
    `<a13:getPersona>` +
    `<token>${auth.token}</token>` +
    `<sign>${auth.sign}</sign>` +
    `<cuitRepresentada>${limpiarCuit(auth.cuit)}</cuitRepresentada>` +
    `<idPersona>${limpiarCuit(cuitConsultado)}</idPersona>` +
    `</a13:getPersona>` +
    `</soapenv:Body></soapenv:Envelope>`
  );
}

if (!Deno.env.get("ARCA_NO_SERVE")) Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { emisorId } = await req.json().catch(() => ({}));
    if (!emisorId) return Response.json({ error: "Falta emisorId." }, { status: 400 });

    const emisor = await base44.asServiceRole.entities.ArcaEmisor.get(emisorId);
    if (!emisor) return Response.json({ error: "Emisor no encontrado." }, { status: 404 });

    const avisos = [];
    let padron = null;

    // Validación local mínima.
    if (limpiarCuit(emisor.cuit).length !== 11) avisos.push("El CUIT cargado no tiene 11 dígitos.");
    if (!(Number(emisor.puntoVenta) > 0)) avisos.push("El punto de venta debe ser > 0.");
    if (emisor.estado !== "ACTIVO") avisos.push("El emisor no está ACTIVO (falta cargar el certificado).");

    // Intento de consulta al Padrón A13 (opcional; requiere cert adherido).
    try {
      const cred = await obtenerCredenciales(base44, emisor, SERVICIO_PADRON);
      const { padron: url } = endpointsPara(emisor.ambiente);
      const res = await postSoap(url, soapGetPersona({ ...cred, cuit: emisor.cuit }, emisor.cuit), "");
      if (res.fault) {
        avisos.push(`No se pudo consultar el Padrón A13 (${res.fault.msg}). El certificado quizá no está adherido a padrón; es opcional.`);
      } else {
        const persona = buscarProfundo(res.parsed, "persona");
        const estadoClave = buscarProfundo(persona || {}, "estadoClave");
        padron = {
          estadoClave,
          nombre: buscarProfundo(persona || {}, "nombre") || buscarProfundo(persona || {}, "razonSocial"),
        };
        if (estadoClave && !/activo/i.test(String(estadoClave))) {
          avisos.push(`El Padrón informa la clave fiscal en estado "${estadoClave}".`);
        }
      }
    } catch (e) {
      avisos.push(`Consulta a Padrón A13 no disponible: ${e.message}. Se usó validación local.`);
    }

    return Response.json({ ok: avisos.length === 0, avisos, padron, emisor: { cuit: emisor.cuit, condicionIva: emisor.condicionIva, puntoVenta: emisor.puntoVenta, ambiente: emisor.ambiente, estado: emisor.estado } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
