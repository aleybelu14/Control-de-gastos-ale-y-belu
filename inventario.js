import { col, query, orderBy, watchCollection, addRow, updateRow, deleteRow } from "./db.js";
import {
  CATEGORIAS_INVENTARIO, fmtARS, fmtDate, daysBetween, todayISO, toast, notifyUpdate
} from "./utils.js";
import { pushAction, makeAddAction, makeDeleteAction, makeUpdateAction, stripId } from "./history.js";

let itemsCache = [];
let unsub = null;
let categoriaFiltro = null; // null = todas

export function initInventario() {
  fillSelect("i-categoria", CATEGORIAS_INVENTARIO);
  fillSelect("e-categoria", CATEGORIAS_INVENTARIO);

  document.getElementById("itemForm").addEventListener("submit", onAddItem);

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

function openModal(modal) { modal.hidden = false; }
function closeModal(modal) { modal.hidden = true; }

// ---- Alta de artículo ---------------------------------------------------
async function onAddItem(e) {
  e.preventDefault();
  const fecha = document.getElementById("i-fecha").value || todayISO();
  const data = {
    nombre: document.getElementById("i-nombre").value.trim(),
    categoria: document.getElementById("i-categoria").value,
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

// ---- Editar artículo (sin borrar/recargar todo) -------------------------
function onOpenEdit(item) {
  document.getElementById("e-id").value = item.id;
  document.getElementById("e-nombre").value = item.nombre || "";
  document.getElementById("e-categoria").value = item.categoria || CATEGORIAS_INVENTARIO[0];
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
    fechaAdquisicion: item.fechaAdquisicion || "",
    fechaUltimaReposicion: item.fechaUltimaReposicion || "",
    historialCompras: item.historialCompras || []
  };
  const after = {
    cantidad: (item.cantidad || 0) + cantidadAgregar,
    precio: precio || item.precio || 0,
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
  renderListaCompras();
  renderInventario();
  renderRecambio();
  renderDuracion();
  notifyUpdate();
}

export function getListaComprasCount() {
  return itemsCache.filter((i) => (i.cantidad || 0) <= 1).length;
}

function renderChips() {
  const wrap = document.getElementById("categoriaChips");
  const categoriasUsadas = CATEGORIAS_INVENTARIO.filter((c) => itemsCache.some((i) => (i.categoria || "Otro") === c));
  const chips = ["Todas", ...categoriasUsadas];
  wrap.innerHTML = chips.map((c) => {
    const active = (c === "Todas" && !categoriaFiltro) || c === categoriaFiltro;
    return `<button type="button" class="chip ${active ? "active" : ""}" data-chip="${c}">${c}</button>`;
  }).join("");
  wrap.querySelectorAll("[data-chip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      categoriaFiltro = btn.dataset.chip === "Todas" ? null : btn.dataset.chip;
      renderAll();
    });
  });
}

function renderListaCompras() {
  const wrap = document.getElementById("listaCompras");
  const enLista = itemsCache.filter((i) => (i.cantidad || 0) <= 1);
  if (!enLista.length) {
    wrap.innerHTML = `<div class="empty-state">Nada por reponer por ahora.</div>`;
  } else {
    wrap.innerHTML = enLista.map((i) => `
      <div class="list-row">
        <div class="list-row-main">
          <div class="list-row-title"><span class="tag red">${(i.cantidad || 0) === 0 ? "Sin stock" : "Último"}</span>${i.nombre}</div>
          <div class="list-row-meta">${i.categoria || ""} ${i.capacidad ? "· " + i.capacidad : ""}</div>
        </div>
        <span class="list-row-amount">${fmtARS(i.precio)}</span>
      </div>
    `).join("");
  }
  const costo = enLista.reduce((s, i) => s + (i.precio || 0), 0);
  document.getElementById("out-costoReposicion").textContent = fmtARS(costo);
}

function renderInventario() {
  const wrap = document.getElementById("inventarioList");
  const lista = categoriaFiltro ? itemsCache.filter((i) => (i.categoria || "Otro") === categoriaFiltro) : itemsCache;
  if (!lista.length) {
    wrap.innerHTML = `<div class="empty-state">Todavía no cargaste artículos.</div>`;
    return;
  }
  wrap.innerHTML = lista.map((i) => {
    const cant = i.cantidad ?? 0;
    const estado = cant === 0 ? "out-stock" : cant === 1 ? "low-stock" : "";
    return `
    <div class="inv-row ${estado}">
      <button class="btn-minus" data-minus="${i.id}" title="Descontar 1" ${cant <= 0 ? "disabled" : ""}>−1</button>
      <button class="btn-plus" data-add="${i.id}" title="Agregar (registrar compra)">+</button>
      <div class="inv-row-info">
        <div class="inv-row-name">${i.nombre}</div>
        <div class="inv-row-meta">
          ${i.categoria ? `<span class="tag">${i.categoria}</span>` : ""}${i.capacidad || ""} ${i.precio ? "· " + fmtARS(i.precio) : ""}
          ${i.fechaAdquisicion ? "· desde " + fmtDate(i.fechaAdquisicion) : ""}
        </div>
      </div>
      <div class="inv-qty">${cant}</div>
      <div class="inv-actions">
        <button class="btn-icon-sm edit" data-edit="${i.id}" title="Editar">✎</button>
        <button class="btn-icon-sm" data-del="${i.id}" title="Eliminar">✕</button>
      </div>
    </div>
  `;
  }).join("");
  wrap.querySelectorAll("[data-minus]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsCache.find((i) => i.id === btn.dataset.minus);
      if (item) onMinus(item);
    });
  });
  wrap.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsCache.find((i) => i.id === btn.dataset.add);
      if (item) onOpenAddStock(item);
    });
  });
  wrap.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsCache.find((i) => i.id === btn.dataset.edit);
      if (item) onOpenEdit(item);
    });
  });
  wrap.querySelectorAll("[data-del]").forEach((btn) => {
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
