import { col, query, orderBy, watchCollection, addRow, updateRow, deleteRow } from "./db.js";
import {
  CATEGORIAS_INVENTARIO, ESTADOS_INVENTARIO, fmtARS, fmtDate, daysBetween, todayISO, toast, notifyUpdate
} from "./utils.js";
import { pushAction, makeAddAction, makeDeleteAction, makeUpdateAction, stripId } from "./history.js";

let itemsCache = [];
let unsub = null;
let categoriaFiltro = null; // null = todas
let searchTerm = "";

export function initInventario() {
  fillSelect("i-categoria", CATEGORIAS_INVENTARIO);
  fillSelect("e-categoria", CATEGORIAS_INVENTARIO);
  fillEstadoSelect("i-estado");
  fillEstadoSelect("e-estado");
  document.getElementById("i-estado").value = "en_uso";

  document.getElementById("itemForm").addEventListener("submit", onAddItem);
  document.getElementById("inventarioSearch").addEventListener("input", (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderInventario();
  });

  // ---- Modal: editar artículo ----
  const editModal = document.getElementById("editModal");
  document.getElementById("editForm").addEventListener("submit", onSubmitEdit);
  document.getElementById("editModalClose").addEventListener("click", () => closeModal(editModal));
  document.getElementById("editModalCancel").addEventListener("click", () => closeModal(editModal));
  editModal.addEventListener("click", (e) => { if (e.target === editModal) closeModal(editModal); });

  // ---- Modal: agregar stock ----
  const addStockModal = document.getElementById("addStockModal");
  document.getElementById("addStockForm").addEventListener("submit", onSubmitAddStock);
  document.getElementById("addStockModalClose").addEventListener("click", () => closeModal(addStockModal));
  document.getElementById("addStockModalCancel").addEventListener("click", () => closeModal(addStockModal));
  addStockModal.addEventListener("click", (e) => { if (e.target === addStockModal) closeModal(addStockModal); });

  const q = query(col.inventario, orderBy("nombre"));
  unsub = watchCollection(q, (rows) => {
    itemsCache = rows;
    renderAll();
  });
}

function fillSelect(id, options) {
  const sel = document.getElementById(id);
  sel.innerHTML = options.map((o) => `<option value="${o}">${o}</option>`).join("");
}
function fillEstadoSelect(id) {
  const sel = document.getElementById(id);
  sel.innerHTML = ESTADOS_INVENTARIO.map((e) => `<option value="${e.key}">${e.label}</option>`).join("");
}

function openModal(modal) { modal.hidden = false; }
function closeModal(modal) { modal.hidden = true; }

// ---- Alta de artículo ---------------------------------------------------
async function onAddItem(e) {
  e.preventDefault();
  const fecha = document.getElementById("i-fecha").value || todayISO();
  const data = {
    nombre: document.getElementById("i-nombre").value.trim(),
    categoria: document.getElementById("i-categoria").value,
    estado: document.getElementById("i-estado").value || "en_uso",
    precio: Number(document.getElementById("i-precio").value) || 0,
    capacidad: document.getElementById("i-capacidad").value.trim(),
    fechaAdquisicion: fecha,
    cantidad: Number(document.getElementById("i-cantidad").value) || 0,
    vecesDescontado: 0,
    fechaUltimaReposicion: fecha,
    fechasAgotamiento: [],
    duraciones: [],
    historialCompras: []
  };
  if (!data.nombre) { toast("Ingresá un nombre"); return; }
  const ref = await addRow(col.inventario, data);
  pushAction(makeAddAction(`Agregar artículo: ${data.nombre}`, col.inventario, data, ref.id));
  e.target.reset();
  document.getElementById("i-cantidad").value = 1;
  document.getElementById("i-estado").value = "en_uso";
  toast("Artículo agregado");
}

