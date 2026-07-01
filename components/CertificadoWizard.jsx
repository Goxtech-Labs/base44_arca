// CertificadoWizard.jsx
// Wizard de certificado: (1) generar CSR -> descargar, (2) subir a ARCA (fuera
// del módulo), (3) pegar el .crt -> emisor ACTIVO.
import React, { useState } from "react";
import { generarCertificado, cargarCertificado } from "@/api/functions";

function descargar(nombre, contenido) {
  const blob = new Blob([contenido], { type: "application/x-pem-file" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombre; a.click();
  URL.revokeObjectURL(url);
}

export default function CertificadoWizard({ emisor, onActivo }) {
  const [csr, setCsr] = useState(null);
  const [crt, setCrt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);

  async function generar() {
    setError(null); setBusy(true);
    try {
      const { data } = await generarCertificado({ emisorId: emisor.id });
      if (data?.error) throw new Error(data.error);
      setCsr(data.csrPem);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function cargar() {
    setError(null); setBusy(true);
    try {
      const { data } = await cargarCertificado({ emisorId: emisor.id, crt });
      if (data?.error) throw new Error(data.error);
      setOk(data);
      onActivo?.(data);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const esActivo = emisor?.estado === "ACTIVO" || ok;

  return (
    <div className="max-w-xl space-y-6">
      <h2 className="text-xl font-semibold">Certificado ARCA</h2>

      {/* Paso 1 */}
      <section className="rounded border p-4">
        <h3 className="font-medium">1 · Generar el pedido de certificado (CSR)</h3>
        <p className="mt-1 text-sm text-gray-600">
          El módulo crea tu clave privada (encriptada, nunca se muestra) y el CSR.
        </p>
        <button onClick={generar} disabled={busy}
          className="mt-3 rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Generando…" : "Generar CSR"}
        </button>
        {csr && (
          <div className="mt-3">
            <button onClick={() => descargar(`${emisor.cuit}.csr`, csr)}
              className="rounded border px-3 py-1.5 text-sm">Descargar CSR</button>
            <textarea readOnly value={csr} className="mt-2 h-28 w-full rounded border p-2 font-mono text-xs" />
          </div>
        )}
      </section>

      {/* Paso 2 */}
      <section className="rounded border p-4">
        <h3 className="font-medium">2 · Subilo a ARCA y bajá el .crt</h3>
        <ul className="mt-1 list-disc pl-5 text-sm text-gray-600">
          <li><b>Homologación:</b> WSASS → subir CSR → generar cert de testing → asociar a servicio <code>wsfe</code>.</li>
          <li><b>Producción:</b> Adm. de Certificados → subir CSR → bajar .crt → Adm. de Relaciones (WSFE).</li>
        </ul>
      </section>

      {/* Paso 3 */}
      <section className="rounded border p-4">
        <h3 className="font-medium">3 · Cargar el certificado (.crt)</h3>
        <textarea value={crt} onChange={(e) => setCrt(e.target.value)}
          placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
          className="mt-2 h-28 w-full rounded border p-2 font-mono text-xs" />
        <button onClick={cargar} disabled={busy || !crt.trim()}
          className="mt-3 rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Validando…" : "Cargar certificado"}
        </button>
      </section>

      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {esActivo && <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-700">✓ Emisor ACTIVO. Ya podés emitir.</p>}
    </div>
  );
}
