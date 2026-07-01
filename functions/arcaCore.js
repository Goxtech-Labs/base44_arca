// arcaCore.js
// -----------------------------------------------------------------------------
// Helper compartido del módulo de Factura Electrónica ARCA para Base44 (Deno).
//
// Concentra TODO lo que las backend functions necesitan y que no es lógica de
// negocio pura:
//   1. Parametrización de ambiente (endpoints HOMO/PROD).
//   2. Tablas de parámetros WSFEv1 (constantes).
//   3. Criptografía: RSA keygen, CSR (PKCS#10), firma PKCS#7 del WSAA,
//      AES-GCM para la clave privada.
//   4. Armado y parseo de SOAP (WSAA + WSFEv1).
//
// Restricciones del entorno Deno de Base44 (ver ARQUITECTURA.md §1):
//   - No hay OpenSSL CLI ni shell -> toda la cripto es JS puro con node-forge
//     y Web Crypto (crypto.subtle).
//   - No hay filesystem persistente -> nada se escribe a disco.
//   - La clave privada NUNCA viaja en texto plano ni se loguea.
// -----------------------------------------------------------------------------

import forge from "npm:node-forge";
import { XMLParser } from "npm:fast-xml-parser";

// =============================================================================
// 1. AMBIENTE / ENDPOINTS
// =============================================================================

// WSAA sigue viviendo bajo afip.gob.ar (ARCA no rompió esas URLs todavía).
// WSFEv1 ya migró a arca.gob.ar. Mantenemos ambas familias parametrizadas.
export const ENDPOINTS = {
  HOMOLOGACION: {
    wsaa: "https://wsaahomo.afip.gob.ar/ws/services/LoginCms",
    wsfe: "https://wswhomo.arca.gob.ar/wsfev1/service.asmx",
    padron: "https://awshomo.afip.gob.ar/sr-padron/webservices/personaServiceA13",
  },
  PRODUCCION: {
    wsaa: "https://wsaa.afip.gob.ar/ws/services/LoginCms",
    wsfe: "https://servicios1.arca.gob.ar/wsfev1/service.asmx",
    padron: "https://aws.afip.gob.ar/sr-padron/webservices/personaServiceA13",
  },
};

/**
 * Devuelve el set de endpoints para un ambiente ("HOMOLOGACION" | "PRODUCCION").
 */
export function endpointsPara(ambiente) {
  const ep = ENDPOINTS[ambiente];
  if (!ep) throw new Error(`Ambiente inválido: ${ambiente}. Usá HOMOLOGACION o PRODUCCION.`);
  return ep;
}

// =============================================================================
// 2. TABLAS DE PARÁMETROS WSFEv1 (constantes)
// =============================================================================

export const CBTE_TIPO = {
  FACTURA_A: 1, FACTURA_B: 6, FACTURA_C: 11, FACTURA_M: 51,
  ND_A: 2, ND_B: 7, ND_C: 12,
  NC_A: 3, NC_B: 8, NC_C: 13,
};

export const CONCEPTO = { PRODUCTOS: 1, SERVICIOS: 2, AMBOS: 3 };

export const DOC_TIPO = { CUIT: 80, CUIL: 86, DNI: 96, CONSUMIDOR_FINAL: 99 };

// Iva.Id -> alícuota. baseImp * (pct/100) = importe.
export const IVA_ALICUOTA = {
  3: 0, 4: 10.5, 5: 21, 6: 27, 8: 5, 9: 2.5,
};

// CondicionIVAReceptorId (RG 5616) — obligatorio en el detalle del comprobante.
export const COND_IVA_RECEPTOR = {
  RESPONSABLE_INSCRIPTO: 1,
  EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
  MONOTRIBUTO: 6,
  NO_CATEGORIZADO: 7,
  PROVEEDOR_EXTERIOR: 8,
  CLIENTE_EXTERIOR: 9,
  IVA_LIBERADO_L19640: 10,
  MONOTRIBUTISTA_SOCIAL: 13,
  IVA_NO_ALCANZADO: 15,
  MONOTRIB_TRAB_INDEP_PROMOVIDO: 16,
};

