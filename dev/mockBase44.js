// dev/mockBase44.js
// Cliente Base44 falso para test local: entidades en memoria + storage falso.
// Reproduce la API que usa el módulo: entities.X.{create,get,filter,update,delete}
// y integrations.Core.UploadFile.

let seq = 1;
const nextId = () => `id_${seq++}`;

function coleccion() {
  const store = new Map();
  return {
    async create(obj) {
      const id = obj.id || nextId();
      const rec = { id, created_date: new Date().toISOString(), ...obj, id };
      store.set(id, rec);
      return { ...rec };
    },
    async get(id) {
      const r = store.get(id);
      return r ? { ...r } : null;
    },
    async filter(query, _sort) {
      const q = query || {};
      const out = [];
      for (const r of store.values()) {
        if (Object.entries(q).every(([k, v]) => r[k] === v)) out.push({ ...r });
      }
      return out;
    },
    async update(id, patch) {
      const r = store.get(id);
      if (!r) throw new Error(`update: no existe ${id}`);
      const upd = { ...r, ...patch, id };
      store.set(id, upd);
      return { ...upd };
    },
    async delete(id) {
      store.delete(id);
      return { ok: true };
    },
    _all: () => [...store.values()],
  };
}

export function createMockBase44({ onUpload } = {}) {
  const entities = {
    ArcaEmisor: coleccion(),
    ArcaTokenCache: coleccion(),
    ArcaComprobante: coleccion(),
    ArcaLicencia: coleccion(),
  };
  const uploads = [];
  const client = {
    asServiceRole: { entities },
    entities, // por si algún código lo usa sin asServiceRole
    integrations: {
      Core: {
        async UploadFile({ file }) {
          const bytes = file && file.arrayBuffer ? new Uint8Array(await file.arrayBuffer()).length : 0;
          const rec = { name: file?.name || "archivo.pdf", bytes };
          uploads.push(rec);
          onUpload?.(rec);
          return { file_url: `https://mock.storage/${rec.name}`, bytes };
        },
      },
    },
    _uploads: uploads,
  };
  return client;
}
