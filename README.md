# Casa · Control del hogar

Web app de finanzas e inventario del hogar. Vanilla HTML/CSS/JS +
Firebase Firestore (sincronización en tiempo real), sin login, pensada
para hosting gratuito en GitHub Pages.

## 1. Estructura del proyecto

```
index.html
styles.css
firebase-config.js   ← poné acá tus credenciales de Firebase
db.js                ← inicialización de Firestore + helpers genéricos
utils.js             ← constantes (categorías, cuentas, formas de pago) y formatos
history.js           ← deshacer/rehacer (últimas 5 acciones)
gastos.js             Módulo 1
inventario.js         Módulo 2
ahorros.js             Módulo 3
main.js               tabs + cotización del dólar + arranque
```

## 2. Modelo de datos en Firestore

Todas las colecciones son de nivel raíz (no hace falta autenticación:
las reglas de seguridad, más abajo, son las que protegen los datos).

### `config/cotizacion` (documento único)
```json
{ "valor": 1250.5, "modo": "manual | api", "fecha": "2026-08-01T12:00:00.000Z" }
```
Cotización del dólar usada para convertir montos en USD a ARS en todas
las estadísticas. Se puede tipear a mano o traer con el botón ↻, que
consulta `https://dolarapi.com/v1/dolares/oficial` (referencia BNA,
API pública sin key).

### `meses/{YYYY-MM}` (un documento por mes)
```json
{
  "sueldoAlejo": 1165000,
  "sueldoBelen": 1114386.68,
  "sobranteAnterior": 197902.35,
  "reintegros": 3641.82,
  "extra": 200000
}
```
`sobranteAnterior` se autocompleta (y se guarda) con la suma de las
cuentas (`cuentas`) del mes anterior la primera vez que abrís un mes
nuevo; después queda editable a mano. El "Ingreso total" se calcula en
el cliente sumando estos 5 campos — no se guarda como campo derivado
para que nunca quede desactualizado.

### `cuentas/{YYYY-MM}__{cuenta-slug}` (una por cuenta y mes)
```json
{ "mes": "2026-04", "nombre": "Personal Pay", "saldo": 872501.63 }
```
Una fila por cada una de las 7 cuentas fijas (Ciudad/buepp, Personal
Pay, Cuenta DNI, Personal Pay Reservas, Efectivo, YPF Belu, YPF Ale) y
mes. La suma de todas da el "Disponible total" del mes.

### `gastos/{autoId}`
```json
{
  "mes": "2026-04",
  "fecha": "2026-04-02",
  "monto": 788525.63,
  "moneda": "ARS | USD",
  "categoria": "Vivienda (alq+exp)",
  "detalle": "alquiler abril",
  "formaPago": "TRANS | DEB | EF | App | CRED | MODO | QR | Otro",
  "entidad": "Personal Pay",
  "esFijo": true,
  "fijoId": "<id de gastos_fijos, si vino de ahí>",
  "createdAt": "<serverTimestamp>"
}
```
Índice: esta consulta filtra por `mes` y ordena la fecha del lado del
cliente (no en la query) a propósito, para no depender de que crees un
índice compuesto en Firestore — así funciona directo desde el primer
uso sin configuración extra.

Los gastos con `formaPago: "CRED"` (tarjeta de crédito) no se listan
junto a los demás: aparecen en la card aparte "Tarjeta de crédito —
resumen del mes" y **no** se descuentan del "Balance de caja" del
mes en curso, porque ese gasto en realidad va a salir de la cuenta
recién cuando llegue el resumen (otro mes). Sí se cuentan en el
"Resumen del mes" como referencia.

### `gastos_fijos/{autoId}` (catálogo, no tiene mes)
```json
{
  "nombre": "Alquiler",
  "monto": 788525.63,
  "moneda": "ARS | USD",
  "categoria": "Vivienda (alq+exp)",
  "formaPago": "TRANS",
  "entidad": "Personal Pay",
  "activo": true,
  "createdAt": "<serverTimestamp>"
}
```
Se cargan una única vez en el catálogo. Cada vez que se abre un mes,
la app crea (o pisa) en `gastos` un documento con **ID
determinístico** `{mes}__fijo__{idDelFijo}` por cada fijo activo — por
ejemplo `2026-08__fijo__abc123`. Al ser siempre el mismo ID, aunque la
función que los aplica se llame varias veces (dos listeners en
simultáneo, una recarga interrumpida a mitad de guardado, lo que sea)
nunca puede crear un duplicado: como mucho pisa el mismo documento
con los mismos datos. Si se quiere sacar un fijo puntual de un mes sin
tocar el catálogo, su id se guarda en
`meses/{mes}.gastosFijosQuitados` para que no se vuelva a crear ese
mes. Editar el monto de un gasto fijo actualiza el documento de ese
mes y el catálogo (para que los meses futuros ya arranquen con el
valor nuevo) — los meses anteriores no se tocan.