// ---- Descontar 1 (registra fecha de agotamiento si llega a 0) ----------
async function onMinus(item) {
  const cantidadAnterior = item.cantidad || 0;
  const nuevaCantidad = Math.max(0, cantidadAnterior - 1);
  const before = {
    cantidad: cantidadAnterior,
    vecesDescontado: item.vecesDescontado || 0,
    fechasAgotamiento: item.fechasAgotamiento || [],
    duraciones: item.duraciones || []
  };
  const patch = {
    cantidad: nuevaCantidad,
    vecesDescontado: (item.vecesDescontado || 0) + 1
  };
  if (nuevaCantidad === 0 && cantidadAnterior > 0) {
    const hoy = todayISO();
    const fechasAgotamiento = [...(item.fechasAgotamiento || []), hoy];
    const duraciones = [...(item.duraciones || [])];
    if (item.fechaUltimaReposicion) {
      const dias = daysBetween(item.fechaUltimaReposicion, hoy);
      if (dias !== null) duraciones.push({ desde: item.fechaUltimaReposicion, hasta: hoy, dias });
    }
    patch.fechasAgotamiento = fechasAgotamiento;
    patch.duraciones = duraciones;
  }
  await updateRow(col.inventario, item.id, patch);
  const after = {
    cantidad: patch.cantidad,
    vecesDescontado: patch.vecesDescontado,
    fechasAgotamiento: patch.fechasAgotamiento || before.fechasAgotamiento,
    duraciones: patch.duraciones || before.duraciones
  };
  pushAction(makeUpdateAction(`Descontar 1: ${item.nombre}`, col.inventario, item.id, before, after));
}

async function onDelete(id) {
  const item = itemsCache.find((i) => i.id === id);
  await deleteRow(col.inventario, id);
  if (item) {
    pushAction(makeDeleteAction(`Eliminar artículo: ${item.nombre}`, col.inventario, id, stripId(item)));
  }
  toast("Artículo eliminado");
}

// ---- Mover de columna (En stock ⇄ En uso ⇄ A reponer) --------------------
async function onMoveEstado(item, dir) {
  const idx = ESTADOS_INVENTARIO.findIndex((e) => e.key === (item.estado || "en_uso"));
  const destino = ESTADOS_INVENTARIO[idx + dir];
  if (!destino) return;
  const before = { estado: item.estado || "en_uso" };
  const after = { estado: destino.key };
  await updateRow(col.inventario, item.id, after);
  pushAction(makeUpdateAction(`Mover: ${item.nombre} → ${destino.label}`, col.inventario, item.id, before, after));
}

// ---- Editar artículo (sin borrar/recargar todo) -------------------------
function onOpenEdit(item) {
  document.getElementById("e-id").value = item.id;
  document.getElementById("e-nombre").value = item.nombre || "";
  document.getElementById("e-categoria").value = item.categoria || CATEGORIAS_INVENTARIO[0];
  document.getElementById("e-estado").value = item.estado || "en_uso";
  document.getElementById("e-precio").value = item.precio || "";
  document.getElementById("e-capacidad").value = item.capacidad || "";
  document.getElementById("e-fecha").value = item.fechaAdquisicion || "";
  document.getElementById("e-cantidad").value = item.cantidad ?? 0;
  openModal(document.getElementById("editModal"));
}

async function onSubmitEdit(e) {
  e.preventDefault();
  const id = document.getElementById("e-id").value;
  const item = itemsCache.find((i) => i.id === id);
  const data = {
    nombre: document.getElementById("e-nombre").value.trim(),
    categoria: document.getElementById("e-categoria").value,
    estado: document.getElementById("e-estado").value,
    precio: Number(document.getElementById("e-precio").value) || 0,
    capacidad: document.getElementById("e-capacidad").value.trim(),
    fechaAdquisicion: document.getElementById("e-fecha").value || "",
    cantidad: Number(document.getElementById("e-cantidad").value) || 0
  };
  if (!data.nombre) { toast("Ingresá un nombre"); return; }
  await updateRow(col.inventario, id, data);
  if (item) {
    const before = {
      nombre: item.nombre || "",
      categoria: item.categoria || "",
      estado: item.estado || "en_uso",
      precio: item.precio || 0,
      capacidad: item.capacidad || "",
      fechaAdquisicion: item.fechaAdquisicion || "",
      cantidad: item.cantidad ?? 0
    };
    pushAction(makeUpdateAction(`Editar artículo: ${data.nombre}`, col.inventario, id, before, data));
  }
  closeModal(document.getElementById("editModal"));
  toast("Artículo actualizado");
}

