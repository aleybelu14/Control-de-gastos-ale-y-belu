import { col, query, where, orderBy, watchDoc, watchCollection, upsertDoc, addRow, updateRow, deleteRow, getDocOnce } from "./db.js";
import {
  CATEGORIAS, FORMAS_PAGO, CUENTAS_FIJAS, slug, monthId, shiftMonth, monthLabel,
  fmtARS, fmtUSD, debounce, toast, notifyUpdate
} from "./utils.js";

let currentMonth = monthId();
let cotizacion = 1000;
let mesData = {};
let cuentasData = {};      // nombre -> saldo
let gastosCache = [];      // todos los gastos del mes (efectivo + tarjeta)
let fijosCache = [];       // catálogo de gastos fijos (colección aparte)
let unsubMes = null, unsubCuentas = null, unsubGastos = null, unsubFijos = null;

export function getCotizacion() { return cotizacion; }
export function setCotizacion(v) { cotizacion = v || 1; render(); }

export function initGastos() {
  fillSelect("g-categoria", CATEGORIAS);
  fillSelect("g-formaPago", FORMAS_PAGO);
  fillSelect("f-categoria", CATEGORIAS);
  fillSelect("f-formaPago", FORMAS_PAGO.filter((f) => f !== "CRED"));
  document.getElementById("g-fecha").value = new Date().toISOString().slice(0, 10);

  document.getElementById("prevMonth").addEventListener("click", () => switchMonth(shiftMonth(currentMonth, -1)));
  document.getElementById("nextMonth").addEventListener("click", () => switchMonth(shiftMonth(currentMonth, 1)));

  ["in-sueldoAlejo", "in-sueldoBelen", "in-sobrante", "in-reintegros", "in-extra"].forEach((id) => {
    document.getElementById(id).addEventListener("input", debounce(saveIngresos, 500));
  });

  document.getElementById("gastoForm").addEventListener("submit", onAddGasto);
  document.getElementById("fijoForm").addEventListener("submit", onAddFijo);

  unsubFijos = watchCollection(query(col.gastosFijos, orderBy("nombre")), (rows) => {
    fijosCache = rows;
    renderFijos();
    aplicarFijosDelMes(); // idempotente: solo agrega los que falten
  });

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
    aplicarFijosDelMes();
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
    renderTarjeta();
    render();
  });
}

async function computeDisponibleAnterior(mesId) {
  const prevId = shiftMonth(mesId, -1);
  // suma de cuentas del mes anterior = disponible real de ese mes -> sobrante sugerido
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

// ---- Gastos (carga manual) ---------------------------------------------
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

function esTarjeta(g) { return g.formaPago === "CRED"; }

function renderGastos() {
  const wrap = document.getElementById("gastosList");
  const lista = gastosCache.filter((g) => !esTarjeta(g));
  if (!lista.length) {
    wrap.innerHTML = `<div class="empty-state">Todavía no cargaste gastos este mes.</div>`;
    return;
  }
  wrap.innerHTML = lista.map((g) => `
    <div class="list-row">
      <div class="list-row-main">
        <div class="list-row-title"><span class="tag">${g.categoria || "Sin categoría"}</span>${g.detalle || "—"}${g.esFijo ? ' <span class="tag green">Fijo</span>' : ""}</div>
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

function renderTarjeta() {
  const wrap = document.getElementById("tarjetaList");
  const lista = gastosCache.filter(esTarjeta);
  document.getElementById("tag-cantidadTarjeta").textContent = `${lista.length} gasto${lista.length === 1 ? "" : "s"}`;
  if (!lista.length) {
    wrap.innerHTML = `<div class="empty-state">Sin gastos con tarjeta este mes.</div>`;
  } else {
    wrap.innerHTML = lista.map((g) => `
      <div class="list-row warn">
        <div class="list-row-main">
          <div class="list-row-title"><span class="tag amber">${g.categoria || "Sin categoría"}</span>${g.detalle || "—"}</div>
          <div class="list-row-meta">${g.fecha || ""} ${g.entidad ? "· " + g.entidad : ""}</div>
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
  const total = lista.reduce((s, g) => s + (g.moneda === "USD" ? (g.monto || 0) * cotizacion : (g.monto || 0)), 0);
  document.getElementById("out-totalTarjeta").textContent = fmtARS(total);
}

// ---- Gastos fijos --------------------------------------------------------
async function onAddFijo(e) {
  e.preventDefault();
  const data = {
    nombre: document.getElementById("f-nombre").value.trim(),
    monto: Number(document.getElementById("f-monto").value) || 0,
    moneda: document.getElementById("f-moneda").value,
    categoria: document.getElementById("f-categoria").value,
    formaPago: document.getElementById("f-formaPago").value,
    entidad: document.getElementById("f-entidad").value.trim(),
    activo: true
  };
  if (!data.nombre || !data.monto) { toast("Completá nombre y monto"); return; }
  await addRow(col.gastosFijos, data);
  e.target.reset();
  toast("Gasto fijo agregado — se va a cargar solo cada mes");
}

function renderFijos() {
  const wrap = document.getElementById("fijosList");
  if (!fijosCache.length) {
    wrap.innerHTML = `<div class="empty-state">Todavía no cargaste gastos fijos.</div>`;
    return;
  }
  wrap.innerHTML = fijosCache.map((f) => `
    <div class="list-row ok">
      <div class="list-row-main">
        <div class="list-row-title"><span class="tag">${f.categoria || "Sin categoría"}</span>${f.nombre}</div>
        <div class="list-row-meta">${f.formaPago || ""} ${f.entidad ? "· " + f.entidad : ""} · se aplica todos los meses</div>
      </div>
      <div class="list-row-actions">
        <input type="number" class="fijo-monto-input" step="0.01" data-fijo-monto="${f.id}" value="${f.monto || 0}">
        <button class="btn-icon-sm" data-del-fijo="${f.id}" title="Eliminar gasto fijo">✕</button>
      </div>
    </div>
  `).join("");
  wrap.querySelectorAll("[data-fijo-monto]").forEach((input) => {
    input.addEventListener("input", debounce((e) => {
      updateRow(col.gastosFijos, e.target.dataset.fijoMonto, { monto: Number(e.target.value) || 0 });
    }, 500));
  });
  wrap.querySelectorAll("[data-del-fijo]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await deleteRow(col.gastosFijos, btn.dataset.delFijo);
      toast("Gasto fijo eliminado (no se va a volver a cargar)");
    });
  });
}

