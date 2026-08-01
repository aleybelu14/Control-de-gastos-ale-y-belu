import { col, query, where, orderBy, watchDoc, watchCollection, upsertDoc, addRow, deleteRow, getDocOnce } from "./db.js";
import {
  CATEGORIAS, FORMAS_PAGO, CUENTAS_FIJAS, slug, monthId, shiftMonth, monthLabel,
  fmtARS, fmtUSD, debounce, toast
} from "./utils.js";

let currentMonth = monthId();
let cotizacion = 1000;
let mesData = {};
let cuentasData = {};      // nombre -> saldo
let gastosCache = [];
let unsubMes = null, unsubCuentas = null, unsubGastos = null;

export function getCotizacion() { return cotizacion; }
export function setCotizacion(v) { cotizacion = v || 1; render(); }

export function initGastos() {
  fillSelect("g-categoria", CATEGORIAS);
  fillSelect("g-formaPago", FORMAS_PAGO);
  document.getElementById("g-fecha").value = new Date().toISOString().slice(0, 10);

  document.getElementById("prevMonth").addEventListener("click", () => switchMonth(shiftMonth(currentMonth, -1)));
  document.getElementById("nextMonth").addEventListener("click", () => switchMonth(shiftMonth(currentMonth, 1)));

  ["in-sueldoAlejo", "in-sueldoBelen", "in-sobrante", "in-reintegros", "in-extra"].forEach((id) => {
    document.getElementById(id).addEventListener("input", debounce(saveIngresos, 500));
  });

  document.getElementById("gastoForm").addEventListener("submit", onAddGasto);

  switchMonth(currentMonth);
}

function fillSelect(id, options) {
  const sel = document.getElementById(id);
  sel.innerHTML = options.map((o) => `<option value="${o}">${o}</option>`).join("");
}

async function switchMonth(mesId) {
  currentMonth = mesId;
  document.getElementById("monthLabel").textContent = monthLabel(mesId);

  if (unsubMes) unsubMes();
  if (unsubCuentas) unsubCuentas();
  if (unsubGastos) unsubGastos();

  unsubMes = watchDoc(col.meses, mesId, async (data) => {
    mesData = data || {};
    document.getElementById("in-sueldoAlejo").value = mesData.sueldoAlejo ?? "";
    document.getElementById("in-sueldoBelen").value = mesData.sueldoBelen ?? "";
    document.getElementById("in-reintegros").value = mesData.reintegros ?? "";
    document.getElementById("in-extra").value = mesData.extra ?? "";

    if (mesData.sobranteAnterior === undefined || mesData.sobranteAnterior === null) {
      const sugerido = await computeDisponibleAnterior(mesId);
      document.getElementById("in-sobrante").value = sugerido || "";
      document.getElementById("sobranteAuto").textContent = sugerido ? `calculado del mes anterior: ${fmtARS(sugerido)}` : "";
      if (sugerido) saveIngresos(); // persistir el cierre automático del mes previo
    } else {
      document.getElementById("in-sobrante").value = mesData.sobranteAnterior;
      document.getElementById("sobranteAuto").textContent = "";
    }
    render();
  });

  cuentasData = {};
  CUENTAS_FIJAS.forEach((c) => (cuentasData[c] = 0));
  renderCuentas(); // paint inputs immediately, values fill in as snapshot arrives

  const qCuentas = query(col.cuentas, where("mes", "==", mesId));
  unsubCuentas = watchCollection(qCuentas, (rows) => {
    cuentasData = {};
    CUENTAS_FIJAS.forEach((c) => (cuentasData[c] = 0));
    rows.forEach((r) => (cuentasData[r.nombre] = r.saldo || 0));
    renderCuentas();
    render();
  });

  const qGastos = query(col.gastos, where("mes", "==", mesId), orderBy("fecha", "desc"));
  unsubGastos = watchCollection(qGastos, (rows) => {
    gastosCache = rows;
    renderGastos();
    render();
  });
}

async function computeDisponibleAnterior(mesId) {
  const prevId = shiftMonth(mesId, -1);
  const prevGastoDoc = await getDocOnce(col.meses, prevId);
  // suma de cuentas del mes anterior menos gasto total de ese mes = sobrante real
  // Simplificación: usamos el "disponible" registrado en cuentas del mes anterior.
  const qPrev = query(col.cuentas, where("mes", "==", prevId));
  return new Promise((resolve) => {
    const unsub = watchCollection(qPrev, (rows) => {
      unsub();
      const total = rows.reduce((s, r) => s + (r.saldo || 0), 0);
      resolve(total);
    });
  });
}

function saveIngresos() {
  const data = {
    sueldoAlejo: Number(document.getElementById("in-sueldoAlejo").value) || 0,
    sueldoBelen: Number(document.getElementById("in-sueldoBelen").value) || 0,
    sobranteAnterior: Number(document.getElementById("in-sobrante").value) || 0,
    reintegros: Number(document.getElementById("in-reintegros").value) || 0,
    extra: Number(document.getElementById("in-extra").value) || 0
  };
  mesData = { ...mesData, ...data };
  upsertDoc(col.meses, currentMonth, data);
  render();
}

function renderCuentas() {
  const wrap = document.getElementById("cuentasList");
  wrap.innerHTML = CUENTAS_FIJAS.map((nombre) => `
    <div class="field-row">
      <label>${nombre}</label>
      <input type="number" step="0.01" inputmode="decimal" data-cuenta="${nombre}" value="${cuentasData[nombre] ?? 0}">
    </div>
  `).join("");
  wrap.querySelectorAll("input[data-cuenta]").forEach((input) => {
    input.addEventListener("input", debounce((e) => saveCuenta(e.target.dataset.cuenta, e.target.value), 500));
  });
}

