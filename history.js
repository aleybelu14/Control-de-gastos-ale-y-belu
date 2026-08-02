// =====================================================================
// Historial de deshacer/rehacer. Guarda las últimas 5 acciones "de un
// click" (agregar, eliminar, editar) de gastos, gastos fijos, inventario
// y plataformas de ahorro. No registra campos de tipeo continuo (sueldos,
// saldos de cuentas, cotización) para no llenar el historial con estados
// intermedios mientras se escribe.
// =====================================================================
import { addRow, deleteRow, updateRow, restoreDoc } from "./db.js";
import { toast } from "./utils.js";

const MAX = 5;
let undoStack = [];
let redoStack = [];
let undoBtn = null, redoBtn = null;

export function initHistoryUI() {
  undoBtn = document.getElementById("undoBtn");
  redoBtn = document.getElementById("redoBtn");
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  refreshButtons();
}

function refreshButtons() {
  if (!undoBtn || !redoBtn) return;
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
  undoBtn.title = undoStack.length ? `Deshacer: ${undoStack[undoStack.length - 1].label}` : "Nada para deshacer";
  redoBtn.title = redoStack.length ? `Rehacer: ${redoStack[redoStack.length - 1].label}` : "Nada para rehacer";
}

export function pushAction(action) {
  undoStack.push(action);
  if (undoStack.length > MAX) undoStack.shift();
  redoStack = [];
  refreshButtons();
}

export async function undo() {
  const action = undoStack.pop();
  if (!action) return;
  try {
    await action.undo();
    redoStack.push(action);
    if (redoStack.length > MAX) redoStack.shift();
    toast(`Deshecho: ${action.label}`);
  } catch (err) {
    console.error(err);
    undoStack.push(action);
    toast("No se pudo deshacer");
  }
  refreshButtons();
}

export async function redo() {
  const action = redoStack.pop();
  if (!action) return;
  try {
    await action.redo();
    undoStack.push(action);
    if (undoStack.length > MAX) undoStack.shift();
    toast(`Rehecho: ${action.label}`);
  } catch (err) {
    console.error(err);
    redoStack.push(action);
    toast("No se pudo rehacer");
  }
  refreshButtons();
}

// ---- Fábricas de acciones reversibles -----------------------------------
// "Agregar": deshacer = borrar el doc creado; rehacer = volver a crearlo
// (puede tomar un id nuevo — por eso queda en una variable mutable local).
export function makeAddAction(label, colRef, data, initialId) {
  let id = initialId;
  return {
    label,
    undo: async () => { await deleteRow(colRef, id); },
    redo: async () => { const ref = await addRow(colRef, data); id = ref.id; }
  };
}

// "Eliminar": deshacer = recrear el doc tal cual estaba (mismo id);
// rehacer = borrarlo de nuevo.
export function makeDeleteAction(label, colRef, id, dataSnapshot) {
  return {
    label,
    undo: async () => { await restoreDoc(colRef, id, dataSnapshot); },
    redo: async () => { await deleteRow(colRef, id); }
  };
}

// "Editar" (incluye -1 / +agregar en inventario): deshacer = volver a los
// valores anteriores de los campos tocados; rehacer = aplicar los nuevos.
export function makeUpdateAction(label, colRef, id, dataBefore, dataAfter) {
  return {
    label,
    undo: async () => { await updateRow(colRef, id, dataBefore); },
    redo: async () => { await updateRow(colRef, id, dataAfter); }
  };
}

// Quita el campo "id" que agrega watchCollection antes de guardar un
// snapshot para restaurar (el doc original no tenía ese campo).
export function stripId(obj) {
  const { id, ...rest } = obj;
  return rest;
}
