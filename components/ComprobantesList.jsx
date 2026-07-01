// ComprobantesList.jsx
// Listado de comprobantes emitidos con acción "ver PDF".
import React, { useEffect, useState } from "react";
import { ArcaComprobante } from "@/api/entities";

const LETRA = { 1: "A", 6: "B", 11: "C", 51: "M", 2: "ND-A", 7: "ND-B", 12: "ND-C", 3: "NC-A", 8: "NC-B", 13: "NC-C" };
const BADGE = {
  APROBADO: "bg-green-100 text-green-800",
  OBSERVADO: "bg-amber-100 text-amber-800",
  RECHAZADO: "bg-red-100 text-red-800",
};

export default function ComprobantesList({ emisorId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const filtro = emisorId ? { emisorId } : undefined;
        const data = await ArcaComprobante.filter(filtro, "-created_date");
        setItems(data || []);
      } finally { setLoading(false); }
    })();
  }, [emisorId]);

  if (loading) return <p className="text-sm text-gray-500">Cargando comprobantes…</p>;
  if (!items.length) return <p className="text-sm text-gray-500">Todavía no emitiste comprobantes.</p>;

  return (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-gray-500">
        <tr>
          <th className="py-2">Tipo</th><th>Nº</th><th>Fecha</th><th>Receptor</th>
          <th className="text-right">Total</th><th>Estado</th><th>CAE</th><th></th>
        </tr>
      </thead>
      <tbody>
        {items.map((c) => (
          <tr key={c.id} className="border-b">
            <td className="py-2">{LETRA[c.tipoCbte] || c.tipoCbte}</td>
            <td>{String(c.puntoVenta).padStart(4, "0")}-{String(c.nroCbte || "").padStart(8, "0")}</td>
            <td>{c.fechaCbte}</td>
            <td>{c.docNroReceptor || "-"}</td>
            <td className="text-right">$ {Number(c.impTotal || 0).toFixed(2)}</td>
            <td><span className={`rounded px-2 py-0.5 text-xs ${BADGE[c.estado] || ""}`}>{c.estado}</span></td>
            <td className="font-mono text-xs">{c.cae || "-"}</td>
            <td className="text-right">
              {c.pdfUrl
                ? <a className="text-blue-600 underline" href={c.pdfUrl} target="_blank" rel="noreferrer">ver PDF</a>
                : <span className="text-gray-300">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
