import { col, watchDoc, upsertDoc } from "./db.js";
import { debounce, toast, fmtARS, onUpdate } from "./utils.js";
import { initGastos, setCotizacion, gastoTarjetaARS, getCajaCuadra } from "./gastos.js";
import { initInventario, getListaComprasCount } from "./inventario.js";
import { initAhorros } from "./ahorros.js";

// ---- Tabs -------------------------------------------------------------
const tabButtons = document.querySelectorAll(".tab-btn");
const views = document.querySelectorAll(".view");

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    tabButtons.forEach((b) => b.classList.toggle("active", b === btn));
    views.forEach((v) => (v.hidden = v.dataset.view !== target));
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

// ---- Cotización del dólar ----------------------------------------------
const dolarInput = document.getElementById("dolarInput");
const dolarApiBtn = document.getElementById("dolarApiBtn");

watchDoc(col.config, "cotizacion", (data) => {
  const valor = data?.valor || 1000;
  dolarInput.value = valor;
  setCotizacion(valor);
});

dolarInput.addEventListener("input", debounce(() => {
  const valor = Number(dolarInput.value) || 0;
  setCotizacion(valor);
  upsertDoc(col.config, "cotizacion", { valor, modo: "manual", fecha: new Date().toISOString() });
}, 500));

dolarApiBtn.addEventListener("click", async () => {
  dolarApiBtn.textContent = "…";
  try {
    // API pública, referencia BNA (sin necesidad de key)
    const res = await fetch("https://dolarapi.com/v1/dolares/oficial");
    if (!res.ok) throw new Error("api error");
    const data = await res.json();
    const valor = data.venta || data.compra;
    if (!valor) throw new Error("sin valor");
    dolarInput.value = valor;
    setCotizacion(valor);
    await upsertDoc(col.config, "cotizacion", { valor, modo: "api", fecha: new Date().toISOString() });
    toast("Cotización actualizada");
  } catch (err) {
    toast("No se pudo traer la cotización");
    console.error(err);
  } finally {
    dolarApiBtn.textContent = "↻";
  }
});

// ---- Pills del header (datos en vivo de gastos + inventario) -----------
function renderHeroStats() {
  const wrap = document.getElementById("heroStats");
  const compras = getListaComprasCount();
  const tarjeta = gastoTarjetaARS();
  const cuadra = getCajaCuadra();
  const pills = [];
  pills.push(compras > 0
    ? `<span class="hero-pill pill-danger">🛒 ${compras} por reponer</span>`
    : `<span class="hero-pill">🛒 Stock al día</span>`);
  if (tarjeta > 0) pills.push(`<span class="hero-pill pill-amber">💳 Tarjeta: ${fmtARS(tarjeta)}</span>`);
  pills.push(cuadra
    ? `<span class="hero-pill">✅ Caja cuadra</span>`
    : `<span class="hero-pill pill-danger">⚠ Caja descuadrada</span>`);
  wrap.innerHTML = pills.join("");
}
onUpdate(renderHeroStats);

// ---- Arranque de módulos ------------------------------------------------
initGastos();
initInventario();
initAhorros();
renderHeroStats();