function saveCuenta(nombre, valor) {
  const saldo = Number(valor) || 0;
  cuentasData[nombre] = saldo;
  const id = `${currentMonth}__${slug(nombre)}`;
  upsertDoc(col.cuentas, id, { mes: currentMonth, nombre, saldo });
  render();
}

async function onAddGasto(e) {
  e.preventDefault();
  const data = {
    mes: currentMonth,
    fecha: document.getElementById("g-fecha").value,
    monto: Number(document.getElementById("g-monto").value) || 0,
    moneda: document.getElementById("g-moneda").value,
    categoria: document.getElementById("g-categoria").value,
    detalle: document.getElementById("g-detalle").value.trim(),
    formaPago: document.getElementById("g-formaPago").value,
    entidad: document.getElementById("g-entidad").value.trim()
  };
  if (!data.monto) { toast("Ingresá un monto"); return; }
  await addRow(col.gastos, data);
  e.target.reset();
  document.getElementById("g-fecha").value = new Date().toISOString().slice(0, 10);
  toast("Gasto agregado");
}

async function onDeleteGasto(id) {
  await deleteRow(col.gastos, id);
  toast("Gasto eliminado");
}

function renderGastos() {
  const wrap = document.getElementById("gastosList");
  if (!gastosCache.length) {
    wrap.innerHTML = `<div class="empty-state">Todavía no cargaste gastos este mes.</div>`;
    return;
  }
  wrap.innerHTML = gastosCache.map((g) => `
    <div class="list-row">
      <div class="list-row-main">
        <div class="list-row-title"><span class="tag">${g.categoria || "Sin categoría"}</span>${g.detalle || "—"}</div>
        <div class="list-row-meta">${g.fecha || ""} · ${g.formaPago || ""} ${g.entidad ? "· " + g.entidad : ""}</div>
      </div>
      <div class="list-row-actions">
        <span class="list-row-amount ${g.moneda === "USD" ? "usd" : ""}">${g.moneda === "USD" ? fmtUSD(g.monto) : fmtARS(g.monto)}</span>
        <button class="btn-icon-sm" data-del="${g.id}" title="Eliminar">✕</button>
      </div>
    </div>
  `).join("");
  wrap.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => onDeleteGasto(btn.dataset.del));
  });
}

// ---- Cálculos y render de totales ------------------------------------
export function gastoTotalARS() {
  return gastosCache.reduce((s, g) => s + (g.moneda === "USD" ? (g.monto || 0) * cotizacion : (g.monto || 0)), 0);
}
export function ingresoTotalARS() {
  return (mesData.sueldoAlejo || 0) + (mesData.sueldoBelen || 0) + (mesData.sobranteAnterior || 0) +
    (mesData.reintegros || 0) + (mesData.extra || 0);
}
export function disponibleTotalARS() {
  return Object.values(cuentasData).reduce((s, v) => s + (v || 0), 0);
}

function render() {
  const ingreso = ingresoTotalARS();
  const gasto = gastoTotalARS();
  const disponible = disponibleTotalARS();
  const saldoTeorico = ingreso - gasto;
  const diferencia = disponible - saldoTeorico;

  document.getElementById("out-ingresoTotal").textContent = fmtARS(ingreso);
  document.getElementById("out-disponibleTotal").textContent = fmtARS(disponible);
  document.getElementById("out-gastoTotal").textContent = fmtARS(gasto);
  document.getElementById("out-saldoTeorico").textContent = fmtARS(saldoTeorico);
  document.getElementById("out-disponibleTotal2").textContent = fmtARS(disponible);
  document.getElementById("out-diferenciaCaja").textContent = fmtARS(diferencia);

  const stamp = document.getElementById("cajaStamp");
  const cuadra = Math.abs(diferencia) < 1;
  stamp.textContent = cuadra ? "CUADRA" : "DESCUADRE";
  stamp.classList.toggle("mismatch", !cuadra);

  renderCategoriaStats(gasto);
  renderResumen(ingreso, gasto);
}

function renderCategoriaStats(gastoTotal) {
  const wrap = document.getElementById("categoriaStats");
  const porCategoria = {};
  gastosCache.forEach((g) => {
    const monto = g.moneda === "USD" ? (g.monto || 0) * cotizacion : (g.monto || 0);
    porCategoria[g.categoria || "Otro"] = (porCategoria[g.categoria || "Otro"] || 0) + monto;
  });
  const entries = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { wrap.innerHTML = `<div class="empty-state">Sin datos todavía.</div>`; return; }
  wrap.innerHTML = entries.map(([cat, monto]) => {
    const pct = gastoTotal ? (monto / gastoTotal) * 100 : 0;
    return `
      <div class="stat-bar-row">
        <div class="stat-bar-labels"><span>${cat}</span><span>${fmtARS(monto)} · ${pct.toFixed(1)}%</span></div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>
      </div>
    `;
  }).join("");
}

function renderResumen(ingreso, gasto) {
  const wrap = document.getElementById("resumenMes");
  const ahorro = ingreso - gasto;
  const pctAhorro = ingreso ? (ahorro / ingreso) * 100 : 0;
  wrap.innerHTML = `
    <div class="row"><span>Ingreso total</span><output>${fmtARS(ingreso)}</output></div>
    <div class="row"><span>Gasto total</span><output>${fmtARS(gasto)}</output></div>
    <div class="row"><span>Excedente del mes</span><output>${fmtARS(ahorro)}</output></div>
    <div class="row"><span>% de ingresos no gastado</span><output>${pctAhorro.toFixed(1)}%</output></div>
    <div class="row"><span>Cantidad de gastos cargados</span><output>${gastosCache.length}</output></div>
  `;
}
