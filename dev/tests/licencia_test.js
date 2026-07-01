// dev/tests/licencia_test.js — integración con el sistema de licencias GoxTech.
import { assert, assertEquals } from "jsr:@std/assert";
import { createMockBase44 } from "../mockBase44.js";
import { installMockFetch } from "../mockArca.js";
import { verificarLicencia, registrarLicenciaGratis, tieneCompleta, esPago } from "../../functions/licencia.js";

const CUIT = "20111111112";

Deno.test("verificarLicencia: CUIT desconocido -> basica y cachea", async () => {
  const base44 = createMockBase44();
  const mock = installMockFetch();
  try {
    const r = await verificarLicencia(base44, CUIT);
    assertEquals(r.plan, "basica");
    assert(r.active && r.valid);
    assertEquals(r.from_cache, false);
    const cache = await base44.asServiceRole.entities.ArcaLicencia.filter({ cuit: CUIT });
    assertEquals(cache.length, 1);
  } finally { mock.restore(); }
});

Deno.test("verificarLicencia: 2º llamado usa cache (no pega al server)", async () => {
  const base44 = createMockBase44();
  const mock = installMockFetch();
  try {
    await verificarLicencia(base44, CUIT);
    const antes = mock.calls.filter((c) => /licenses\/check/.test(c.url)).length;
    const r2 = await verificarLicencia(base44, CUIT);
    const despues = mock.calls.filter((c) => /licenses\/check/.test(c.url)).length;
    assertEquals(r2.from_cache, true);
    assertEquals(antes, despues, "no debe haber una 2ª consulta online");
  } finally { mock.restore(); }
});

Deno.test("verificarLicencia: force ignora el cache", async () => {
  const base44 = createMockBase44();
  const mock = installMockFetch();
  try {
    await verificarLicencia(base44, CUIT);
    const antes = mock.calls.filter((c) => /licenses\/check/.test(c.url)).length;
    await verificarLicencia(base44, CUIT, { force: true });
    const despues = mock.calls.filter((c) => /licenses\/check/.test(c.url)).length;
    assertEquals(despues, antes + 1);
  } finally { mock.restore(); }
});

Deno.test("verificarLicencia: plan completa -> tieneCompleta / esPago", async () => {
  const base44 = createMockBase44();
  const mock = installMockFetch({ licencia: { plan: "completa", active: true, valid_until: null } });
  try {
    const r = await verificarLicencia(base44, CUIT);
    assertEquals(r.plan, "completa");
    assert(tieneCompleta(r));
    assert(esPago(r));
  } finally { mock.restore(); }
});

Deno.test("verificarLicencia: plan pago vencido -> degrada a basica usable", async () => {
  const base44 = createMockBase44();
  const mock = installMockFetch({ licencia: { plan: "completa", active: false, valid_until: "2020-01-01" } });
  try {
    const r = await verificarLicencia(base44, CUIT);
    assertEquals(r.plan, "basica");
    assert(r.valid, "sigue usable en modo básico");
  } finally { mock.restore(); }
});

Deno.test("verificarLicencia: sin conexión y sin cache -> basica default", async () => {
  const base44 = createMockBase44();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const r = await verificarLicencia(base44, CUIT);
    assertEquals(r.plan, "basica");
    assert(r.valid);
  } finally { globalThis.fetch = original; }
});

Deno.test("registrarLicenciaGratis: postea y refresca el estado", async () => {
  const base44 = createMockBase44();
  const mock = installMockFetch();
  try {
    const r = await registrarLicenciaGratis(base44, { cuit: CUIT, email: "test@goxtech.com", companyName: "Acme SA" });
    assert(r.registro.ok, "el POST /licenses/free debe responder ok");
    assertEquals(r.licencia.plan, "basica");
    const posteos = mock.calls.filter((c) => /licenses\/free/.test(c.url));
    assertEquals(posteos.length, 1);
  } finally { mock.restore(); }
});

Deno.test("registrarLicenciaGratis: email inválido tira error", async () => {
  const base44 = createMockBase44();
  let fallo = false;
  try { await registrarLicenciaGratis(base44, { cuit: CUIT, email: "no-es-email" }); }
  catch { fallo = true; }
  assert(fallo);
});
