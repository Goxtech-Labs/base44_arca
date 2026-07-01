// EmisorForm.jsx
// Alta / edición de un emisor ARCA. Al guardar queda en PENDIENTE_CERT y el
// siguiente paso es el wizard de certificado.
import React, { useState } from "react";
import { ArcaEmisor } from "@/api/entities";

const CONDICIONES = [
  { v: "RI", t: "Responsable Inscripto" },
  { v: "MONOTRIBUTO", t: "Monotributo" },
  { v: "EXENTO", t: "Exento" },
];

export default function EmisorForm({ emisor, onSaved }) {
  const [form, setForm] = useState({
    cuit: emisor?.cuit || "",
    razonSocial: emisor?.razonSocial || "",
    condicionIva: emisor?.condicionIva || "RI",
    puntoVenta: emisor?.puntoVenta || 1,
    ambiente: emisor?.ambiente || "HOMOLOGACION",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function guardar(e) {
    e.preventDefault();
    setError(null);
    const cuit = String(form.cuit).replace(/\D/g, "");
    if (cuit.length !== 11) return setError("El CUIT debe tener 11 dígitos (sin guiones).");
    if (!form.razonSocial.trim()) return setError("Cargá la razón social.");
    if (!(Number(form.puntoVenta) > 0)) return setError("El punto de venta debe ser > 0.");

    setSaving(true);
    try {
      const payload = { ...form, cuit, puntoVenta: Number(form.puntoVenta) };
      const saved = emisor?.id
        ? await ArcaEmisor.update(emisor.id, payload)
        : await ArcaEmisor.create({ ...payload, estado: "PENDIENTE_CERT" });
      onSaved?.(saved || { ...emisor, ...payload });
    } catch (err) {
      setError(err?.message || "No se pudo guardar el emisor.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={guardar} className="max-w-lg space-y-4">
      <h2 className="text-xl font-semibold">Datos del emisor</h2>

      <label className="block">
        <span className="text-sm text-gray-600">CUIT (sin guiones)</span>
        <input className="mt-1 w-full rounded border px-3 py-2" value={form.cuit}
          onChange={set("cuit")} placeholder="20111111112" inputMode="numeric" />
      </label>

      <label className="block">
        <span className="text-sm text-gray-600">Razón social</span>
        <input className="mt-1 w-full rounded border px-3 py-2" value={form.razonSocial}
          onChange={set("razonSocial")} />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm text-gray-600">Condición IVA</span>
          <select className="mt-1 w-full rounded border px-3 py-2" value={form.condicionIva} onChange={set("condicionIva")}>
            {CONDICIONES.map((c) => <option key={c.v} value={c.v}>{c.t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-gray-600">Punto de venta (WSFEV1)</span>
          <input className="mt-1 w-full rounded border px-3 py-2" type="number" min="1"
            value={form.puntoVenta} onChange={set("puntoVenta")} />
        </label>
      </div>

      <label className="block">
        <span className="text-sm text-gray-600">Ambiente</span>
        <select className="mt-1 w-full rounded border px-3 py-2" value={form.ambiente} onChange={set("ambiente")}>
          <option value="HOMOLOGACION">Homologación (prueba)</option>
          <option value="PRODUCCION">Producción</option>
        </select>
      </label>

      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <button type="submit" disabled={saving}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {saving ? "Guardando…" : "Guardar emisor"}
      </button>
    </form>
  );
}
