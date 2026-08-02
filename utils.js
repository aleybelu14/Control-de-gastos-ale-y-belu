// =====================================================================
// Constantes y utilidades compartidas
// =====================================================================

export const CATEGORIAS = [
  "Vivienda (alq+exp)", "Servicios básicos", "Servicios extra",
  "Mantenimiento auto", "Supermercado", "Salud", "Movilidad",
  "Farmacia", "Gustitos", "Salidas", "Hogar", "Regalos",
  "Viaje/vacas", "Otro"
];

export const FORMAS_PAGO = ["TRANS", "DEB", "EF", "App", "CRED", "MODO", "QR", "Otro"];

export const CUENTAS_FIJAS = [
  "Ciudad/buepp", "Personal Pay", "Cuenta DNI",
  "Personal Pay Reservas", "Efectivo", "YPF Belu", "YPF Ale"
];

export const CATEGORIAS_INVENTARIO = [
  "Cocina", "Baño", "Limpieza", "Living/Comedor", "Dormitorio",
  "Lavadero", "Herramientas", "Mascotas", "Otro"
];

// Estado de uso de un artículo (para cosas que se compran de a una — aceite,
// condimentos, detergente — y van pasando de "guardado" a "en uso" a
// "hay que comprar más" sin depender solo del número de cantidad).
export const ESTADOS_INVENTARIO = [
  { key: "stock", label: "En stock", tagClass: "" },
  { key: "en_uso", label: "En uso", tagClass: "green" },
  { key: "reponer", label: "A reponer", tagClass: "red" }
];

export const MESES_LARGO = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
];

export function slug(str) {
  return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function monthId(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(id, delta) {
  const [y, m] = id.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthId(d);
}

export function monthLabel(id) {
  const [y, m] = id.split("-").map(Number);
  return `${MESES_LARGO[m - 1]} ${y}`;
}

export function fmtARS(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("es-AR", { maximumFractionDigits: 0 });
}
export function fmtUSD(n) {
  const v = Number(n) || 0;
  return "US$" + v.toLocaleString("es-AR", { maximumFractionDigits: 2 });
}
export function fmtPct(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("es-AR", { maximumFractionDigits: 1 }) + "%";
}

export function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

export function daysBetween(isoFrom, isoTo) {
  if (!isoFrom || !isoTo) return null;
  const a = new Date(isoFrom + "T00:00:00");
  const b = new Date(isoTo + "T00:00:00");
  if (isNaN(a) || isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function debounce(fn, ms = 500) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Reconstruye el HTML de un contenedor sin robarle el tipeo al usuario: si
// justo en ese momento hay un input/select con foco adentro del contenedor,
// después de reconstruir se le restaura el valor tipeado, el cursor y el
// foco. Se usa en toda lista que se repinta sola por un snapshot de
// Firestore mientras el usuario puede estar escribiendo en uno de sus campos.
export function rerenderPreservingFocus(container, rebuildFn) {
  const active = document.activeElement;
  let focusInfo = null;
  if (active && container.contains(active) && active.matches("input, select, textarea")) {
    focusInfo = {
      key: JSON.stringify(active.dataset || {}),
      tag: active.tagName,
      value: active.value,
      selectionStart: active.selectionStart,
      selectionEnd: active.selectionEnd
    };
  }
  rebuildFn();
  if (focusInfo) {
    const candidates = container.querySelectorAll("input, select, textarea");
    for (const el of candidates) {
      if (el.tagName === focusInfo.tag && JSON.stringify(el.dataset || {}) === focusInfo.key) {
        el.value = focusInfo.value;
        el.focus();
        if (typeof focusInfo.selectionStart === "number") {
          try { el.setSelectionRange(focusInfo.selectionStart, focusInfo.selectionEnd); } catch (err) { /* algunos inputs numéricos no soportan selección */ }
        }
        break;
      }
    }
  }
}

// Mini pub-sub: los módulos avisan "notifyUpdate()" después de renderizar,
// y main.js escucha para refrescar los pills del header con datos en vivo.
export function notifyUpdate() {
  window.dispatchEvent(new CustomEvent("casita:update"));
}
export function onUpdate(cb) {
  window.addEventListener("casita:update", cb);
}

export function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}
