// licencia.js
// -----------------------------------------------------------------------------
// Integración con el sistema de licencias GRATIS de GoxTech (el mismo que usa el
// módulo de FactuSol). La licencia se llavea por CUIT y se comparte entre
// productos: un CUIT con plan Completo en FactuSol también lo tiene acá.
//
// Política de este módulo: la emisión es SIEMPRE gratis (plan "basica"). La
// licencia solo registra el CUIT y trackea versión/uso; no bloquea nada. Los
// helpers tieneCompleta()/esPago() quedan listos por si más adelante se quiere
// gatear alguna feature, sin tocar el resto del código.
//
// Patrón (idéntico a FactuSol): verifica online, cachea 7 días en ArcaLicencia
// y cae a modo básico si no hay conexión. Nunca deja de funcionar.
// -----------------------------------------------------------------------------

import { createClientFromRequest } from "npm:@base44/sdk";
import { limpiarCuit } from "./arcaCore.js";

// Base del API de licencias (override por env para self-host / testing).
// base44_arca tiene su propio mount (mismo backend/DB que FactuSol, por CUIT).
// Fallback histórico que sigue vigente: https://goxtech.com.ar/arca_factusol/api
const LICENSE_BASE = Deno.env.get("ARCA_LICENSE_URL") || "https://goxtech.com.ar/base44_arca/api";

// Identidad de producto ante el server de licencias. Se reporta en el parámetro
// `v` de /licenses/check → el server lo guarda como app_version, así en el panel
// admin se distingue este módulo de FactuSol u otros clientes del mismo CUIT.
export const MODULE_ID = Deno.env.get("ARCA_MODULE_ID") || "base44_arca";
export const MODULE_VERSION = Deno.env.get("ARCA_MODULE_VERSION") || "1.0.0";
export const MODULE_TAG = `${MODULE_ID}/${MODULE_VERSION}`; // ej: "base44_arca/1.0.0"

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 días

function basica(cuit, message, fromCache = false) {
  return { plan: "basica", active: true, valid: true, from_cache: fromCache, valid_until: null, cuit, message };
}

/** Normaliza el estado (equivalente a _build_status de FactuSol). */
function construir(cuit, plan, active, valid_until, fromCache) {
  let msg;
  if (plan === "completa" && active) {
    msg = valid_until ? `Plan Completo activo hasta ${valid_until}` : "Plan Completo activo";
  } else if (plan === "monthly" && active) {
    msg = valid_until ? `Plan Mensual activo hasta ${valid_until}` : "Plan Mensual activo";
  } else if ((plan === "completa" || plan === "monthly") && !active) {
    msg = "Plan pago vencido — renová en goxtech.com.ar";
    plan = "basica";
    active = true;
  } else {
    msg = "Plan Básico activo (gratis)";
  }
  if (fromCache) msg += " (verificado sin conexión)";
  return { plan, active, valid: true, from_cache: fromCache, valid_until, cuit, message: msg };
}

async function leerCache(admin, cuit) {
  const rows = await admin.entities.ArcaLicencia.filter({ cuit });
  return (rows || [])[0] || null;
}

async function guardarCache(admin, cuit, plan, active, valid_until, version) {
  const rec = {
    cuit, plan, active: !!active, valid_until: valid_until ?? null,
    appVersion: version || "", cachedAt: new Date().toISOString(),
  };
  const existente = await leerCache(admin, cuit);
  if (existente) await admin.entities.ArcaLicencia.update(existente.id, rec);
  else await admin.entities.ArcaLicencia.create(rec);
}

/**
 * Verifica el plan de un CUIT. Cache-first (7 días) para no pegarle al servidor
 * en cada emisión; con `force` fuerza la consulta online.
 * @returns { plan, active, valid, from_cache, valid_until, cuit, message }
 */
