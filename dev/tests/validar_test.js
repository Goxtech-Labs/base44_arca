// dev/tests/validar_test.js — Capa 1: reglas fiscales locales (offline).
import { assert, assertEquals } from "jsr:@std/assert";
import { validar, tipoComprobanteSugerido } from "../../functions/validarComprobante.js";

const emisorRI = { id: "e1", cuit: "20111111112", condicionIva: "RI", puntoVenta: 1 };
const emisorMono = { id: "e2", cuit: "20111111112", condicionIva: "MONOTRIBUTO", puntoVenta: 1 };
const hoy = new Date().toISOString().slice(0, 10);

function facturaB() {
  return {
    concepto: 1, docTipoReceptor: 96, docNroReceptor: "12345678",
    condicionIvaReceptorId: 5, // Consumidor Final
    impNeto: 10000, impIva: 2100, impTotal: 12100,
    alicuotasIva: [{ id: 5, baseImp: 10000, importe: 2100 }],
    fechaCbte: hoy, puntoVenta: 1,
  };
}

Deno.test("sugerido: RI a RI = Factura A (1); RI a CF = Factura B (6)", () => {
  assertEquals(tipoComprobanteSugerido("RI", 1), 1);
  assertEquals(tipoComprobanteSugerido("RI", 5), 6);
  assertEquals(tipoComprobanteSugerido("MONOTRIBUTO", 1), 11);
});

Deno.test("Factura B válida pasa sin errores", () => {
  const r = validar(emisorRI, facturaB());
  assertEquals(r.errores, []);
  assert(r.valido);
});

Deno.test("bloquea Factura A a Consumidor Final", () => {
  const cbte = { ...facturaB(), tipoCbte: 1, condicionIvaReceptorId: 5 };
  const r = validar(emisorRI, cbte);
  assert(!r.valido);
  assert(r.errores.some((e) => /Factura A a Consumidor Final/i.test(e)));
});

Deno.test("detecta descuadre de importes", () => {
  const cbte = { ...facturaB(), impTotal: 99999 };
  const r = validar(emisorRI, cbte);
  assert(r.errores.some((e) => /impTotal/i.test(e)));
});

Deno.test("detecta alícuota de IVA que no cuadra con la base", () => {
  const cbte = facturaB();
  cbte.alicuotasIva = [{ id: 5, baseImp: 10000, importe: 999 }]; // 21% de 10000 = 2100
  cbte.impIva = 999; cbte.impTotal = 10999;
  const r = validar(emisorRI, cbte);
  assert(r.errores.some((e) => /no cuadra|!= impIva/i.test(e)));
});

Deno.test("Monotributo: Factura C con IVA discriminado da error", () => {
  // impIva > 0 en una C debe fallar (no se discrimina IVA).
  const cbte = { ...facturaB(), impNeto: 10000, impIva: 2100, impTotal: 12100 };
  const r = validar(emisorMono, cbte);
  assert(r.errores.some((e) => /Factura C/i.test(e)));
});

Deno.test("Monotributo: Factura C correcta (impNeto = importe, sin IVA) pasa", () => {
  const cbte = {
    concepto: 1, docTipoReceptor: 96, docNroReceptor: "12345678",
    condicionIvaReceptorId: 5, impNeto: 12100, impIva: 0, impTotal: 12100,
    alicuotasIva: [], fechaCbte: hoy, puntoVenta: 1,
  };
  const r = validar(emisorMono, cbte);
  assertEquals(r.errores, []);
});

Deno.test("Productos: fecha a más de 10 días atrás da error", () => {
  const vieja = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const r = validar(emisorRI, { ...facturaB(), fechaCbte: vieja });
  assert(r.errores.some((e) => /10 días/i.test(e)));
});

Deno.test("Servicios sin fechas de servicio da error", () => {
  const r = validar(emisorRI, { ...facturaB(), concepto: 2 });
  assert(r.errores.some((e) => /Servicios/i.test(e)));
});
