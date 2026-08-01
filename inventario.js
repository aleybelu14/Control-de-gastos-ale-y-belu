import { col, query, orderBy, watchCollection, addRow, updateRow, deleteRow } from "./db.js";
import { fmtARS, toast } from "./utils.js";

let itemsCache = [];
let unsub = null;

export function initInventario() {
  document.getElementById("itemForm").addEventListener("submit", onAddItem);
  const q = query(col.inventario, orderBy("nombre"));
  unsub = watchCollection(q, (rows) => {
    itemsCache = rows;
    renderAll();
  });
}

async function onAddItem(e) {
  e.preventDefault();
  const data = {
    nombre: document.getElementById("i-nombre").value.trim(),
    precio: Number(document.getElementById("i-precio").value) || 0,
    capacidad: document.getElementById("i-capacidad").value.trim(),
    fechaAdquisicion: document.getElementById("i-fecha").value || null,
    cantidad: Number(document.getElementById("i-cantidad").value) || 0,
    vecesDescontado: 0
  };
  if (!data.nombre) { toast("Ingresá un nombre"); return; }
  await addRow(col.inventario, data);
  e.target.reset();
  document.getElementById("i-cantidad").value = 1;
  toast("Artículo agregado");
}

async function onMinus(item) {
  const nuevaCantidad = Math.max(0, (item.cantidad || 0) - 1);
  await updateRow(col.inventario, item.id, {
    cantidad: nuevaCantidad,
    vecesDescontado: (item.vecesDescontado || 0) + 1
  });
}

async function onDelete(id) {
  await deleteRow(col.inventario, id);
  toast("Artículo eliminado");
}

function renderAll() {
  renderListaCompras();
  renderInventario();
  renderRecambio();
}

function renderListaCompras() {
  const wrap = document.getElementById("listaCompras");
  const enLista = itemsCache.filter((i) => (i.cantidad || 0) === 1);
  if (!enLista.length) {
    wrap.innerHTML = `<div class="empty-state">Nada por reponer por ahora.</div>`;
  } else {
    wrap.innerHTML = enLista.map((i) => `
      <div class="list-row">
        <div class="list-row-main">
          <div class="list-row-title">${i.nombre}</div>
          <div class="list-row-meta">${i.capacidad || ""}</div>
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
  if (!itemsCache.length) {
    wrap.innerHTML = `<div class="empty-state">Todavía no cargaste artículos.</div>`;
    return;
  }
  wrap.innerHTML = itemsCache.map((i) => `
    <div class="inv-row ${(i.cantidad || 0) <= 1 ? "low-stock" : ""}">
      <button class="btn-minus" data-minus="${i.id}" title="Descontar 1" ${(i.cantidad || 0) <= 0 ? "disabled" : ""}>−1</button>
      <div class="inv-row-info">
        <div class="inv-row-name">${i.nombre}</div>
        <div class="inv-row-meta">${i.capacidad || ""} ${i.precio ? "· " + fmtARS(i.precio) : ""}</div>
      </div>
      <div class="inv-qty">${i.cantidad ?? 0}</div>
      <button class="btn-icon-sm" data-del="${i.id}" title="Eliminar">✕</button>
    </div>
  `).join("");
  wrap.querySelectorAll("[data-minus]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsCache.find((i) => i.id === btn.dataset.minus);
      if (item) onMinus(item);
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
