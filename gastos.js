import { col, query, where, orderBy, watchDoc, watchCollection, upsertDoc, addRow, updateRow, deleteRow, getDocOnce } from "./db.js";
import {
  CATEGORIAS, FORMAS_PAGO, CUENTAS_FIJAS, slug, monthId, shiftMonth, monthLabel,
  fmtARS, fmtUSD, debounce, toast, notifyUpdate, rerenderPreservingFocus
} from "./utils.js";
import { pushAction, makeAddAction, makeDeleteAction, makeUpdateAction, stripId } from "./history.js";

let currentMonth = monthId();
let cotizacion = 1000;
let mesData = {};
let cuentasData = {};      // nombre -> saldo
let gastosCache = [];      // todos los gastos del mes (efectivo + tarjeta, incluye fijos aplicados)
let fijosCache = [];       // catálogo de gastos fijos (colección aparte, sin mes)
let gastosSearchTerm = "";
let unsubMes = null, unsubCuentas = null, unsubGastos = null, unsubFijos = null;
let cuentasLoadedOnce = false; // evita reconstruir los inputs de "Distribución de caja" en cada eco

export function getCotizacion() { return cotizacion; }
export function setCotizacion(v) { cotizacion = v || 1; render(); }

export function initGastos() {
  fillSelect("g-categoria", CATEGORIAS);
  fillSelect("g-formaPago", FORMAS_PAGO);
  fillSelect("eg-categoria", CATEGORIAS);
  fillSelect("eg-formaPago", FORMAS_PAGO);
  fillSelect("f-categoria", CATEGORIAS);
  fillSelect("f-formaPago", FORMAS_PAGO); // incluye CRED: para suscripciones fijas en tarjeta
  document.getElementById("g-fecha").value = new Date().toISOString().slice(0, 10);

  document.getElementById("prevMonth").addEventListener("click", () => switchMonth(shiftMonth(currentMonth, -1)));
  document.getElementById("nextMonth").addEventListener("click", () => switchMonth(shiftMonth(currentMonth, 1)));

  ["in-sueldoAlejo", "in-sueldoBelen", "in-sobrante", "in-reintegros", "in-extra"].forEach((id) => {
    document.getElementById(id).addEventListener("input", debounce(saveIngresos, 500));
  });

  document.getElementById("gastoForm").addEventListener("submit", onAddGasto);
  document.getElementById("fijoForm").addEventListener("submit", onAddFijo);

  document.getElementById("gastosSearch").addEventListener("input", (e) => {
    gastosSearchTerm = e.target.value.trim().toLowerCase();
    renderGastosUnificados();
  });

  // ---- Botones "+ ..." que muestran/ocultan los formularios ----
  const panelFijo = document.getElementById("panelFijo");
  const panelGasto = document.getElementById("panelGasto");
  document.getElementById("toggleFijoMes").addEventListener("click", () => {
    panelGasto.hidden = true;
    document.getElementById("panelFijoTitle").textContent = "Agregar gasto fijo del mes";
    document.getElementById("f-formaPago").value = "TRANS";
    panelFijo.hidden = false;
  });
  document.getElementById("toggleFijoTarjeta").addEventListener("click", () => {
    panelGasto.hidden = true;
    document.getElementById("panelFijoTitle").textContent = "Agregar gasto fijo de la tarjeta";
    document.getElementById("f-formaPago").value = "CRED";
    panelFijo.hidden = false;
  });
  document.getElementById("toggleNuevoGasto").addEventListener("click", () => {
    panelFijo.hidden = true;
    panelGasto.hidden = false;
  });
  document.getElementById("panelFijoClose").addEventListener("click", () => (panelFijo.hidden = true));
  document.getElementById("panelGastoClose").addEventListener("click", () => (panelGasto.hidden = true));

  // ---- Modal: editar gasto ----
  const editGastoModal = document.getElementById("editGastoModal");
  document.getElementById("editGastoForm").addEventListener("submit", onSubmitEditGasto);
  document.getElementById("editGastoModalClose").addEventListener("click", () => (editGastoModal.hidden = true));
  document.getElementById("editGastoModalCancel").addEventListener("click", () => (editGastoModal.hidden = true));
  editGastoModal.addEventListener("click", (e) => { if (e.target === editGastoModal) editGastoModal.hidden = true; });

  // Catálogo de gastos fijos: solo se usa para saber qué aplicar cada mes y
  // como referencia para "dejar de repetir". No dispara ningún render de
  // listas (esas se arman en base a los gastos reales del mes, más abajo).
  unsubFijos = watchCollection(query(col.gastosFijos, orderBy("nombre")), (rows) => {
    fijosCache = rows;
    aplicarFijosDelMes();
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
  cuentasLoadedOnce = false;
  renderCuentas(); // paint inputs immediately, values fill in as snapshot arrives

  const qCuentas = query(col.cuentas, where("mes", "==", mesId));
  unsubCuentas = watchCollection(qCuentas, (rows) => {
    cuentasData = {};
    CUENTAS_FIJAS.forEach((c) => (cuentasData[c] = 0));
    rows.forEach((r) => (cuentasData[r.nombre] = r.saldo || 0));
    if (!cuentasLoadedOnce) {
      cuentasLoadedOnce = true;
      renderCuentas();
    }
    render();
  });

  const qGastos = query(col.gastos, where("mes", "==", mesId));
  unsubGastos = watchCollection(qGastos, (rows) => {
    gastosCache = rows.slice().sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
    renderGastosUnificados();
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
  rerenderPreservingFocus(wrap, () => {
    wrap.innerHTML = CUENTAS_FIJAS.map((nombre) => `
      <div class="field-row">
        <label>${nombre}</label>
        <input type="number" step="0.01" inputmode="decimal" data-cuenta="${nombre}" value="${cuentasData[nombre] ?? 0}">
      </div>
    `).join("");
    wrap.querySelectorAll("input[data-cuenta]").forEach((input) => {
      input.addEventListener("input", debounce((e) => saveCuenta(e.target.dataset.cuenta, e.target.value), 500));
    });
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
  const ref = await addRow(col.gastos, data);
  pushAction(makeAddAction(`Agregar gasto: ${data.detalle || data.categoria}`, col.gastos, data, ref.id));
  e.target.reset();
  document.getElementById("g-fecha").value = new Date().toISOString().slice(0, 10);
  document.getElementById("panelGasto").hidden = true;
  toast("Gasto agregado");
}

async function onDeleteGasto(id) {
  const g = gastosCache.find((x) => x.id === id);
  await deleteRow(col.gastos, id);
  if (g) {
    pushAction(makeDeleteAction(`Eliminar gasto: ${g.detalle || g.categoria}`, col.gastos, id, stripId(g)));
  }
  toast("Gasto eliminado");
}

function onOpenEditGasto(g) {
  document.getElementById("eg-id").value = g.id;
  document.getElementById("eg-fecha").value = g.fecha || "";
  document.getElementById("eg-monto").value = g.monto || 0;
  document.getElementById("eg-moneda").value = g.moneda || "ARS";
  document.getElementById("eg-categoria").value = g.categoria || CATEGORIAS[0];
  document.getElementById("eg-detalle").value = g.detalle || "";
  document.getElementById("eg-formaPago").value = g.formaPago || FORMAS_PAGO[0];
  document.getElementById("eg-entidad").value = g.entidad || "";
  document.getElementById("editGastoModal").hidden = false;
}

async function onSubmitEditGasto(e) {
  e.preventDefault();
  const id = document.getElementById("eg-id").value;
  const g = gastosCache.find((x) => x.id === id);
  const data = {
    fecha: document.getElementById("eg-fecha").value,
    monto: Number(document.getElementById("eg-monto").value) || 0,
    moneda: document.getElementById("eg-moneda").value,
    categoria: document.getElementById("eg-categoria").value,
    detalle: document.getElementById("eg-detalle").value.trim(),
    formaPago: document.getElementById("eg-formaPago").value,
    entidad: document.getElementById("eg-entidad").value.trim()
  };
  await updateRow(col.gastos, id, data);
  if (g) {
    const before = {
      fecha: g.fecha || "", monto: g.monto || 0, moneda: g.moneda || "ARS",
      categoria: g.categoria || "", detalle: g.detalle || "", formaPago: g.formaPago || "", entidad: g.entidad || ""
    };
    pushAction(makeUpdateAction(`Editar gasto: ${data.detalle || data.categoria}`, col.gastos, id, before, data));
  }
  document.getElementById("editGastoModal").hidden = true;
  toast("Gasto actualizado");
}

function esTarjeta(g) { return g.formaPago === "CRED"; }
function matchesSearch(g, term) {
  if (!term) return true;
  return [g.detalle, g.categoria, g.entidad, g.formaPago].some((v) => (v || "").toLowerCase().includes(term));
}

function renderGastosUnificados() {
  const wrap = document.getElementById("gastosList");
  const term = gastosSearchTerm;
  const filtrados = gastosCache.filter((g) => matchesSearch(g, term));

  const fijosMes = filtrados.filter((g) => g.esFijo && !esTarjeta(g));
  const fijosTarjeta = filtrados.filter((g) => g.esFijo && esTarjeta(g));
  const tarjetaSueltos = filtrados.filter((g) => !g.esFijo && esTarjeta(g));
  const comunes = filtrados.filter((g) => !g.esFijo && !esTarjeta(g))
    .slice().sort((a, b) => (a.fecha || "").localeCompare(b.fecha || "")); // cronológico: primer día arriba

  if (!filtrados.length) {
    wrap.innerHTML = `<div class="empty-state">${term ? "No hay gastos que coincidan con la búsqueda." : "Todavía no cargaste gastos este mes."}</div>`;
    return;
  }

  const totalTarjeta = [...fijosTarjeta, ...tarjetaSueltos]
    .reduce((s, g) => s + (g.moneda === "USD" ? (g.monto || 0) * cotizacion : (g.monto || 0)), 0);

  let html = "";
  if (fijosMes.length) html += `<div class="gastos-subhead">Gastos fijos del mes</div>` + fijosMes.map(renderFijoRow).join("");
  if (fijosTarjeta.length) html += `<div class="gastos-subhead">Gastos fijos en tarjeta</div>` + fijosTarjeta.map(renderFijoRow).join("");
  if (tarjetaSueltos.length) html += `<div class="gastos-subhead">Tarjeta de crédito${totalTarjeta ? " · " + fmtARS(totalTarjeta) : ""}</div>` + tarjetaSueltos.map(gastoRow).join("");
  if (comunes.length) html += `<div class="gastos-subhead">Gastos del mes</div>` + comunes.map(gastoRow).join("");

  rerenderPreservingFocus(wrap, () => {
    wrap.innerHTML = html;
    wireFijoRowEvents(wrap);
    wrap.querySelectorAll("[data-editg]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const g = gastosCache.find((x) => x.id === btn.dataset.editg);
        if (g) onOpenEditGasto(g);
      });
    });
    wrap.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", () => onDeleteGasto(btn.dataset.del));
    });
  });
}

function gastoRow(g) {
  const esCred = esTarjeta(g);
  return `
    <div class="list-row ${esCred ? "warn" : ""}">
      <div class="list-row-main">
        <div class="list-row-title"><span class="tag ${esCred ? "amber" : ""}">${g.categoria || "Sin categoría"}</span>${g.detalle || "—"}</div>
        <div class="list-row-meta">${g.fecha || ""} · ${g.formaPago || ""} ${g.entidad ? "· " + g.entidad : ""}</div>
      </div>
      <div class="list-row-actions">
        <span class="list-row-amount ${g.moneda === "USD" ? "usd" : ""}">${g.moneda === "USD" ? fmtUSD(g.monto) : fmtARS(g.monto)}</span>
        <button class="btn-icon-sm edit" data-editg="${g.id}" title="Editar">✎</button>
        <button class="btn-icon-sm" data-del="${g.id}" title="Eliminar">✕</button>
      </div>
    </div>
  `;
}

// ---- Gastos fijos (catálogo) ---------------------------------------------
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
  const ref = await addRow(col.gastosFijos, data);
  pushAction(makeAddAction(`Agregar gasto fijo: ${data.nombre}`, col.gastosFijos, data, ref.id));
  e.target.reset();
  document.getElementById("panelFijo").hidden = true;
  toast("Gasto fijo agregado — se va a cargar solo cada mes");
}

