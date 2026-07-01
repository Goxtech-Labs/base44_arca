// LicenciaBadge.jsx
// Muestra el estado de licencia del emisor (plan GoxTech) y permite registrar la
// licencia gratis (email). La emisión no se bloquea nunca: esto es informativo +
// captura del CUIT. El plan pago se comparte con FactuSol (misma licencia).
import React, { useEffect, useState } from "react";
import { licencia } from "@/api/functions";

const COLOR = {
  completa: "bg-green-100 text-green-800",
  monthly: "bg-blue-100 text-blue-800",
  basica: "bg-gray-100 text-gray-700",
};

export default function LicenciaBadge({ emisor }) {
  const [estado, setEstado] = useState(null);
  const [email, setEmail] = useState(emisor?.email || "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function cargar(accion = "check") {
    if (!emisor?.id && !emisor?.cuit) return;
    setBusy(true); setMsg(null);
    try {
      const { data } = await licencia({ accion, emisorId: emisor.id, cuit: emisor.cuit });
      if (data?.error) throw new Error(data.error);
      setEstado(data);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  useEffect(() => { cargar("check"); /* eslint-disable-next-line */ }, [emisor?.id]);

  async function registrar() {
    if (!email.includes("@")) return setMsg("Ingresá un email válido.");
    setBusy(true); setMsg(null);
    try {
      const { data } = await licencia({ accion: "registrar", emisorId: emisor.id, cuit: emisor.cuit, email });
      if (data?.error) throw new Error(data.error);
      setEstado(data.licencia);
      setMsg("Licencia gratis registrada ✓");
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  const plan = estado?.plan || "basica";
  const nombre = { completa: "Completo", monthly: "Mensual", basica: "Gratis" }[plan] || plan;

  return (
    <div className="rounded border p-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${COLOR[plan] || COLOR.basica}`}>
            Plan {nombre}
          </span>
          <span className="text-gray-600">{estado?.message || "Verificando…"}</span>
        </div>
        <button onClick={() => cargar("refresh")} disabled={busy}
          className="text-xs text-blue-600 underline disabled:opacity-50">
          {busy ? "…" : "Actualizar"}
        </button>
      </div>

      {plan === "basica" && (
        <div className="mt-3 flex items-end gap-2">
          <label className="flex-1">
            <span className="text-xs text-gray-500">Email (para registrar tu licencia gratis)</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com" className="mt-1 w-full rounded border px-2 py-1" />
          </label>
          <button onClick={registrar} disabled={busy}
            className="rounded bg-black px-3 py-1.5 text-white disabled:opacity-50">
            Registrar gratis
          </button>
        </div>
      )}

      {msg && <p className="mt-2 text-xs text-gray-600">{msg}</p>}
    </div>
  );
}
