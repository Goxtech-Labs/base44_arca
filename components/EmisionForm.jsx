// EmisionForm.jsx
// Formulario de emisión con validación en vivo (llama a validarComprobante) y
// emisión (emitirFactura). Calcula IVA y total a partir del neto + alícuota.
import React, { useEffect, useMemo, useState } from "react";
import { validarComprobante, emitirFactura } from "@/api/functions";

const IVA_OPCIONES = [
  { id: 5, t: "21%", pct: 21 },
  { id: 4, t: "10,5%", pct: 10.5 },
  { id: 6, t: "27%", pct: 27 },
  { id: 8, t: "5%", pct: 5 },
  { id: 9, t: "2,5%", pct: 2.5 },
  { id: 3, t: "0%", pct: 0 },
];

const COND_RECEPTOR = [
  { v: 1, t: "Responsable Inscripto" },
  { v: 6, t: "Monotributo" },
  { v: 4, t: "Exento" },
  { v: 5, t: "Consumidor Final" },
];

const DOC_TIPOS = [
  { v: 80, t: "CUIT" },
  { v: 96, t: "DNI" },
  { v: 99, t: "Consumidor Final (sin id)" },
];

export default function EmisionForm({ emisor, onEmitido }) {
  const esC = emisor?.condicionIva === "MONOTRIBUTO" || emisor?.condicionIva === "EXENTO";
  const [f, setF] = useState({
    concepto: 1,
    docTipoReceptor: 99,
    docNroReceptor: "",
    condicionIvaReceptorId: 5,
    neto: "",
    ivaId: 5,
    fechaCbte: new Date().toISOString().slice(0, 10),
  });
  const [val, setVal] = useState({ valido: true, errores: [] });
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState(null);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  // Cálculo de importes.
  const calc = useMemo(() => {
    const neto = Number(f.neto || 0);
    const pct = IVA_OPCIONES.find((o) => o.id === Number(f.ivaId))?.pct ?? 0;
    if (esC) {
      return { impNeto: 0, impIva: 0, impTotal: Math.round(neto * 100) / 100, alicuotasIva: [] };
    }
    const impIva = Math.round(neto * (pct / 100) * 100) / 100;
    return {
      impNeto: neto,
      impIva,
      impTotal: Math.round((neto + impIva) * 100) / 100,
      alicuotasIva: pct >= 0 ? [{ id: Number(f.ivaId), baseImp: neto, importe: impIva }] : [],
    };
  }, [f.neto, f.ivaId, esC]);

  const payload = useMemo(() => ({
    emisorId: emisor?.id,
    concepto: Number(f.concepto),
    docTipoReceptor: Number(f.docTipoReceptor),
    docNroReceptor: f.docNroReceptor,
    condicionIvaReceptorId: Number(f.condicionIvaReceptorId),
    ...calc,
    moneda: "PES",
    cotizacion: 1,
    fechaCbte: f.fechaCbte,
  }), [emisor?.id, f, calc]);

  // Validación en vivo (debounce).
  useEffect(() => {
    if (!emisor?.id || !f.neto) return;
    const t = setTimeout(async () => {
      try {
        const { data } = await validarComprobante(payload);
        if (data && !data.error) setVal(data);
      } catch { /* silencioso */ }
    }, 400);
    return () => clearTimeout(t);
  }, [payload, emisor?.id, f.neto]);

  async function emitir(e) {
    e.preventDefault();
    setBusy(true); setResultado(null);
    try {
      const { data } = await emitirFactura(payload);
      setResultado(data);
      if (data?.ok) onEmitido?.(data.comprobante);
    } catch (err) {
      setResultado({ ok: false, errores: [err.message] });
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={emitir} className="max-w-2xl space-y-4">
      <h2 className="text-xl font-semibold">Emitir comprobante</h2>
      {esC && <p className="text-sm text-gray-600">Emisor {emisor.condicionIva}: se emite Factura C (sin discriminar IVA).</p>}

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm text-gray-600">Concepto</span>
          <select className="mt-1 w-full rounded border px-3 py-2" value={f.concepto} onChange={set("concepto")}>
            <option value={1}>Productos</option>
            <option value={2}>Servicios</option>
            <option value={3}>Productos y Servicios</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-gray-600">Fecha</span>
          <input type="date" className="mt-1 w-full rounded border px-3 py-2" value={f.fechaCbte} onChange={set("fechaCbte")} />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <label className="block">
          <span className="text-sm text-gray-600">Tipo doc receptor</span>
          <select className="mt-1 w-full rounded border px-3 py-2" value={f.docTipoReceptor} onChange={set("docTipoReceptor")}>
            {DOC_TIPOS.map((d) => <option key={d.v} value={d.v}>{d.t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-gray-600">Nro documento</span>
          <input className="mt-1 w-full rounded border px-3 py-2" value={f.docNroReceptor} onChange={set("docNroReceptor")} />
        </label>
        <label className="block">
          <span className="text-sm text-gray-600">Cond. IVA receptor</span>
          <select className="mt-1 w-full rounded border px-3 py-2" value={f.condicionIvaReceptorId} onChange={set("condicionIvaReceptorId")}>
            {COND_RECEPTOR.map((c) => <option key={c.v} value={c.v}>{c.t}</option>)}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm text-gray-600">{esC ? "Importe total" : "Neto gravado"}</span>
          <input type="number" step="0.01" className="mt-1 w-full rounded border px-3 py-2" value={f.neto} onChange={set("neto")} />
        </label>
        {!esC && (
          <label className="block">
            <span className="text-sm text-gray-600">Alícuota IVA</span>
            <select className="mt-1 w-full rounded border px-3 py-2" value={f.ivaId} onChange={set("ivaId")}>
              {IVA_OPCIONES.map((o) => <option key={o.id} value={o.id}>{o.t}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="rounded bg-gray-50 p-3 text-sm">
        <div className="flex justify-between"><span>Neto</span><span>$ {calc.impNeto.toFixed(2)}</span></div>
        <div className="flex justify-between"><span>IVA</span><span>$ {calc.impIva.toFixed(2)}</span></div>
        <div className="flex justify-between font-semibold"><span>Total</span><span>$ {calc.impTotal.toFixed(2)}</span></div>
      </div>

      {val.errores?.length > 0 && (
        <ul className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {val.errores.map((e, i) => <li key={i}>• {e}</li>)}
        </ul>
      )}

      <button type="submit" disabled={busy || !val.valido || !f.neto}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {busy ? "Emitiendo…" : "Emitir y obtener CAE"}
      </button>

      {resultado && (
        <div className={`rounded px-3 py-2 text-sm ${resultado.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
          {resultado.ok ? (
            <>✓ {resultado.estado} · CAE {resultado.comprobante?.cae} (vto {resultado.comprobante?.caeVencimiento})
              {resultado.comprobante?.pdfUrl && <> · <a className="underline" href={resultado.comprobante.pdfUrl} target="_blank" rel="noreferrer">ver PDF</a></>}</>
          ) : (
            <>✗ No se emitió: {(resultado.errores || resultado.observaciones || []).map((x) => x.msg || x).join(" | ")}</>
          )}
        </div>
      )}
    </form>
  );
}
