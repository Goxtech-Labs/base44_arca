// dev/mockArca.js
// Intercepta globalThis.fetch para simular WSAA + WSFEv1 sin tocar AFIP.
// Respuestas con la MISMA forma que devuelve ARCA (namespaces incluidos), para
// ejercitar el parseo real de arcaCore.

import forge from "npm:node-forge";
import { generarParYCsr } from "../functions/arcaCore.js";

const enc = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// --- Respuesta WSAA (loginCmsResponse con el ticket escapado adentro) --------
export function respuestaWsaa({ token = "TOKEN_MOCK", sign = "SIGN_MOCK", expira = "2030-12-31T23:59:59.000-03:00" } = {}) {
  const ticket =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<loginTicketResponse version="1.0">` +
    `<header><source>CN=wsaahomo</source><destination>CN=test</destination>` +
    `<uniqueId>123456</uniqueId>` +
    `<generationTime>2026-06-30T00:00:00.000-03:00</generationTime>` +
    `<expirationTime>${expira}</expirationTime></header>` +
    `<credentials><token>${token}</token><sign>${sign}</sign></credentials>` +
    `</loginTicketResponse>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body><loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov">` +
    `<loginCmsReturn>${enc(ticket)}</loginCmsReturn>` +
    `</loginCmsResponse></soapenv:Body></soapenv:Envelope>`
  );
}

// --- FECompUltimoAutorizado --------------------------------------------------
export function respuestaUltimoAutorizado({ ptoVta = 1, cbteTipo = 6, cbteNro = 42 } = {}) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/">` +
    `<FECompUltimoAutorizadoResult>` +
    `<PtoVta>${ptoVta}</PtoVta><CbteTipo>${cbteTipo}</CbteTipo><CbteNro>${cbteNro}</CbteNro>` +
    `</FECompUltimoAutorizadoResult>` +
    `</FECompUltimoAutorizadoResponse></soap:Body></soap:Envelope>`
  );
}

// --- FECAESolicitar (aprobado) -----------------------------------------------
export function respuestaCAE({ resultado = "A", cae = "74123456789012", caeVto = "20260710", cbteDesde = 43, obs = [] } = {}) {
  const obsXml = obs.length
    ? `<Observaciones>${obs.map((o) => `<Obs><Code>${o.code}</Code><Msg>${enc(o.msg)}</Msg></Obs>`).join("")}</Observaciones>`
    : "";
  const caeXml = resultado === "R" ? "" : `<CAE>${cae}</CAE><CAEFchVto>${caeVto}</CAEFchVto>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/">` +
    `<FECAESolicitarResult>` +
    `<FeCabResp><Resultado>${resultado}</Resultado><Cuit>20111111112</Cuit><PtoVta>1</PtoVta><CbteTipo>6</CbteTipo><CantReg>1</CantReg></FeCabResp>` +
    `<FeDetResp><FECAEDetResponse>` +
    `<Concepto>1</Concepto><DocTipo>96</DocTipo><DocNro>12345678</DocNro>` +
    `<CbteDesde>${cbteDesde}</CbteDesde><CbteHasta>${cbteDesde}</CbteHasta><CbteFch>20260630</CbteFch>` +
    `<Resultado>${resultado}</Resultado>${caeXml}${obsXml}` +
    `</FECAEDetResponse></FeDetResp>` +
    `</FECAESolicitarResult>` +
    `</FECAESolicitarResponse></soap:Body></soap:Envelope>`
  );
}

function resp(xml, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return xml; },
  };
}

/**
 * Instala el mock. Devuelve { restore, calls } donde calls registra cada POST.
 * opts permite override de respuestas (p.ej. forzar rechazo).
 */
export function installMockFetch(opts = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = String(init.body || "");
    calls.push({ url: u, body });

    if (/LoginCms/i.test(u)) return resp(opts.wsaa ?? respuestaWsaa());
    if (/FECompUltimoAutorizado/.test(body)) return resp(opts.ultimo ?? respuestaUltimoAutorizado());
    if (/FECAESolicitar/.test(body)) return resp(opts.cae ?? respuestaCAE());
    if (/getPersona/.test(body)) return resp(opts.padron ?? "<soap:Envelope><soap:Body/></soap:Envelope>");

    throw new Error(`mockFetch: request no manejado -> ${u}`);
  };
  return { restore: () => (globalThis.fetch = original), calls };
}

/**
 * Genera un par (clave + certificado autofirmado) para tests. NO sirve contra
 * ARCA real; solo para ejercitar la firma PKCS#7 y el flujo interno.
 */
export function certAutofirmadoParaTest({ razonSocial = "Test SA", cuit = "20111111112" } = {}) {
  const { privateKeyPem } = generarParYCsr({ razonSocial, cuit, alias: `test-${cuit}` });
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);

  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [
    { shortName: "C", value: "AR" },
    { shortName: "O", value: razonSocial },
    { shortName: "CN", value: `test-${cuit}` },
    { type: "2.5.4.5", value: `CUIT ${cuit}` },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(privateKey, forge.md.sha256.create());

  return { crtPem: forge.pki.certificateToPem(cert), keyPem: privateKeyPem };
}
