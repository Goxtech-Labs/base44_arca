// wsaaLogin.js
// -----------------------------------------------------------------------------
// Autenticación contra el WSAA de ARCA. Devuelve Token + Sign para operar el
// WSFEv1. Reutiliza el token cacheado en ArcaTokenCache mientras siga vigente;
// si no, arma el TRA, lo firma como PKCS#7 y pega a LoginCms.
//
// Exporta obtenerCredenciales() para que emitirFactura y compañía lo reutilicen
// sin pasar por HTTP, y expone un Deno.serve wrapper para debug/uso directo.
// -----------------------------------------------------------------------------

import { createClientFromRequest } from "npm:@base44/sdk";
import {
  endpointsPara,
  armarTra,
  firmarTraCms,
  soapLoginCms,
  postSoap,
  parseXml,
  buscarProfundo,
  desencriptarClave,
} from "./arcaCore.js";

const MARGEN_MS = 5 * 60 * 1000; // renovamos 5 min antes del vencimiento real.

/**
 * Obtiene credenciales WSAA vigentes para un emisor.
 * @param base44  cliente Base44 (con asServiceRole).
 * @param emisor  registro ArcaEmisor.
 * @param servicio  por defecto "wsfe".
 * @returns { token, sign, cuit, ambiente, expiraEn, cacheHit }
 */
export async function obtenerCredenciales(base44, emisor, servicio = "wsfe") {
  const { cuit, ambiente } = emisor;
  const admin = base44.asServiceRole;

  // 1. ¿Hay token cacheado y vigente?
  const cacheados = await admin.entities.ArcaTokenCache.filter({ cuit, servicio, ambiente });
  const vigente = (cacheados || []).find(
    (t) => new Date(t.expiraEn).getTime() - MARGEN_MS > Date.now(),
  );
  if (vigente) {
    return { token: vigente.token, sign: vigente.sign, cuit, ambiente, expiraEn: vigente.expiraEn, cacheHit: true };
  }

  // 2. Validaciones previas.
  if (emisor.estado !== "ACTIVO" || !emisor.certificadoCrt || !emisor.clavePrivadaEnc) {
    throw new Error("El emisor no está ACTIVO o le falta el certificado/clave. Completá el wizard de certificado primero.");
  }
  const masterKey = Deno.env.get("ARCA_MASTER_KEY");
  if (!masterKey) throw new Error("Falta el secret ARCA_MASTER_KEY en el proyecto.");

  // 3. Armar y firmar el TRA (la .key se desencripta solo acá, en runtime).
  const tra = armarTra(servicio);
  let cms;
  try {
    const keyPem = await desencriptarClave(emisor.clavePrivadaEnc, masterKey, cuit);
    cms = firmarTraCms(tra, emisor.certificadoCrt, keyPem);
  } catch (e) {
    throw new Error(`No se pudo firmar el TRA: ${e.message}. Revisá que el .crt corresponda a la clave generada.`);
  }

  // 4. POST a LoginCms.
  const { wsaa } = endpointsPara(ambiente);
  const res = await postSoap(wsaa, soapLoginCms(cms), "");
  if (res.fault) {
    const msg = String(res.fault.msg || "");
    if (/expired|caducado|vencid|generationtime|hora/i.test(msg)) {
      throw new Error(`WSAA rechazó el TRA por desfasaje de reloj/tiempo: ${msg}. Verificá la hora del servidor (usar UTC).`);
    }
    if (/certificado|certificate|computador|alias/i.test(msg)) {
      throw new Error(`WSAA rechazó el certificado: ${msg}. ¿Está asociado al servicio ${servicio} y al ambiente correcto?`);
    }
    throw new Error(`WSAA falló: ${msg}`);
  }

  // 5. Parsear el loginTicketResponse (viene como XML escapado dentro del SOAP).
  const inner = buscarProfundo(res.parsed, "loginCmsReturn");
  if (!inner) throw new Error("Respuesta WSAA inesperada: no se encontró loginCmsReturn.");
  const ticket = parseXml(String(inner));
  const token = buscarProfundo(ticket, "token");
  const sign = buscarProfundo(ticket, "sign");
  const expirationTime = buscarProfundo(ticket, "expirationTime");
  if (!token || !sign) throw new Error("WSAA no devolvió token/sign.");

  const expiraEn = new Date(expirationTime).toISOString();

  // 6. Cachear (borro los previos de ese cuit/servicio/ambiente para no acumular).
  for (const viejo of cacheados || []) {
    try { await admin.entities.ArcaTokenCache.delete(viejo.id); } catch { /* best effort */ }
  }
  await admin.entities.ArcaTokenCache.create({ cuit, servicio, ambiente, token, sign, expiraEn });

  return { token, sign, cuit, ambiente, expiraEn, cacheHit: false };
}

// --- Wrapper HTTP (debug / invocación directa) -------------------------------
// El guard ARCA_NO_SERVE evita levantar el server al importar el módulo en tests.
// Base44 no setea esa variable, así que en producción sirve normalmente.
if (!Deno.env.get("ARCA_NO_SERVE")) Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { emisorId } = await req.json().catch(() => ({}));
    if (!emisorId) return Response.json({ error: "Falta emisorId." }, { status: 400 });

    const emisor = await base44.asServiceRole.entities.ArcaEmisor.get(emisorId);
    if (!emisor) return Response.json({ error: "Emisor no encontrado." }, { status: 404 });

    const cred = await obtenerCredenciales(base44, emisor);
    // No devolvemos token/sign completos por seguridad: solo confirmación.
    return Response.json({
      ok: true,
      cacheHit: cred.cacheHit,
      expiraEn: cred.expiraEn,
      ambiente: cred.ambiente,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