// Las dos cards de fijos (efectivo y tarjeta) muestran la instancia REAL de
// este mes (un doc en "gastos" con esFijo:true), no el catálogo — así
// editar el monto acá afecta este mes y, al pisar también el catálogo,
// todos los que vengan, sin tocar los ya pasados.
function renderFijoRow(g) {
  const fijo = fijosCache.find((f) => f.id === g.fijoId);
  return `
    <div class="list-row ok">
      <div class="list-row-main">
        <div class="list-row-title"><span class="tag">${g.categoria || "Sin categoría"}</span>${g.detalle || fijo?.nombre || "—"}</div>
        <div class="list-row-meta">${g.formaPago || ""} ${g.entidad ? "· " + g.entidad : ""} · se aplica todos los meses</div>
      </div>
      <div class="list-row-actions">
        <span style="font-size:12px;color:var(--ink-faint);">${g.moneda === "USD" ? "US$" : "$"}</span>
        <input type="number" class="fijo-monto-input" step="0.01" data-fijo-gasto="${g.id}" data-fijo-cat="${g.fijoId || ""}" value="${g.monto || 0}">
        <button class="btn-icon-sm" data-quitar-mes="${g.id}" title="Quitar solo este mes">✕</button>
      </div>
    </div>
    ${fijo ? `<div style="text-align:right;margin:-6px 0 8px;"><button type="button" class="btn-outline small" data-dejar-repetir="${fijo.id}" data-nombre="${fijo.nombre}">Dejar de repetir este gasto</button></div>` : ""}
  `;
}