// ---- + Agregar (reposición: registra compra en historial y estadísticas) --
function onOpenAddStock(item) {
  document.getElementById("as-id").value = item.id;
  document.getElementById("as-fecha").value = todayISO();
  document.getElementById("as-cantidad").value = 1;
  document.getElementById("as-lugar").value = "";
  document.getElementById("as-precio").value = item.precio || "";
  openModal(document.getElementById("addStockModal"));
}

async function onSubmitAddStock(e) {
  e.preventDefault();
  const id = document.getElementById("as-id").value;
  const item = itemsCache.find((i) => i.id === id);
  if (!item) return;
  const fecha = document.getElementById("as-fecha").value || todayISO();
  const cantidadAgregar = Number(document.getElementById("as-cantidad").value) || 0;
  const lugar = document.getElementById("as-lugar").value.trim();
  const precio = Number(document.getElementById("as-precio").value) || 0;
  if (!cantidadAgregar) { toast("Ingresá una cantidad"); return; }

  const historialCompras = [...(item.historialCompras || []), { fecha, cantidad: cantidadAgregar, lugar, precio }];
  const before = {
    cantidad: item.cantidad || 0,
    precio: item.precio || 0,
    estado: item.estado || "en_uso",
    fechaAdquisicion: item.fechaAdquisicion || "",
    fechaUltimaReposicion: item.fechaUltimaReposicion || "",
    historialCompras: item.historialCompras || []
  };
  const after = {
    cantidad: (item.cantidad || 0) + cantidadAgregar,
    precio: precio || item.precio || 0,
    estado: "en_uso", // al reponerlo, vuelve a estar en uso
    fechaAdquisicion: fecha,
    fechaUltimaReposicion: fecha,
    historialCompras
  };
  await updateRow(col.inventario, id, after);
  pushAction(makeUpdateAction(`Agregar stock: ${item.nombre}`, col.inventario, id, before, after));
  closeModal(document.getElementById("addStockModal"));
  toast("Compra registrada");
}

// ---- Render ---------------------------------------------------------------
function renderAll() {
  renderChips();
  renderBoard();
  renderRecambio();
  renderDuracion();
  notifyUpdate();
}

export function getListaComprasCount() {
  return itemsCache.filter((i) => (i.cantidad || 0) <= 1).length;
}

function renderChips() {
  const catWrap = document.getElementById("categoriaChips");
  const categoriasUsadas = CATEGORIAS_INVENTARIO.filter((c) => itemsCache.some((i) => (i.categoria || "Otro") === c));
  const catChips = ["Todas", ...categoriasUsadas];
  catWrap.innerHTML = catChips.map((c) => {
    const active = (c === "Todas" && !categoriaFiltro) || c === categoriaFiltro;
    return `<button type="button" class="chip ${active ? "active" : ""}" data-chip="${c}">${c}</button>`;
  }).join("");
  catWrap.querySelectorAll("[data-chip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      categoriaFiltro = btn.dataset.chip === "Todas" ? null : btn.dataset.chip;
      renderAll();
    });
  });
}

function itemCard(i) {
  const cant = i.cantidad ?? 0;
  const stockClase = cant === 0 ? "out-stock" : cant === 1 ? "low-stock" : ""; // verde (2+) / amarillo (1) / rojo (0)
  const idx = ESTADOS_INVENTARIO.findIndex((e) => e.key === (i.estado || "en_uso"));
  const prev = ESTADOS_INVENTARIO[idx - 1];
  const next = ESTADOS_INVENTARIO[idx + 1];
  return `
    <div class="inv-card ${stockClase}">
      <div class="inv-card-top">
        <span class="inv-card-name">${i.nombre}</span>
        <span class="inv-qty">${cant}</span>
      </div>
      <div class="inv-card-meta">
        ${i.categoria ? `<span class="tag">${i.categoria}</span>` : ""}${i.capacidad || ""} ${i.precio ? "· " + fmtARS(i.precio) : ""}
      </div>
      <div class="inv-card-actions">
        <button class="btn-minus" data-minus="${i.id}" title="Descontar 1" ${cant <= 0 ? "disabled" : ""}>−1</button>
        <button class="btn-plus" data-add="${i.id}" title="Agregar (registrar compra)">+</button>
        <button class="btn-icon-sm edit" data-edit="${i.id}" title="Editar">✎</button>
        <button class="btn-icon-sm" data-del="${i.id}" title="Eliminar">✕</button>
        <span class="inv-move">
          <button class="btn-outline small" data-move="${i.id}" data-dir="-1" ${prev ? "" : "disabled"} title="${prev ? "Mover a " + prev.label : ""}">←</button>
          <button class="btn-outline small" data-move="${i.id}" data-dir="1" ${next ? "" : "disabled"} title="${next ? "Mover a " + next.label : ""}">→</button>
        </span>
      </div>
    </div>
  `;
}