### `inventario/{autoId}`
```json
{
  "nombre": "Papel higiénico",
  "categoria": "Baño",
  "estado": "en_uso",
  "precio": 4200,
  "capacidad": "4 rollos",
  "fechaAdquisicion": "2026-03-15",
  "cantidad": 3,
  "vecesDescontado": 7,
  "fechaUltimaReposicion": "2026-03-15",
  "fechasAgotamiento": ["2026-02-01", "2026-03-15"],
  "duraciones": [{ "desde": "2026-01-01", "hasta": "2026-02-01", "dias": 31 }],
  "historialCompras": [
    { "fecha": "2026-03-15", "cantidad": 3, "lugar": "Coto", "precio": 4200 }
  ],
  "createdAt": "<serverTimestamp>"
}
```
`estado` es uno de `"stock"` / `"en_uso"` / `"reponer"` y define en qué
columna del tablero aparece el artículo (En stock | En uso | A
reponer, tipo to-do/doing/done). Se mueve con los botones ← / → de
cada tarjeta, no automáticamente. Al registrar una reposición con el
botón "+" vuelve a `"en_uso"`.

`vecesDescontado` se incrementa cada vez que se usa el botón "-1" y
alimenta la estadística "Mayor recambio". El color del borde de cada
tarjeta (verde/amarillo/rojo) depende de `cantidad` — 2 o más, 1, o 0
— independientemente de la columna en la que esté.

Cada vez que el botón "-1" hace que `cantidad` llegue a `0`, se
guarda la fecha en `fechasAgotamiento` y se cierra un ciclo en
`duraciones` (días entre la última reposición y el agotamiento). Con
eso se calcula "Duración promedio del stock" sin tocar `cantidad`.

El botón "+" abre un formulario (fecha, cantidad, dónde se compró,
precio) que suma a `cantidad`, actualiza `precio`/`fechaAdquisicion`/
`fechaUltimaReposicion` y agrega una entrada a `historialCompras`
para las estadísticas. El botón "✎" edita cualquier campo del
artículo sin borrarlo.

### `ahorros_plataformas/{autoId}`
```json
{ "nombre": "Broker/PPI", "moneda": "ARS | USD", "createdAt": "<serverTimestamp>" }
```
Catálogo de plataformas/ubicaciones (Efectivo, Cuenta bancaria,
Broker/PPI, etc.), se define una vez y se reutiliza mes a mes.

### `ahorros_saldos/{YYYY-MM}__{plataformaId}`
```json
{
  "mes": "2026-04",
  "plataformaId": "abc123",
  "inicio": 3572511.93,
  "fin": 3610000,
  "movimientos": 0
}
```
`movimientos` son aportes (+) o retiros (-) netos del mes: se restan
antes de calcular rendimiento, para no confundir capital nuevo con
ganancia real. `Ganancia = fin - inicio - movimientos`;
`Rendimiento % = Ganancia / inicio`. El patrimonio total del mes suma
`fin` de todas las plataformas convertido a ARS con la cotización
vigente.

## 3. Configurar Firebase

1. Creá un proyecto en [console.firebase.google.com](https://console.firebase.google.com).
2. Firestore Database → crear base de datos → modo producción.
3. Configuración del proyecto → Tus apps → ícono web (`</>`) → registrá
   una app → copiá el objeto de config.
4. Pegalo en `firebase-config.js`.

### Reglas de seguridad recomendadas

Como no hay login, cualquiera con la URL puede leer y escribir. Para
un uso puramente personal alcanza con dejarlo abierto pero **restringido
a las colecciones que usa la app** (evita que alguien use tu proyecto
como base de datos genérica):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{collection}/{docId} {
      allow read, write: if collection in
        ['meses', 'cuentas', 'gastos', 'gastos_fijos', 'inventario',
         'ahorros_plataformas', 'ahorros_saldos', 'config'];
    }
  }
}
```

Si en algún momento querés más privacidad sin agregar login, se puede
sumar App Check (reCAPTCHA) para que solo tu dominio de GitHub Pages
pueda escribir.

## 4. Publicar en GitHub Pages

```bash
git init
git add .
git commit -m "Casa · control de gastos e inventario"
git branch -M main
git remote add origin <tu-repo>
git push -u origin main
```

Repo → Settings → Pages → Source: `main` / `/ (root)`. La app va a
quedar en `https://<usuario>.github.io/<repo>/`.

## 5. Notas de uso

- Todo se guarda solo (Firestore en tiempo real): no hay botón
  "Guardar", los campos se persisten al tipear (con un pequeño debounce).
- El "Balance de caja" compara el disponible real (suma de cuentas)
  contra el teórico (ingresos − gastos) y muestra un sello **CUADRA /
  DESCUADRE** para detectar diferencias rápido.
- Las categorías, formas de pago y cuentas fijas están definidas en
  `utils.js` — son fáciles de editar si tu esquema cambia.
- Los botones ↶ / ↷ de la barra de arriba deshacen/rehacen las últimas
  5 acciones "de un click" (agregar, eliminar o editar un gasto, un
  gasto fijo, un artículo de inventario o una plataforma de ahorro).
  No incluye campos que se tipean de a poco (sueldos, saldos de
  cuentas, cotización) para no llenar el historial con estados
  intermedios mientras escribís.
- Si alguna vez falla una consulta a Firestore (por ejemplo, permisos
  mal configurados), ahora aparece un toast avisando en vez de fallar
  en silencio — mirá la consola del navegador (F12) para el detalle.