export async function verificarLicencia(base44, cuit, { version = MODULE_TAG, force = false } = {}) {
  const admin = base44.asServiceRole;
  const c = limpiarCuit(cuit);
  if (!c || c.length < 10) return basica(c, "Configurá el CUIT del emisor para verificar el plan");

  // 1. Cache fresco (si no se fuerza).
  if (!force) {
    const cache = await leerCache(admin, c);
    if (cache && cache.cachedAt && Date.now() - new Date(cache.cachedAt).getTime() < CACHE_TTL_MS) {
      return construir(c, cache.plan, cache.active, cache.valid_until, true);
    }
  }

  // 2. Consulta online.
  try {
    const url = `${LICENSE_BASE}/licenses/check?cuit=${c}` + (version ? `&v=${encodeURIComponent(version)}` : "");
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (resp.ok) {
      const d = await resp.json();
      const plan = d.plan || "basica";
      const active = !!d.active;
      const valid_until = d.valid_until ?? null;
      await guardarCache(admin, c, plan, active, valid_until, version);
      return construir(c, plan, active, valid_until, false);
    }
  } catch { /* sin conexión: seguimos al fallback */ }

  // 3. Fallback offline: cache viejo si existe, si no modo básico.
  const cache = await leerCache(admin, c);
  if (cache) return construir(c, cache.plan, cache.active, cache.valid_until, true);
  return basica(c, "Sin conexión al servidor de licencias — modo básico activo");
}

/**
 * Registra la licencia GRATIS del CUIT (captura email + empresa). Idempotente:
 * si el CUIT ya tiene plan superior, el servidor no lo degrada.
 */
export async function registrarLicenciaGratis(base44, { cuit, email, companyName = "", version = MODULE_TAG }) {
  const c = limpiarCuit(cuit);
  if (!c || c.length < 10) throw new Error("CUIT inválido.");
  if (!email || !email.includes("@")) throw new Error("Email inválido.");

  let resultado = { ok: false };
  try {
    const resp = await fetch(`${LICENSE_BASE}/licenses/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cuit: c, email, company_name: companyName }),
    });
    resultado = { ok: resp.ok, status: resp.status, body: await resp.json().catch(() => ({})) };
  } catch (e) {
    resultado = { ok: false, error: e.message };
  }
  // Refrescar el cache local con el estado real.
  const estado = await verificarLicencia(base44, c, { version, force: true });
  return { registro: resultado, licencia: estado };
}

/** True si el CUIT tiene plan Completo activo (para features premium futuras). */
export function tieneCompleta(estado) {
  return estado?.plan === "completa" && estado?.active === true;
}

/** True si el CUIT tiene cualquier plan pago activo (completa o mensual). */
export function esPago(estado) {
  return (estado?.plan === "completa" || estado?.plan === "monthly") && estado?.active === true;
}

// --- Wrapper HTTP ------------------------------------------------------------
// Acciones: "check" (default, cache-first), "refresh" (online forzado),
// "registrar" (alta gratis con email). Acepta emisorId o cuit directo.
if (!Deno.env.get("ARCA_NO_SERVE")) Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const admin = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const accion = body.accion || "check";

    // Resolver CUIT/email desde emisorId o del body.
    let cuit = body.cuit;
    let email = body.email;
    let companyName = body.companyName;
    if (body.emisorId) {
      const emisor = await admin.entities.ArcaEmisor.get(body.emisorId);
      if (!emisor) return Response.json({ error: "Emisor no encontrado." }, { status: 404 });
      cuit = cuit || emisor.cuit;
      email = email || emisor.email;
      companyName = companyName || emisor.razonSocial;
    }
    if (!cuit) return Response.json({ error: "Pasá emisorId o cuit." }, { status: 400 });

    if (accion === "registrar") {
      const r = await registrarLicenciaGratis(base44, { cuit, email, companyName });
      return Response.json(r);
    }
    const estado = await verificarLicencia(base44, cuit, { force: accion === "refresh" });
    return Response.json(estado);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