function renderBoard() {
  const board = document.getElementById("inventarioBoard");
  let lista = itemsCache;
  if (categoriaFiltro) lista = lista.filter((i) => (i.categoria || "Otro") === categoriaFiltro);
  if (searchTerm) lista = lista.filter((i) => (i.nombre || "").toLowerCase().includes(searchTerm) || (i.categoria || "").toLowerCase().includes(searchTerm));

  board.innerHTML = ESTADOS_INVENTARIO.map((est) => {
    const items = lista.filter((i) => (i.estado || "en_uso") === est.key);
    return `
      <div class="inv-column">
        <div class="inv-column-head">
          <span>${est.label}</span>
          <span class="tag ${est.tagClass}">${items.length}</span>
        </div>
        <div class="inv-column-body">
          ${items.length ? items.map(itemCard).join("") : `<div class="empty-state">${searchTerm || categoriaFiltro ? "Nada acá con ese filtro." : "Nada acá."}</div>`}
        </div>
      </div>
    `;
  }).join("");

  board.querySelectorAll("[data-minus]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsCache.find((i) => i.id === btn.dataset.minus);
      if (item) onMinus(item);
    });
  });
  board.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsCache.find((i) => i.id === btn.dataset.add);
      if (item) onOpenAddStock(item);
    });
  });
  board.querySelectorAll("[data-move]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsCache.find((i) => i.id === btn.dataset.move);
      if (item) onMoveEstado(item, Number(btn.dataset.dir));
    });
  });
  board.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsCache.find((i) => i.id === btn.dataset.edit);
      if (item) onOpenEdit(item);
    });
  });
  board.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => onDelete(btn.dataset.del));
  });
}

function renderRecambio() {
  const wrap = document.getElementById("recambioStats");
  const top = [...itemsCache].filter((i) => (i.vecesDescontado || 0) > 0)
    .sort((a, b) => (b.vecesDescontado || 0) - (a.vecesDescontado || 0))
    .slice(0, 6);
  if (!top.length) { wrap.innerHTML = `<div class="empty-state">Todavía no hay historial de consumo.</div>`; return; }
  const max = top[0].vecesDescontado || 1;
  wrap.innerHTML = top.map((i) => `
    <div class="stat-bar-row">
      <div class="stat-bar-labels"><span>${i.nombre}</span><span>${i.vecesDescontado} veces</span></div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${(i.vecesDescontado / max) * 100}%"></div></div>
    </div>
  `).join("");
}

function renderDuracion() {
  const wrap = document.getElementById("duracionStats");
  const conDuracion = itemsCache
    .map((i) => {
      const dur = i.duraciones || [];
      if (!dur.length) return null;
      const promedio = dur.reduce((s, d) => s + (d.dias || 0), 0) / dur.length;
      return { nombre: i.nombre, promedio };
    })
    .filter(Boolean)
    .sort((a, b) => a.promedio - b.promedio)
    .slice(0, 6);
  if (!conDuracion.length) {
    wrap.innerHTML = `<div class="empty-state">Todavía no hay ciclos completos (repone → se agota) para medir.</div>`;
    return;
  }
  const max = Math.max(...conDuracion.map((i) => i.promedio), 1);
  wrap.innerHTML = conDuracion.map((i) => `
    <div class="stat-bar-row">
      <div class="stat-bar-labels"><span>${i.nombre}</span><span>${i.promedio.toFixed(0)} días</span></div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${(i.promedio / max) * 100}%"></div></div>
    </div>
  `).join("");
}