// Aplica los gastos fijos activos al mes actual, una sola vez por mes y por
// fijo (queda registrado en meses/{mes}.gastosFijosAplicados). Si el usuario
// borra manualmente el gasto generado, no vuelve a aparecer.
async function aplicarFijosDelMes() {
  if (!currentMonth || !fijosCache.length) return;
  const aplicados = mesData.gastosFijosAplicados || [];
  const pendientes = fijosCache.filter((f) => f.activo !== false && !aplicados.includes(f.id));
  if (!pendientes.length) return;

  const nuevosAplicados = [...aplicados];
  for (const f of pendientes) {
    await addRow(col.gastos, {
      mes: currentMonth,
      fecha: `${currentMonth}-01`,
      monto: f.monto || 0,
      moneda: f.moneda || "ARS",
      categoria: f.categoria || "Otro",
      detalle: f.nombre,
      formaPago: f.formaPago || "TRANS",
      entidad: f.entidad || "",
      esFijo: true,
      fijoId: f.id
    });
    nuevosAplicados.push(f.id);
  }
  mesData = { ...mesData, gastosFijosAplicados: nuevosAplicados };
  await upsertDoc(col.meses, currentMonth, { gastosFijosAplicados: nuevosAplicados });
}

// ---- Cálculos y render de totales ------------------------------------
// gastoTotalARS(): solo efectivo/débito/transferencia — es lo que sale de las
// cuentas este mes. La tarjeta se paga cuando llega el resumen (otro mes).
export function gastoTotalARS() {
  return gastosCache.filter((g) => !esTarjeta(g))
    .reduce((s, g) => s + (g.moneda === "USD" ? (g.monto || 0) * cotizacion : (g.monto || 0)), 0);
}
export function gastoTarjetaARS() {
  return gastosCache.filter(esTarjeta)
    .reduce((s, g) => s + (g.moneda === "USD" ? (g.monto || 0) * cotizacion : (g.monto || 0)), 0);
}
export function ingresoTotalARS() {
  return (mesData.sueldoAlejo || 0) + (mesData.sueldoBelen || 0) + (mesData.sobranteAnterior || 0) +
    (mesData.reintegros || 0) + (mesData.extra || 0);
}
export function disponibleTotalARS() {
  return Object.values(cuentasData).reduce((s, v) => s + (v || 0), 0);
}
export function getCajaCuadra() {
  const diff = disponibleTotalARS() - (ingresoTotalARS() - gastoTotalARS());
  return Math.abs(diff) < 1;
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

  document.getElementById("stat-ingreso").textContent = fmtARS(ingreso);
  document.getElementById("stat-gasto").textContent = fmtARS(gasto);
  document.getElementById("stat-disponible").textContent = fmtARS(disponible);

  const stamp = document.getElementById("cajaStamp");
  const cuadra = Math.abs(diferencia) < 1;
  stamp.textContent = cuadra ? "CUADRA" : "DESCUADRE";
  stamp.classList.toggle("mismatch", !cuadra);

  renderCategoriaStats(gasto);
  renderResumen(ingreso, gasto);
  notifyUpdate();
}

function renderCategoriaStats(gastoTotal) {
  const wrap = document.getElementById("categoriaStats");
  const porCategoria = {};
  gastosCache.filter((g) => !esTarjeta(g)).forEach((g) => {
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
  const tarjeta = gastoTarjetaARS();
  const ahorro = ingreso - gasto;
  const pctAhorro = ingreso ? (ahorro / ingreso) * 100 : 0;
  wrap.innerHTML = `
    <div class="row"><span>Ingreso total</span><output>${fmtARS(ingreso)}</output></div>
    <div class="row"><span>Gasto total (efec./déb.)</span><output>${fmtARS(gasto)}</output></div>
    <div class="row"><span>Gasto en tarjeta (no incluido en balance)</span><output>${fmtARS(tarjeta)}</output></div>
    <div class="row"><span>Excedente del mes</span><output>${fmtARS(ahorro)}</output></div>
    <div class="row"><span>% de ingresos no gastado</span><output>${pctAhorro.toFixed(1)}%</output></div>
    <div class="row"><span>Cantidad de gastos cargados</span><output>${gastosCache.filter((g) => !esTarjeta(g)).length}</output></div>
  `;
}
