import { col, query, where, orderBy, watchCollection, addRow, upsertDoc } from "./db.js";
import { monthId, shiftMonth, monthLabel, fmtARS, debounce, toast } from "./utils.js";
import { getCotizacion } from "./gastos.js";
import { pushAction, makeAddAction } from "./history.js";

let currentMonthAh = monthId();
let plataformas = [];
let saldos = {}; // plataformaId -> {inicio, fin, movimientos}
let unsubPlataformas = null, unsubSaldos = null;

export function initAhorros() {
  document.getElementById("prevMonthAh").addEventListener("click", () => switchMonth(shiftMonth(currentMonthAh, -1)));
  document.getElementById("nextMonthAh").addEventListener("click", () => switchMonth(shiftMonth(currentMonthAh, 1)));
  document.getElementById("plataformaForm").addEventListener("submit", onAddPlataforma);

  unsubPlataformas = watchCollection(query(col.plataformas, orderBy("nombre")), (rows) => {
    plataformas = rows;
    renderGrid();
  });

  switchMonth(currentMonthAh);
}

async function onAddPlataforma(e) {
  e.preventDefault();
  const nombre = document.getElementById("p-nombre").value.trim();
  const moneda = document.getElementById("p-moneda").value;
  if (!nombre) return;
  const ref = await addRow(col.plataformas, { nombre, moneda });
  pushAction(makeAddAction(`Agregar plataforma: ${nombre}`, col.plataformas, { nombre, moneda }, ref.id));
  e.target.reset();
  toast("Plataforma agregada");
}

function switchMonth(mesId) {
  currentMonthAh = mesId;
  document.getElementById("monthLabelAh").textContent = monthLabel(mesId);
  if (unsubSaldos) unsubSaldos();
  const q = query(col.saldos, where("mes", "==", mesId));
  unsubSaldos = watchCollection(q, (rows) => {
    saldos = {};
    rows.forEach((r) => (saldos[r.plataformaId] = r));
    renderGrid();
  });
}

function saveSaldo(plataformaId, field, value) {
  const num = Number(value) || 0;
  const prev = saldos[plataformaId] || {};
  const data = { mes: currentMonthAh, plataformaId, inicio: prev.inicio || 0, fin: prev.fin || 0, movimientos: prev.movimientos || 0 };
  data[field] = num;
  saldos[plataformaId] = data;
  const id = `${currentMonthAh}__${plataformaId}`;
  upsertDoc(col.saldos, id, data);
  renderTotales();
}

function renderGrid() {
  const wrap = document.getElementById("ahorrosGrid");
  if (!plataformas.length) {
    wrap.innerHTML = `<div class="empty-state">Agregá una plataforma para empezar (Efectivo, Cuenta bancaria, Broker/PPI...).</div>`;
    renderTotales();
    return;
  }
  wrap.innerHTML = plataformas.map((p) => {
    const s = saldos[p.id] || { inicio: 0, fin: 0, movimientos: 0 };
    const ganancia = (s.fin || 0) - (s.inicio || 0) - (s.movimientos || 0);
    const rendimiento = s.inicio ? (ganancia / s.inicio) * 100 : 0;
    const cls = ganancia >= 0 ? "positive" : "negative";
    return `
      <div class="ahorro-card">
        <div class="ahorro-card-head">
          <h3>${p.nombre}</h3>
          <span class="tag">${p.moneda}</span>
        </div>
        <div class="ahorro-fields">
          <div class="field-row">
            <label>Inicio</label>
            <input type="number" step="0.01" inputmode="decimal" data-field="inicio" data-pid="${p.id}" value="${s.inicio || 0}">
          </div>
          <div class="field-row">
            <label>Fin</label>
            <input type="number" step="0.01" inputmode="decimal" data-field="fin" data-pid="${p.id}" value="${s.fin || 0}">
          </div>
          <div class="field-row">
            <label>Aportes/retiros netos</label>
            <input type="number" step="0.01" inputmode="decimal" data-field="movimientos" data-pid="${p.id}" value="${s.movimientos || 0}">
          </div>
        </div>
        <div class="ahorro-result">
          <span>Ganancia: <span class="${cls}">${p.moneda === "USD" ? "US$" : "$"}${ganancia.toLocaleString("es-AR", { maximumFractionDigits: 2 })}</span></span>
          <span>Rendimiento: <span class="${cls}">${rendimiento.toFixed(2)}%</span></span>
        </div>
      </div>
    `;
  }).join("");

  wrap.querySelectorAll("input[data-field]").forEach((input) => {
    input.addEventListener("input", debounce((e) => {
      saveSaldo(e.target.dataset.pid, e.target.dataset.field, e.target.value);
      renderGrid();
    }, 600));
  });

  renderTotales();
}

function toARS(monto, moneda) {
  return moneda === "USD" ? (monto || 0) * getCotizacion() : (monto || 0);
}

function renderTotales() {
  let inicioTotal = 0, finTotal = 0, movTotal = 0;
  plataformas.forEach((p) => {
    const s = saldos[p.id] || { inicio: 0, fin: 0, movimientos: 0 };
    inicioTotal += toARS(s.inicio, p.moneda);
    finTotal += toARS(s.fin, p.moneda);
    movTotal += toARS(s.movimientos, p.moneda);
  });
  const rendimiento = inicioTotal ? ((finTotal - inicioTotal - movTotal) / inicioTotal) * 100 : 0;
  document.getElementById("out-patrimonioInicio").textContent = fmtARS(inicioTotal);
  document.getElementById("out-patrimonioFin").textContent = fmtARS(finTotal);
  document.getElementById("out-rendimientoMes").textContent = rendimiento.toFixed(2) + "%";
}
