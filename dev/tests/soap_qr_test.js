// dev/tests/soap_qr_test.js — Capa 1: armado/parseo SOAP + QR (offline).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  soapFECAESolicitar,
  soapUltimoAutorizado,
  parseXml,
  buscarProfundo,
  construirQr,
  base64ToBytes,
} from "../../functions/arcaCore.js";
import { respuestaUltimoAutorizado, respuestaCAE } from "../mockArca.js";

const auth = { token: "T", sign: "S", cuit: "20111111112" };

Deno.test("soapUltimoAutorizado incluye Auth y parámetros", () => {
  const xml = soapUltimoAutorizado(auth, 1, 6);
  assertStringIncludes(xml, "<ar:PtoVta>1</ar:PtoVta>");
  assertStringIncludes(xml, "<ar:CbteTipo>6</ar:CbteTipo>");
  assertStringIncludes(xml, "<ar:Cuit>20111111112</ar:Cuit>");
});

Deno.test("soapFECAESolicitar arma detalle, IVA y CondicionIVAReceptorId", () => {
  const det = {
    concepto: 1, docTipoReceptor: 96, docNroReceptor: "12345678", cbteNro: 43,
    fechaCbte: "2026-06-30", impTotal: 12100, impNeto: 10000, impIva: 2100,
    condicionIvaReceptorId: 5, moneda: "PES", cotizacion: 1,
    alicuotasIva: [{ id: 5, baseImp: 10000, importe: 2100 }],
  };
  const xml = soapFECAESolicitar(auth, 1, 6, det);
  assertStringIncludes(xml, "<ar:CbteFch>20260630</ar:CbteFch>");
  assertStringIncludes(xml, "<ar:CondicionIVAReceptorId>5</ar:CondicionIVAReceptorId>");
  assertStringIncludes(xml, "<ar:AlicIva><ar:Id>5</ar:Id>");
  assertStringIncludes(xml, "<ar:ImpIVA>2100</ar:ImpIVA>");
});

Deno.test("soapFECAESolicitar: Servicios agrega fechas de servicio", () => {
  const det = {
    concepto: 2, docTipoReceptor: 80, docNroReceptor: "20111111112", cbteNro: 1,
    fechaCbte: "2026-06-30", fchServDesde: "2026-06-01", fchServHasta: "2026-06-30",
    fchVtoPago: "2026-07-10", impTotal: 1210, impNeto: 1000, impIva: 210,
    condicionIvaReceptorId: 1, alicuotasIva: [{ id: 5, baseImp: 1000, importe: 210 }],
  };
  const xml = soapFECAESolicitar(auth, 1, 1, det);
  assertStringIncludes(xml, "<ar:FchServDesde>20260601</ar:FchServDesde>");
  assertStringIncludes(xml, "<ar:FchVtoPago>20260710</ar:FchVtoPago>");
});

Deno.test("parseo: extrae CbteNro de FECompUltimoAutorizado", () => {
  const parsed = parseXml(respuestaUltimoAutorizado({ cbteNro: 99 }));
  const result = buscarProfundo(parsed, "FECompUltimoAutorizadoResult");
  assertEquals(Number(buscarProfundo(result, "CbteNro")), 99);
});

Deno.test("parseo: extrae CAE y Resultado de FECAESolicitar", () => {
  const parsed = parseXml(respuestaCAE({ cae: "74000000000001" }));
  const result = buscarProfundo(parsed, "FECAESolicitarResult");
  assertEquals(buscarProfundo(result, "CAE"), "74000000000001");
  assertEquals(buscarProfundo(buscarProfundo(result, "FECAEDetResponse"), "Resultado"), "A");
});

Deno.test("QR RG 4892: estructura y round-trip base64", () => {
  const qr = construirQr({
    cuit: "20111111112", ptoVta: 1, tipoCmp: 6, nroCmp: 43, importe: 12100,
    moneda: "PES", ctz: 1, tipoDocRec: 96, nroDocRec: "12345678", cae: "74123456789012", fecha: "2026-06-30",
  });
  assertStringIncludes(qr.url, "https://www.afip.gob.ar/fe/qr/?p=");
  assertEquals(qr.data.ver, 1);
  assertEquals(qr.data.tipoCodAut, "E");
  assertEquals(qr.data.codAut, 74123456789012);
  // el base64 decodifica al JSON original
  const json = JSON.parse(new TextDecoder().decode(base64ToBytes(qr.b64)));
  assertEquals(json.cuit, 20111111112);
  assertEquals(json.importe, 12100);
});