// =============================================================================
// 3. UTILIDADES BÁSICAS
// =============================================================================

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

/** Base64 de un ArrayBuffer/Uint8Array sin reventar el stack con arrays grandes. */
export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Uint8Array a partir de un base64. */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Escapa texto para meterlo en un nodo XML sin romper el documento. */
export function xmlEscape(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** CUIT normalizado (solo dígitos). */
export function limpiarCuit(cuit) {
  return String(cuit ?? "").replace(/\D/g, "");
}

/** Fecha ARCA formato AAAAMMDD (WSFEv1) a partir de un "YYYY-MM-DD" o Date. */
export function fechaAfip(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(`${fecha}T00:00:00`);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** "AAAAMMDD" de ARCA -> "YYYY-MM-DD". */
export function fechaDesdeAfip(yyyymmdd) {
  const s = String(yyyymmdd ?? "");
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Redondeo a 2 decimales, estable para importes. */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// =============================================================================
// 4. CRIPTOGRAFÍA
// =============================================================================

const DIGEST = forge.pki.oids.sha256; // ARCA acepta SHA-256 en el CMS del WSAA.

/**
 * Genera un par RSA 2048 y el CSR (PKCS#10) para pedir el certificado a ARCA.
 * Devuelve el CSR y la clave privada, ambos en PEM. La .key NO se persiste acá:
 * el caller la encripta con encriptarClave() antes de guardarla.
 *
 * subject: /C=AR/O=<razonSocial>/CN=<alias>/serialNumber=CUIT <cuit>
 */
export function generarParYCsr({ razonSocial, cuit, alias }) {
  const cuitLimpio = limpiarCuit(cuit);
  const cn = alias || (razonSocial ? razonSocial.slice(0, 50) : `emisor-${cuitLimpio}`);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { shortName: "C", value: "AR" },
    { shortName: "O", value: razonSocial || cn },
    { shortName: "CN", value: cn },
    { type: "2.5.4.5", value: `CUIT ${cuitLimpio}` }, // serialNumber
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  return {
    csrPem: forge.pki.certificationRequestToPem(csr),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/**
 * Extrae CUIT (del serialNumber) y CN de un certificado .crt en PEM.
 * Se usa para validar que el .crt subido corresponda al CUIT del emisor.
 */
export function leerDatosCertificado(crtPem) {
  const cert = forge.pki.certificateFromPem(crtPem);
  const attrs = {};
  for (const a of cert.subject.attributes) {
    attrs[a.shortName || a.name || a.type] = a.value;
  }
  const serial = attrs.serialName || attrs.serialNumber || attrs["2.5.4.5"] || "";
  const cuitMatch = String(serial).match(/(\d{11})/) || String(attrs.CN || "").match(/(\d{11})/);
  return {
    cn: attrs.CN || null,
    cuit: cuitMatch ? cuitMatch[1] : null,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
  };
}

// ---- AES-GCM de la clave privada (Web Crypto, nativo de Deno) ----------------

async function derivarClave(masterKey, cuit) {
  const base = await crypto.subtle.importKey(
    "raw", textEnc.encode(masterKey), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: textEnc.encode(limpiarCuit(cuit)), iterations: 120000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encripta la clave privada (PEM) con AES-GCM. El master key vive en los
 * secrets de Base44 (ARCA_MASTER_KEY); el CUIT actúa de salt. Formato de salida:
 * base64( iv(12 bytes) || ciphertext+tag ).
 */
export async function encriptarClave(privateKeyPem, masterKey, cuit) {
  if (!masterKey) throw new Error("Falta ARCA_MASTER_KEY en los secrets del proyecto.");
  const key = await derivarClave(masterKey, cuit);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, textEnc.encode(privateKeyPem),
  );
  const combinado = new Uint8Array(iv.length + ct.byteLength);
  combinado.set(iv, 0);
  combinado.set(new Uint8Array(ct), iv.length);
  return bytesToBase64(combinado);
}

/**
 * Desencripta la clave privada. Solo se invoca en runtime dentro de wsaaLogin.
 * El resultado nunca se loguea ni se devuelve al frontend.
 */
export async function desencriptarClave(clavePrivadaEnc, masterKey, cuit) {
  if (!masterKey) throw new Error("Falta ARCA_MASTER_KEY en los secrets del proyecto.");
  const key = await derivarClave(masterKey, cuit);
  const raw = base64ToBytes(clavePrivadaEnc);
  const iv = raw.subarray(0, 12);
  const data = raw.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return textDec.decode(pt);
}

// =============================================================================
// 5. WSAA — TRA + firma PKCS#7
// =============================================================================

/**
 * Arma el TRA (loginTicketRequest) en XML.
 * generationTime = ahora -10min, expirationTime = ahora +10min (UTC).
 * uniqueId único por segundo. El desfasaje de reloj es la causa #1 de fallo.
 */
export function armarTra(servicio = "wsfe") {
  const ahora = Date.now();
  const gen = new Date(ahora - 10 * 60 * 1000).toISOString();
  const exp = new Date(ahora + 10 * 60 * 1000).toISOString();
  const uniqueId = Math.floor(ahora / 1000);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<loginTicketRequest version="1.0">` +
    `<header>` +
    `<uniqueId>${uniqueId}</uniqueId>` +
    `<generationTime>${gen}</generationTime>` +
    `<expirationTime>${exp}</expirationTime>` +
    `</header>` +
    `<service>${xmlEscape(servicio)}</service>` +
    `</loginTicketRequest>`
  );
}

/**
 * Firma el TRA como CMS/PKCS#7 SignedData (no-detached), DER -> base64.
 * Usa el .crt + la .key desencriptada. Si ARCA rechaza la firma, probar con
 * forge.md.sha1 / forge.pki.oids.sha1 (algunos entornos aún esperan SHA-1).
 */
export function firmarTraCms(traXml, crtPem, privateKeyPem) {
  const cert = forge.pki.certificateFromPem(crtPem);
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: DIGEST,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign(); // no-detached: el contenido va dentro del CMS.

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

/** Envelope SOAP para LoginCms del WSAA. */
export function soapLoginCms(cmsBase64) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">` +
    `<soapenv:Header/><soapenv:Body>` +
    `<wsaa:loginCms><wsaa:in0>${cmsBase64}</wsaa:in0></wsaa:loginCms>` +
    `</soapenv:Body></soapenv:Envelope>`
  );
}

// =============================================================================
// 6. SOAP genérico + parseo
// =============================================================================

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // dejamos todo string; casteamos nosotros donde importa.
  trimValues: true,
});

/** Parsea XML a objeto plano (namespaces removidos). */
export function parseXml(xml) {
  return parser.parse(xml);
}

/**
 * Busca recursivamente la primera aparición de una key en un objeto anidado.
 * Útil porque el SOAP de ARCA anida las respuestas de forma verbosa.
 */
export function buscarProfundo(obj, key) {
  if (obj == null || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = buscarProfundo(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * POST SOAP crudo. Devuelve { ok, status, xml, parsed, fault }.
 * No tira ante <soap:Fault>: lo devuelve para que el caller lo traduzca.
 */
export async function postSoap(url, body, soapAction) {
  const headers = { "Content-Type": "text/xml; charset=utf-8" };
  if (soapAction != null) headers["SOAPAction"] = soapAction;

  const resp = await fetch(url, { method: "POST", headers, body });
  const xml = await resp.text();
  const parsed = parseXml(xml);

  const fault = buscarProfundo(parsed, "Fault");
  return {
    ok: resp.ok && !fault,
    status: resp.status,
    xml,
    parsed,
    fault: fault
      ? {
          code: buscarProfundo(fault, "faultcode") ?? buscarProfundo(fault, "Code"),
          msg: buscarProfundo(fault, "faultstring") ?? buscarProfundo(fault, "Reason"),
        }
      : null,
  };
}

// =============================================================================
// 7. WSFEv1 — armado de requests SOAP
// =============================================================================

const NS_FEV1 = "http://ar.gov.afip.dif.FEV1/";

function authXml({ token, sign, cuit }) {
  return (
    `<ar:Auth>` +
    `<ar:Token>${token}</ar:Token>` +
    `<ar:Sign>${sign}</ar:Sign>` +
    `<ar:Cuit>${limpiarCuit(cuit)}</ar:Cuit>` +
    `</ar:Auth>`
  );
}

/** SOAP de FECompUltimoAutorizado (último comprobante autorizado por PV+tipo). */
export function soapUltimoAutorizado(auth, ptoVta, cbteTipo) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS_FEV1}">` +
    `<soapenv:Header/><soapenv:Body>` +
    `<ar:FECompUltimoAutorizado>` +
    authXml(auth) +
    `<ar:PtoVta>${Number(ptoVta)}</ar:PtoVta>` +
    `<ar:CbteTipo>${Number(cbteTipo)}</ar:CbteTipo>` +
    `</ar:FECompUltimoAutorizado>` +
    `</soapenv:Body></soapenv:Envelope>`
  );
}

/**
 * Arma el SOAP de FECAESolicitar a partir de un detalle ya validado.
 * det: {
 *   concepto, docTipoReceptor, docNroReceptor, cbteNro, fechaCbte(YYYY-MM-DD),
 *   impTotal, impTotConc, impNeto, impOpEx, impTrib, impIva,
 *   moneda, cotizacion, condicionIvaReceptorId,
 *   alicuotasIva: [{id, baseImp, importe}],
 *   fchServDesde?, fchServHasta?, fchVtoPago? (YYYY-MM-DD, solo Servicios)
 * }
 */
export function soapFECAESolicitar(auth, ptoVta, cbteTipo, det) {
  const esServicio = Number(det.concepto) === CONCEPTO.SERVICIOS || Number(det.concepto) === CONCEPTO.AMBOS;

  const ivaXml =
    Array.isArray(det.alicuotasIva) && det.alicuotasIva.length
      ? `<ar:Iva>` +
        det.alicuotasIva
          .map(
            (a) =>
              `<ar:AlicIva>` +
              `<ar:Id>${Number(a.id)}</ar:Id>` +
              `<ar:BaseImp>${round2(a.baseImp)}</ar:BaseImp>` +
              `<ar:Importe>${round2(a.importe)}</ar:Importe>` +
              `</ar:AlicIva>`,
          )
          .join("") +
        `</ar:Iva>`
      : "";

  const fechasServicio = esServicio
    ? `<ar:FchServDesde>${fechaAfip(det.fchServDesde || det.fechaCbte)}</ar:FchServDesde>` +
      `<ar:FchServHasta>${fechaAfip(det.fchServHasta || det.fechaCbte)}</ar:FchServHasta>` +
      `<ar:FchVtoPago>${fechaAfip(det.fchVtoPago || det.fechaCbte)}</ar:FchVtoPago>`
    : "";

  const detalle =
    `<ar:FECAEDetRequest>` +
    `<ar:Concepto>${Number(det.concepto)}</ar:Concepto>` +
    `<ar:DocTipo>${Number(det.docTipoReceptor)}</ar:DocTipo>` +
    `<ar:DocNro>${limpiarCuit(det.docNroReceptor) || 0}</ar:DocNro>` +
    `<ar:CbteDesde>${Number(det.cbteNro)}</ar:CbteDesde>` +
    `<ar:CbteHasta>${Number(det.cbteNro)}</ar:CbteHasta>` +
    `<ar:CbteFch>${fechaAfip(det.fechaCbte)}</ar:CbteFch>` +
    `<ar:ImpTotal>${round2(det.impTotal)}</ar:ImpTotal>` +
    `<ar:ImpTotConc>${round2(det.impTotConc || 0)}</ar:ImpTotConc>` +
    `<ar:ImpNeto>${round2(det.impNeto || 0)}</ar:ImpNeto>` +
    `<ar:ImpOpEx>${round2(det.impOpEx || 0)}</ar:ImpOpEx>` +
    `<ar:ImpTrib>${round2(det.impTrib || 0)}</ar:ImpTrib>` +
    `<ar:ImpIVA>${round2(det.impIva || 0)}</ar:ImpIVA>` +
    fechasServicio +
    `<ar:MonId>${xmlEscape(det.moneda || "PES")}</ar:MonId>` +
    `<ar:MonCotiz>${det.cotizacion || 1}</ar:MonCotiz>` +
    `<ar:CondicionIVAReceptorId>${Number(det.condicionIvaReceptorId)}</ar:CondicionIVAReceptorId>` +
    ivaXml +
    `</ar:FECAEDetRequest>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS_FEV1}">` +
    `<soapenv:Header/><soapenv:Body>` +
    `<ar:FECAESolicitar>` +
    authXml(auth) +
    `<ar:FeCAEReq>` +
    `<ar:FeCabReq>` +
    `<ar:CantReg>1</ar:CantReg>` +
    `<ar:PtoVta>${Number(ptoVta)}</ar:PtoVta>` +
    `<ar:CbteTipo>${Number(cbteTipo)}</ar:CbteTipo>` +
    `</ar:FeCabReq>` +
    `<ar:FeDetReq>${detalle}</ar:FeDetReq>` +
    `</ar:FeCAEReq>` +
    `</ar:FECAESolicitar>` +
    `</soapenv:Body></soapenv:Envelope>`
  );
}

/** SOAPAction para cada método WSFEv1. */
export function soapActionFEV1(metodo) {
  return `${NS_FEV1}${metodo}`;
}

// =============================================================================
// 8. QR OBLIGATORIO (RG 4892)
// =============================================================================

/**
 * Construye el payload del QR obligatorio (RG 4892).
 * Devuelve { b64, url, data }. url = https://www.afip.gob.ar/fe/qr/?p=<b64>.
 */
export function construirQr({ cuit, ptoVta, tipoCmp, nroCmp, importe, moneda, ctz, tipoDocRec, nroDocRec, cae, fecha }) {
  const data = {
    ver: 1,
    fecha, // YYYY-MM-DD
    cuit: Number(limpiarCuit(cuit)),
    ptoVta: Number(ptoVta),
    tipoCmp: Number(tipoCmp),
    nroCmp: Number(nroCmp),
    importe: round2(importe),
    moneda: moneda || "PES",
    ctz: Number(ctz) || 1,
    tipoDocRec: Number(tipoDocRec),
    nroDocRec: Number(String(nroDocRec ?? "").replace(/\D/g, "")) || 0,
    tipoCodAut: "E",
    codAut: Number(cae),
  };
  const b64 = bytesToBase64(new TextEncoder().encode(JSON.stringify(data)));
  return { b64, url: `https://www.afip.gob.ar/fe/qr/?p=${b64}`, data };
}

// =============================================================================
// 9. TRADUCCIÓN DE ERRORES ARCA
// =============================================================================

/**
 * Traduce códigos/mensajes crudos de ARCA a algo accionable en español.
 * Recibe un array de {code, msg} (Errors/Observations) o un string suelto.
 */
export function traducirErrorArca(errores) {
  const lista = Array.isArray(errores) ? errores : [{ code: "", msg: String(errores || "") }];
  return lista.map(({ code, msg }) => {
    const m = String(msg || "");
    let ayuda = null;
    if (/no.*certificad|method.*not.*certif/i.test(m))
      ayuda = "El certificado no está asociado al servicio wsfe o el CUIT no adhirió WSFE. Asocialo en Adm. de Relaciones.";
    else if (/punto de venta|pto.*vta|no.*habilitado/i.test(m))
      ayuda = "Dá de alta un punto de venta tipo WSFEV1 en ARCA (los de talonario/facturador en línea no sirven).";
    else if (/correlativ/i.test(m))
      ayuda = "Numeración salteada. El módulo consulta FECompUltimoAutorizado antes de emitir; reintentá.";
    else if (/fecha.*rango|fuera de rango/i.test(m))
      ayuda = "Fecha fuera de rango: máx. 10 días hacia atrás en Productos, nunca a futuro.";
    else if (/token|sign|expir/i.test(m))
      ayuda = "Token/Sign vencido o reloj desfasado. El módulo re-loguea solo; revisá la hora del servidor si persiste.";
    return { code: code ?? "", msg: m, ayuda };
  });
}
