// =====================================================================
// Inicialización de Firebase + helpers finos sobre Firestore.
// SDK modular v10, importado directo desde CDN (sin build step, para
// poder alojar todo esto en GitHub Pages tal cual).
// =====================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const dbase = getFirestore(app);

// ---- Colecciones ----------------------------------------------------
export const col = {
  meses: collection(dbase, "meses"),
  cuentas: collection(dbase, "cuentas"),
  gastos: collection(dbase, "gastos"),
  gastosFijos: collection(dbase, "gastos_fijos"),
  inventario: collection(dbase, "inventario"),
  plataformas: collection(dbase, "ahorros_plataformas"),
  saldos: collection(dbase, "ahorros_saldos"),
  config: collection(dbase, "config")
};

// ---- Genéricos --------------------------------------------------------
export function watchDoc(colRef, id, cb) {
  return onSnapshot(doc(colRef, id), (snap) => cb(snap.exists() ? snap.data() : null, snap));
}
export function watchCollection(q, cb) {
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    cb(rows);
  });
}
export async function upsertDoc(colRef, id, data) {
  return setDoc(doc(colRef, id), data, { merge: true });
}
export async function addRow(colRef, data) {
  return addDoc(colRef, { ...data, createdAt: serverTimestamp() });
}
export async function updateRow(colRef, id, data) {
  return updateDoc(doc(colRef, id), data);
}
export async function deleteRow(colRef, id) {
  return deleteDoc(doc(colRef, id));
}
export async function getDocOnce(colRef, id) {
  const snap = await getDoc(doc(colRef, id));
  return snap.exists() ? snap.data() : null;
}

export { doc, query, where, orderBy, serverTimestamp };
