// dev/tests/crypto_test.js — Capa 1: criptografía pura (offline).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import forge from "npm:node-forge";
import {
  generarParYCsr,
  encriptarClave,
  desencriptarClave,
  leerDatosCertificado,
  armarTra,
  firmarTraCms,
} from "../../functions/arcaCore.js";
import { certAutofirmadoParaTest } from "../mockArca.js";

const CUIT = "20111111112";

Deno.test("generarParYCsr: CSR válido con subject correcto", () => {
  const { csrPem, privateKeyPem } = generarParYCsr({ razonSocial: "Acme SA", cuit: CUIT, alias: "acme" });
  assertStringIncludes(csrPem, "CERTIFICATE REQUEST");
  assertStringIncludes(privateKeyPem, "RSA PRIVATE KEY");

  const csr = forge.pki.certificationRequestFromPem(csrPem);
  assert(csr.verify(), "el CSR debe estar auto-firmado válido");
  const cn = csr.subject.getField("CN");
  assertEquals(cn.value, "acme");
  const sn = csr.subject.attributes.find((a) => a.type === "2.5.4.5");
  assertStringIncludes(sn.value, CUIT);
});

Deno.test("AES-GCM: encriptar/desencriptar es round-trip exacto", async () => {
  const { privateKeyPem } = generarParYCsr({ razonSocial: "Acme", cuit: CUIT });
  const master = "master-key-de-prueba-muy-larga-1234567890";
  const enc = await encriptarClave(privateKeyPem, master, CUIT);
  assert(!enc.includes("PRIVATE KEY"), "el texto encriptado no debe filtrar el PEM");
  const dec = await desencriptarClave(enc, master, CUIT);
  assertEquals(dec, privateKeyPem);
});

Deno.test("AES-GCM: master key equivocada falla", async () => {
  const { privateKeyPem } = generarParYCsr({ razonSocial: "Acme", cuit: CUIT });
  const enc = await encriptarClave(privateKeyPem, "master-buena", CUIT);
  let fallo = false;
  try { await desencriptarClave(enc, "master-mala", CUIT); } catch { fallo = true; }
  assert(fallo, "desencriptar con otra master key debe fallar");
});

Deno.test("leerDatosCertificado: extrae CUIT del serialNumber", () => {
  const { crtPem } = certAutofirmadoParaTest({ cuit: CUIT, razonSocial: "Acme SA" });
  const d = leerDatosCertificado(crtPem);
  assertEquals(d.cuit, CUIT);
});

Deno.test("armarTra: generationTime < expirationTime y XML bien formado", () => {
  const tra = armarTra("wsfe");
  assertStringIncludes(tra, "<service>wsfe</service>");
  const gen = new Date(tra.match(/<generationTime>(.*?)<\/generationTime>/)[1]);
  const exp = new Date(tra.match(/<expirationTime>(.*?)<\/expirationTime>/)[1]);
  assert(gen < exp, "generationTime debe ser anterior a expirationTime");
});

Deno.test("firmarTraCms: produce un CMS PKCS#7 decodificable", () => {
  const { crtPem, keyPem } = certAutofirmadoParaTest({ cuit: CUIT });
  const tra = armarTra("wsfe");
  const cms = firmarTraCms(tra, crtPem, keyPem);
  assert(cms.length > 100, "el CMS base64 debe tener contenido");
  const der = forge.util.decode64(cms);
  const asn1 = forge.asn1.fromDer(der); // si no tira, es ASN.1 válido
  assert(asn1, "el CMS debe ser ASN.1/DER válido");
});