function wireFijoRowEvents(wrap) {
  wrap.querySelectorAll("[data-fijo-gasto]").forEach((input) => {
    input.addEventListener("input", debounce((e) => {
      const nuevoMonto = Number(e.target.value) || 0;
      updateRow(col.gastos, e.target.dataset.fijoGasto, { monto: nuevoMonto });
      // también actualiza el catálogo para que los meses siguientes ya
      // arranquen con el nuevo valor (ajuste por inflación, etc.)
      if (e.target.dataset.fijoCat) {
        updateRow(col.gastosFijos, e.target.dataset.fijoCat, { monto: nuevoMonto });
      }
    }, 600));
  });
  wrap.querySelectorAll("[data-quitar-mes]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const g = gastosCache.find((x) => x.id === btn.dataset.quitarMes);
      await deleteRow(col.gastos, btn.dataset.quitarMes);
      if (g) pushAction(makeDeleteAction(`Quitar gasto fijo (solo este mes): ${g.detalle}`, col.gastos, g.id, stripId(g)));
      toast("Se quitó de este mes — el próximo mes se vuelve a cargar solo");
    });
  });
  wrap.querySelectorAll("[data-dejar-repetir]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const f = fijosCache.find((x) => x.id === btn.dataset.dejarRepetir);
      await deleteRow(col.gastosFijos, btn.dataset.dejarRepetir);
      if (f) pushAction(makeDeleteAction(`Dejar de repetir: ${f.nombre}`, col.gastosFijos, f.id, stripId(f)));
      toast(`"${btn.dataset.nombre}" no se va a volver a cargar — este mes queda como está`);
    });
  });
}

// Aplica los gastos fijos activos al mes actual, una sola vez por mes y por
// fijo (queda registrado en meses/{mes}.gastosFijosAplicados). Si el usuario
// borra manualmente el gasto generado ese mes ("Quitar solo este mes"), no
// vuelve a aparecer. Si borra la plantilla completa ("Dejar de repetir"),
// tampoco se vuelve a aplicar en ningún mes futuro.
//
// Se llama desde varios listeners (mes, fijos) que pueden disparar casi al
// mismo tiempo (típicamente al hacer F5) — el lock evita que dos llamadas
// simultáneas lean "todavía no se aplicó" y agreguen el mismo gasto dos veces.
const mesesAplicandoFijos = new Set();
async function aplicarFijosDelMes() {
  const mes = currentMonth;
  if (!mes || !fijosCache.length) return;
  if (mesesAplicandoFijos.has(mes)) return;

  const aplicados = mesData.gastosFijosAplicados || [];
  const pendientes = fijosCache.filter((f) => f.activo !== false && !aplicados.includes(f.id));
  if (!pendientes.length) return;

  mesesAplicandoFijos.add(mes);
  try {
    const nuevosAplicados = [...aplicados];
    for (const f of pendientes) {
      await addRow(col.gastos, {
        mes,
        fecha: `${mes}-01`,
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
    if (currentMonth === mes) mesData = { ...mesData, gastosFijosAplicados: nuevosAplicados };
    await upsertDoc(col.meses, mes, { gastosFijosAplicados: nuevosAplicados });
  } finally {
    mesesAplicandoFijos.delete(mes);
  }
}

// ---- Cálculos y render de totales ------------------------------------
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
