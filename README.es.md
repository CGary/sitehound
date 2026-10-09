[English](README.md) · **Español**

# sitehound

Arnés de navegador agnóstico a la tarea para explorar, probar (visual y de datos), analizar y clonar sitios web. Construido con TypeScript y Playwright.

Funciona con sitios públicos y con sitios protegidos por inicio de sesión: usted inicia sesión manualmente una sola vez, la sesión se guarda como un **perfil** con nombre y las ejecuciones posteriores la reutilizan. Un perfil puede contener varios sitios.

> **Estado:** etapa temprana (v0.1.0). Hoy existen el núcleo, la CLI por dominio (`bin/hound`), las sesiones de navegador, las tareas integradas `snapshot` y `component`, y los scripts de un solo archivo. Consulte la [hoja de ruta](#hoja-de-ruta).

## Características

- **Sesiones de navegador.** Abra un navegador persistente, navegue, lea la página como árbol de accesibilidad con referencias de elemento, y haga clic, rellene y diagnostique con un comando a la vez.
- **Perfiles reutilizables.** Inicie sesión a mano una vez; las cookies, localStorage e IndexedDB se guardan y se cargan con `--profile`. `profile login --mode extend` añade un sitio sin repetir los demás.
- **Núcleo agnóstico.** El arnés abre un navegador, carga un perfil y entrega la página a una tarea o a un script. Cada caso de uso vive en su propio paquete de tarea o en un script de un solo archivo.
- **Resultados estructurados.** Cada comando imprime un único objeto JSON. Las tareas y los scripts escriben un `result.json` con verificaciones, errores, solicitudes fallidas y estado de la sesión.
- **Listo para agentes.** Un contrato JSON único, códigos de error y de salida estables. Consulte [AGENTS.md](AGENTS.md).
- **Privado por defecto.** Todos los datos de ejecución van a un directorio `.hound/` ignorado por git, con permisos restrictivos.

## Requisitos

- Node.js 22.22.2, fijado en `.nvmrc` (el único lugar donde se define la versión de Node).
- [fnm](https://github.com/Schniz/fnm) para cambiar a esa versión. `bin/hound` ejecuta Node a través de fnm, así que no hace falta cambiar su shell.
- pnpm 12, mediante corepack.

Si fnm no está instalado, `bin/hound` ejecuta el Node que esté en su `PATH` y muestra una advertencia si difiere de `.nvmrc`.

## Inicio rápido

Instale [fnm](https://github.com/Schniz/fnm) y añada su hook de shell una vez, para que Node cambie de versión al entrar en el repositorio:

```sh
# fish (config.fish)
fnm env --use-on-cd | source
# bash / zsh (.bashrc / .zshrc)
eval "$(fnm env --use-on-cd)"
```

Después:

```sh
fnm install          # lee .nvmrc
corepack enable
corepack pnpm install
corepack pnpm browsers        # instala Chromium para Playwright
bin/hound task run --task snapshot --url https://example.com
```

`bin/hound` funciona desde cualquier directorio. `pnpm hound ...` también funciona desde la raíz del repositorio. Para que agentes de IA de otros proyectos lo usen, vea [la skill `sitehound`](#la-skill-sitehound).

La tarea `snapshot` escribe una captura de página completa, el HTML renderizado, el texto visible, un árbol de accesibilidad y metadatos básicos en un directorio de ejecución privado, `.hound/runs/snapshot/<marca de tiempo>/`, junto con un `result.json`.

## Uso

La CLI es `bin/hound <dominio> <verbo> [flags]`. Cada comando imprime un objeto JSON en stdout cuando se usa `--json` o cuando stdout no es una terminal. Añada `--schema` a cualquier comando para ver sus entradas.

| Dominio   | Verbos                                                                | Propósito                                            |
| --------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| `browser` | `open`, `close`, `list`, `status`                                     | Sesiones de navegador persistentes                   |
| `page`    | `navigate`, `snapshot`, `find`, `screenshot`, `pdf`, `wait`, `back`, `forward`, `reload`, `scroll`, `tabs`, `resize`, `emulate` | Moverse por la página actual, leerla y cambiar su tamaño |
| `element` | `click`, `check`, `uncheck`, `drag`, `read`, `hover`, `fill`, `type`, `select`, `press`, `upload`, `download` | Actuar sobre un elemento por su referencia o leerlo |
| `diag`    | `console`, `dialogs`, `network`, `request`, `trace`                   | Errores, diálogos gestionados, solicitudes, cuerpos redactados y traza limpia de una sesión |
| `profile` | `list`, `check`, `login`, `delete`                                    | Inicios de sesión guardados                          |
| `task`    | `list`, `run`                                                         | Tareas de captura integradas (`snapshot`, `component`) |
| `script`  | `run`, `export`                                                       | Script de prueba o extracción de un solo archivo; exportar las acciones de una sesión como script |
| `batch`   | (ninguno: `bin/hound batch ...`)                                      | Varios pasos page/element/diag de una sesión en una sola llamada |

Flags universales: `--json`, `--plain`, `--quiet`, `--debug`, `--no-input`, `--timeout <segundos>`, `--schema`, `--help`, `--version`.

```sh
bin/hound --help                              # dominios
bin/hound page --help                         # verbos de un dominio
bin/hound element click --schema              # entradas de un comando
```

Las flags aceptan `--clave valor` o `--clave=valor`. Use `--arg clave=valor` para pasar argumentos a una tarea o a un script.

### Comandos heredados y obsoletos

Estos comandos siguen funcionando y muestran en stderr un aviso de obsolescencia de una línea. Se eliminarán en una versión posterior.

| Comando anterior                    | Comando nuevo                                         |
| ----------------------------------- | ----------------------------------------------------- |
| `pnpm hound login <url> --profile n`| `bin/hound profile login --profile n --url <url>`     |
| `pnpm hound run <tarea> <url>`      | `bin/hound task run --task <tarea> --url <url>`       |
| `pnpm hound exec <archivo> <url>`   | `bin/hound script run --file <archivo> --url <url>`   |
| `pnpm hound check <perfil>`         | `bin/hound profile check --profile <perfil>`          |
| `pnpm hound tasks`                  | `bin/hound task list`                                 |
| `pnpm hound profiles`               | `bin/hound profile list`                              |
| `pnpm hound forget <perfil>`        | `bin/hound profile delete --profile <perfil> --dry-run` (añada `--yes` para borrar) |

`mcp` (el servidor MCP de Playwright) está obsoleto en favor de la CLI. Consulte [Agentes y MCP](#agentes-y-mcp).

## Sesiones de navegador

Una sesión es un navegador que permanece abierto entre comandos, de modo que puede navegar, leer y actuar paso a paso.

```sh
bin/hound browser open --session-name tienda --json                   # nivel de lectura (por defecto)
bin/hound page navigate --session-name tienda --url https://example.com --json
bin/hound page snapshot --session-name tienda --json                  # árbol de accesibilidad con referencias como e12
bin/hound element click --session-name tienda --ref e12 --json
bin/hound browser close --session-name tienda --json
```

- `--profile <nombre>` abre la sesión con un inicio de sesión guardado.
- `--actions read` (por defecto) permite navegar, leer, hacer capturas, desplazarse, esperar, usar pestañas, diagnósticos y hacer clic en enlaces http(s) reales y en `<summary>` (los enlaces que parecen efectos GET, como `/logout`, `/account/delete`, un texto «Cerrar sesión», `data-method="delete"` o `?_method=delete`, se rechazan con `ACTION_BLOCKED`; es una heurística). `--actions interact` además permite rellenar campos, seleccionar opciones, pulsar teclas y hacer clic en botones. Abra con `interact` solo cuando necesite enviar o cambiar algo.
- `--display headed` muestra la ventana; `headless` es el valor por defecto.
- `--dialog dismiss` (por defecto) cancela los diálogos de JavaScript (alert, confirm, prompt, beforeunload) en todas las pestañas, de modo que ninguno bloquea la página; `--dialog accept` los confirma (por ejemplo «¿Seguro que desea eliminar?») y requiere `--actions interact`. Puede cambiarlo en cada acción con `--dialog` / `--dialog-text` en `element click|press|select|type|download|upload|drag` y `page navigate|back|forward|reload`; el cambio también cubre un diálogo lanzado por un temporizador o una petición hasta 2 segundos después de que la acción termine. `page navigate|back|forward|reload` aceptan siempre un diálogo `beforeunload`, porque salir de la página es lo que usted pidió. Los diálogos gestionados aparecen en `data.dialogs` de la acción, y `diag dialogs` lista los últimos 100.
- `element upload --ref <ref> --file <ruta> [--file ...]` (interact) asigna archivos a un `<input type=file>` o al botón que abre el selector de archivos. Rechaza `.hound/` de sitehound, `.env*`, archivos HAR y de traza, credenciales SSH/nube/docker/kube, perfiles de navegador, historiales de shell, almacenes de contraseñas y archivos de claves (`ACTION_BLOCKED`), así como los archivos con enlaces duros (cópielos antes), y limita cada llamada a 20 archivos regulares y 50 MiB.
- `--viewport <ANCHO>x<ALTO>` (200..7680 x 200..4320), `--device-scale-factor 1..4` y `--mobile` fijan el tamaño, la densidad de píxeles y la emulación móvil/táctil de todas las pestañas; `browser status` muestra el viewport, y `page resize --viewport <ANCHO>x<ALTO>` cambia la pestaña activa. `page emulate` fija `--color-scheme light|dark|no-preference`, `--media screen|print` y `--reduced-motion reduce|no-preference` (o `--reset`) en la pestaña activa y en las que abra después.
- `page find --text <subcadena>|--regex </patrón/flags>` devuelve solo las líneas coincidentes de una instantánea nueva, con número de línea y referencia (`--limit 1..200`, `--context 0..3`); es la alternativa económica a leer toda la instantánea, y sus referencias sirven para los comandos `element`. Las expresiones regulares tienen límites (200 caracteres, 2000 por línea) y se ejecutan con un tiempo máximo. `element read --ref <ref> [--attr <nombre>] [--limit-chars 1..20000]` devuelve el texto de un elemento o un atributo, con los tokens enmascarados y sin query en las URL; los campos de contraseña, ocultos, de tarjeta, OTP o tipo CSRF se rechazan (`ACTION_BLOCKED`); en el texto se enmascaran los números de tarjeta (Luhn y forma de tarjeta) y los códigos de 4 a 8 dígitos junto a una etiqueta de código/PIN/OTP, y `page find` hace lo mismo; el resto de números no se toca. Las líneas `/url:` de las instantáneas pierden su query. `element drag --ref <origen> --to-ref <destino>` (interact) arrastra y suelta: `--method auto` (por defecto) prueba el arrastre HTML5 y, si la página no reaccionó, lo repite con un recorrido real del puntero de `--steps 1..50` movimientos (10 por defecto); `html5` y `mouse` fuerzan uno de los dos.
- `page snapshot --ref <ref>` devuelve solo el subárbol de ese elemento (sus referencias son las mismas que en una instantánea completa, así que sirven para los comandos `element`), y `page snapshot --diff` devuelve solo las líneas añadidas (`+`) o eliminadas (`-`) desde la instantánea anterior de la misma pestaña con el mismo `--ref` y `--depth`, como un diff unificado compacto con las referencias (`data.diff`, `added`, `removed`, `baseline`). La primera llamada no tiene base de comparación y devuelve la instantánea completa (`baseline: false`); cada instantánea, con o sin diff, pasa a ser la nueva base, y una línea que solo gana o pierde la marca de foco `[active]` no cuenta como cambio. `--limit-chars`, `--output` y el archivo guardado contienen entonces el diff. Ambas opciones ahorran tokens en páginas grandes.
- `browser open --block analytics,ads,images,media,fonts` rechaza esas categorías de peticiones durante toda la sesión (hosts conocidos de analítica y publicidad por lista, el resto por tipo de recurso). Las peticiones bloqueadas aparecen en `diag network --state all` con el fallo `blocked` y `blocked: <categoría>`, y nunca cuentan como fallos. Una página que necesite un recurso bloqueado puede verse rota. Efectos secundarios: el enrutamiento desactiva la caché HTTP del navegador durante la sesión y se bloquean los service workers (sus peticiones saltarían las reglas), así que las funciones sin conexión o de PWA no funcionan. `browser open --locale <bcp47> --timezone <IANA> --geolocation <lat,lon[,precisión]>` (con latitud negativa use `--geolocation=-34.6,-58.4`) fija `navigator.language`, la zona horaria de `Intl` y `Date`, y una posición fija de `navigator.geolocation` (se concede el permiso); `browser open` y `browser status` los muestran.
- `element check|uncheck --ref <ref>` (interact) marca o desmarca de forma idempotente una casilla, un botón de opción o un interruptor (nativo o ARIA): `data {ref, checked, changed}`, no se hace clic si ya está en ese estado, y un botón de opción no se puede desmarcar. `page pdf [--format A4|Letter|Legal] [--landscape] [--background] [--output <archivo>]` imprime la pestaña activa en un PDF (0600; solo sesiones sin ventana) y devuelve `{file, bytes, pages}`.
- `page wait --for text-gone|ref-hidden` espera a que desaparezca un indicador de carga, `--within <ref>` limita la espera de texto a un elemento, y `--for request --value <subcadena o /regex/flags>` (con `--method`, `--since-index`) espera una solicitud que terminó después del último clic, relleno o navegación (el valor es una subcadena o `/regex/imsu` de hasta 200 caracteres). `text-gone` y `ref-hidden` devuelven `wasPresent: false` si el objetivo nunca fue visible. `element click` también admite `--count 1..3`, `--button` y `--modifiers` (interact).
- Una referencia (como `e12` o `f3e4`) solo es válida para la instantánea de la que procede. Después de un clic o una navegación, tome una nueva (`REF_NOT_FOUND` significa que la página cambió).
- Las sesiones se cierran solas tras 30 minutos de inactividad (`--idle-timeout`, de 1 a 1440 minutos, lo cambia). Un `TIMEOUT` en una acción que cambia estado puede haberse aplicado igualmente: tome una instantánea antes de reintentar. Si un clic, una pulsación de tecla o una descarga agota el tiempo porque su solicitud nunca recibe respuesta, la navegación pendiente se cancela y el siguiente comando no queda bloqueado detrás de ella.
- `--output <archivo>` (snapshot, screenshot) (también `element download` y `diag request`) falla con `CONFLICT` si el archivo existe, salvo `--if-exists overwrite`; se rechazan directorios y enlaces simbólicos, y la escritura pasa por un archivo temporal privado en la carpeta de destino, de modo que un enlace que aparezca después se reemplaza, nunca se sigue. Los valores que empiezan por `-` requieren `--flag=valor`.
- Las instantáneas grandes se truncan en la respuesta; el texto completo se guarda en un archivo privado bajo `.hound/runs/browser/<sesión>/`.
- `bin/hound batch --session-name <s> --file <pasos.json>|- [--continue-on-error] [--max-steps 1..200]` ejecuta varios pasos en una sola llamada para ahorrar idas y vueltas. El archivo es un array JSON de `{"command": "element click", "args": {"ref": "e12"}}` (nombres de flag sin `--`; `session-name` lo fija batch; `timeout` es el único flag universal permitido por paso). Se admiten todos los comandos `page`, `element` y `diag`, y `browser status`. Cada paso se valida antes de empezar con las mismas reglas que el comando independiente, así que no se ejecuta nada si alguno es incorrecto (código de salida 2, `field: steps[i].args.<flag>`). Un argumento de texto puede tomar un valor del `data` de un paso anterior: `"$prev.matches.0.ref"` o `"$steps[1].url"` (empiece un valor con `$$prev` o `$$steps` para un `$prev` / `$steps` literal; cualquier otro `$`, como una contraseña `$$abc`, se pasa tal cual, y los valores tomados de pasos anteriores nunca se alteran); si no se puede resolver, ese paso falla con `INVALID_ARGUMENT`. Los pasos se detienen en el primer fallo, salvo con `--continue-on-error`. El sobre contiene `data {steps: [{i, command, ok, summary, data?, error?}], completed, failed, skipped}`; cualquier fallo da `ok: false` y código de salida 1 (`PARTIAL_SUCCESS` si algún paso tuvo éxito); si ningún paso tuvo éxito, el código de salida es el del propio error del primer fallo, de modo que un error de uso producido al ejecutar el primer paso (por ejemplo `INVALID_ARGUMENT` por una referencia que no se puede resolver) sale con 2. Un booleano en un flag que no es un interruptor se rechaza antes de empezar. Los valores sensibles (`value`, `dialog-text`) nunca se muestran; si los datos de los pasos no caben en un sobre, los últimos pasos conservan solo los campos de archivo y URL, y los resultados completos van a `data.file` (0600).
- `bin/hound script export --session-name <s> [--output <archivo.ts>] [--if-exists overwrite] [--name <prueba>] [--include-query]` convierte lo que se hizo en la sesión en un script para `script run` (véase [Scripts](#scripts)). Exporte antes de cerrar la sesión: el registro de acciones vive en su memoria.

## Sitios con autenticación

```sh
# 1. Se abre una ventana del navegador. Inicie sesión y pulse Enter en la terminal. (Debe hacerlo una persona.)
bin/hound profile login --profile mi-app --url https://app.example.com

# 2. Añada otro sitio al mismo perfil sin repetir el primero. Un perfil existente exige `--mode` explícito (extend conserva sus sitios, replace los descarta).
bin/hound profile login --profile mi-app --url https://admin.example.com --mode extend

# 3. Compruebe todos los sitios del perfil, o uno con --site.
bin/hound profile check --profile mi-app --json

# 4. Reutilice la sesión en una sesión de navegador, una tarea o un script.
bin/hound browser open --session-name app --profile mi-app --json
bin/hound task run --task snapshot --url https://app.example.com/dashboard --profile mi-app --json
```

El perfil se guarda en `.hound/profiles/mi-app.json` (modo `0600`). Los nombres de perfil y de sesión aceptan letras, dígitos, `.`, `_` y `-`.

`profile check` informa `valid`, `expired` o `unknown` en `data.state`, con un motivo y el recuento de cookies por sitio. Su código de salida es `0` cuando la comprobación se ejecuta. La comprobación es heurística: busca formularios de inicio de sesión y URL con aspecto de inicio de sesión.

`profile login` necesita una terminal, por lo que un agente no puede ejecutarlo. `profile delete` exige `--dry-run` (vista previa) o `--yes` (confirmar).

## Scripts

Un script es un único archivo `.ts`, `.js` o `.mjs`. Su exportación por defecto recibe un contexto con `page`, `url`, `outDir`, `args`, `log` y `check`:

```ts
// .hound/scripts/home-h1.ts
export default async function ({ page, url, check }) {
  const response = await page.goto(url, { waitUntil: "load" });
  check("HTTP 2xx", response?.ok() === true, `status ${response?.status()}`);
  check("h1 is visible", await page.getByRole("heading", { level: 1 }).isVisible());
  return { summary: "Home page shows a visible h1" };
}
```

```sh
bin/hound script run --file .hound/scripts/home-h1.ts --url https://example.com --json
```

Los scripts están pensados para pruebas e informes. Guárdelos en `.hound/scripts/`, que está ignorado por git. Un `check()` fallido hace que la ejecución falle con `RUN_FAILED`.

### Exportar una sesión como script

Después de explorar un flujo en una sesión de navegador, `script export` lo escribe como una prueba repetible:

```sh
bin/hound script export --session-name tienda --json          # .hound/runs/browser/tienda/export-<hora>.ts (0600)
bin/hound script run --file <data.file> --url https://tienda.example/carrito --arg email=ana@example.com --arg password=... --json
```

- La sesión conserva en memoria sus últimas 500 acciones correctas: navigate, click, hover, fill, type, select, press, check/uncheck, drag, upload, download, back/forward/reload, selección/apertura/cierre de pestañas, esperas, resize y emulate.
- Las referencias no sobreviven a un cambio de página, así que antes de cada acción la sesión registra un localizador estable del elemento: un test id; si no, rol y nombre accesible, etiqueta, placeholder o texto exacto cuando solo coincide con ese elemento; si no, `#id` o una ruta CSS corta. Cuando nada es único, el script usa `.nth(i)` y un comentario `// TODO verify locator`.
- Los valores rellenados o escritos, las respuestas a `prompt()` y las rutas de archivos subidos nunca se registran. Se convierten en parámetros `--arg` obligatorios con el nombre del campo (`Email address` da `email_address`), listados en la cabecera del script junto con el comando `script run` completo.
- Las URL conservan origen y ruta (los segmentos de ruta con aspecto de token se enmascaran siempre, con un TODO); `--include-query` conserva consultas y fragmentos. El valor de `page wait --for url|request` recibe el mismo trato, pero los valores de `--for text` son texto de la página copiado tal cual en el script: revíselos por si contienen datos personales antes de compartirlo. El texto escrito en editores de texto enriquecido (contenteditable) y en otros campos nunca se usa para nombrar ni localizar un elemento. Las navegaciones en el origen inicial se escriben relativas a `--url`, de modo que la prueba puede ejecutarse contra otro host.
- Comprobaciones (`ctx.check`, en `result.json`): la ruta de la URL después de cada navegación y de los clics que la cambiaron, cada condición de `page wait` y la ruta final. `page wait --for request` queda como TODO. Los ajustes de la sesión, como `--locale` o `--block`, se listan en la cabecera, pero no se reproducen.

### Configuración

Copia `.env.example` a `.env` en la raíz del repo (ignorado por git). La CLI lo carga si existe, sin importar el directorio actual; las variables ya definidas en el entorno tienen prioridad.

| Variable         | Por defecto | Propósito                                                                 |
| ---------------- | ----------- | ------------------------------------------------------------------------- |
| `HOUND_HOME`     | `.hound`    | Raíz de los datos de ejecución (perfiles, ejecuciones, sesiones). Debe seguir ignorada por git. |
| `HOUND_HEADLESS` | `true`      | Modo sin ventana cuando no se indica pantalla (`false` para modo con ventana). `browser open` usa siempre su propia flag `--display` (por defecto `headless`). |

## Resultados (result.json)

Cada ejecución de tarea o de script escribe un `result.json` en su directorio de ejecución. Su `status` es `pass`, `fail` o `error`. La CLI devuelve `ok: true` para `pass` y `ok: false` (`RUN_FAILED` o `RUN_ERROR`, código de salida `1`) en los demás casos, con el mismo resultado en `data`.

| Campo             | Significado                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `status`          | `pass`, `fail` o `error` (la tarea lanzó una excepción, o el navegador no pudo iniciarse). |
| `summary`         | Resultado en una línea, devuelto por la tarea.                                           |
| `checks`          | Aserciones con nombre: `{ name, ok, detail? }`. Cualquier verificación fallida hace que la ejecución sea `fail`. |
| `data`            | Lo que la tarea devolvió como `data`.                                                    |
| `consoleErrors`   | Errores de la consola del navegador, con la ubicación en el script.                      |
| `pageErrors`      | Excepciones no capturadas en la página.                                                  |
| `failedRequests`  | Solicitudes fallidas, o respuestas con HTTP 400 o superior. Las cadenas de consulta se eliminan. |
| `session`         | Solo con `--profile`: `state` (`valid`, `expired`, `unknown`), `reason` y recuentos de cookies. |
| `trace`           | Solo con `--trace`: `{ file, steps, actions, redactions }`, o `{ error }`. Vea más abajo. |
| `files`           | Todos los archivos del directorio de ejecución, incluido `result.json`.                  |

Las URL en los resultados no incluyen cadenas de consulta ni fragmentos. Nunca se registran cabeceras, cookies ni cuerpos de respuesta. Si una ejecución falla, se guarda una captura `failure.png` junto a ella.

### Traza limpia

Añada `--trace on` a `browser open` (y exporte después con `bin/hound diag trace --session-name <nombre> --action export`), o `--trace on|on-failure` a `task run` y `script run`. `on-failure` conserva la traza solo cuando la ejecución no es `pass`. Las trazas sin procesar contienen cookies, cabeceras de autenticación, cuerpos de solicitudes y valores de formularios, por lo que sitehound nunca conserva una: graba en un directorio temporal privado, escribe una copia redactada y borra siempre el archivo original, incluso si la limpieza falla.

```sh
bin/hound script run --file .hound/scripts/login-test.ts --url https://example.com --profile trabajo --trace on-failure --json
pnpm exec playwright show-trace .hound/runs/exec-login-test/<marca de tiempo>/debug-trace.zip
```

| Archivo           | Contenido                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `debug-trace.zip` | La traza limpia. Se abre con `playwright show-trace`: acciones, instantáneas del DOM, consola y lista de red. Sin grabación de pantalla. |
| `steps.json`      | Acciones ordenadas (título, selector, parámetros redactados, hora de inicio, duración, error) y errores de consola, para que un agente pueda depurar sin descomprimir. |

`result.json` → `trace.redactions` cuenta lo que se eliminó (`headers`, `cookies`, `bodies`, `inputValues`, `urls`). Si la limpieza falla, `trace` contiene un `error` breve y no se conserva ningún archivo parcial.

Lo que la traza limpia conserva: nombres de acción, selectores y tiempos; la estructura del DOM y el texto visible de cada instantánea; CSS, imágenes y fuentes; la lista de red (método, estado, tipo de contenido, tamaños, tiempos) con las URL reducidas a origen y ruta; texto de errores y advertencias de consola (redactado, 300 caracteres como máximo); mensajes de error recortados a una longitud segura.

Lo que elimina, de forma conservadora:

- Grabación de pantalla: no se registran capturas ni fotogramas de vídeo, porque los píxeles pueden mostrar valores escritos. Las instantáneas del DOM (con los valores de formulario en blanco) son el registro visual. `failure.png` es un artefacto aparte, no parte de la traza.
- Red: todas las cabeceras salvo `content-type`, `content-length`, `accept`, `cache-control` y `location` (sin consulta); cookies, listas de consulta y cuerpos de solicitud; cuerpos de respuesta salvo CSS, imágenes y fuentes; cadenas de consulta y fragmentos en todas las URL; segmentos de ruta con aspecto de token (se muestran como `:token`).
- Opciones de contexto: estado de almacenamiento, cabeceras extra, credenciales HTTP, proxy y certificados de cliente.
- Acciones: los valores de toda llamada que introduce datos (`fill`, `type`, `pressSequentially`, `selectOption`, `setInputFiles`, texto del teclado, pulsaciones de teclas imprimibles), en parámetros, títulos, registros de llamadas y textos de error, sea cual sea el selector; parámetros de código y de marcado (expresiones de `evaluate`, scripts de inicialización, HTML de `setContent`); argumentos y valores devueltos de `evaluate` distintos de números y booleanos; cualquier parámetro cuyo nombre parezca un secreto.
- Instantáneas del DOM: todos los valores de formulario (campos, áreas de texto, opciones, botones, casillas), el texto de áreas de texto y elementos `contenteditable`, campos ocultos, metaetiquetas CSRF y atributos con aspecto de secreto; consultas en atributos de URL, valores `data-*` y CSS (`url()`, `@import`).
- Consola: el texto y todos los argumentos de `log`, `info` y `debug` (solo se conservan el tipo y la ubicación).
- Cualquier cadena: los JWT, los valores `Bearer` y las secuencias largas de letras y dígitos (24 caracteres o más) se sustituyen por `[token]`.
- Cualquier cosa que el limpiador no reconozca.

Límites: el texto visible de la página, los orígenes y rutas de URL y el título de la página se conservan tal como se registraron, y pueden contener datos personales; la traza sigue siendo un dato privado de ejecución: no la suba al repositorio ni la comparta nunca. Los archivos de traza sin procesar de Playwright se guardan en un directorio privado bajo `.hound/tmp/traces/` mientras el navegador funciona, y se eliminan al terminar la ejecución.

## Captura de componentes

```sh
bin/hound task run --task component --url https://example.com --arg selector=<css> --arg viewports=375,768,1280 --arg states=hover,focus --json
```

Para cada viewport, la ejecución escribe, bajo `.hound/runs/component/<marca de tiempo>/<ancho>/`:

- `page.png`: captura de página completa.
- `element.png`: captura del elemento.
- `element.html`: el HTML del elemento.
- `styles.json`: un árbol de estilos calculados que difieren de los valores por defecto del navegador, más las propiedades personalizadas.
- `assets.json`: los recursos que usa el elemento, sin cadenas de consulta.
- Con `--arg states=...`: `element.<estado>.png` y `styles.<estado>.json`, con lo que cambió al pasar el puntero o al enfocar.

La lista de archivos está en el resultado JSON, en `data.files`. Use las capturas y el HTML como referencia, y `styles.json` para reconstruir el marcado y el CSS.

## Agentes y MCP

[AGENTS.md](AGENTS.md) explica cómo debe usar sitehound un agente de IA: el sobre JSON, los códigos de error, el nivel de lectura y las reglas que se aplican a los datos con inicio de sesión.

### La skill `sitehound`

`.claude/skills/sitehound/SKILL.md` es una skill corta de Claude Code que enseña a un agente a usar la CLI. Dentro de este repositorio se carga sola. Para usarla desde cualquier otro proyecto, ponga `hound` en el PATH y enlace la skill en sus skills de usuario:

```sh
ln -s /ruta/a/sitehound/bin/hound ~/.local/bin/hound
ln -s /ruta/a/sitehound/.claude/skills/sitehound ~/.claude/skills/sitehound
```

Después pida al agente que navegue, pruebe o lea un sitio, o invoque `/sitehound` explícitamente. La skill le indica al agente que:

- pase siempre `--json --no-input` y consulte las opciones con `--schema`;
- abra las sesiones en nivel de lectura y use `--actions interact` solo cuando usted pidió cambiar algo;
- use `page find` para localizar elementos sin leer toda la instantánea, `element type` en campos que buscan mientras se escribe, `element read` para el texto o un atributo de un elemento, `element download` para archivos exportados y `diag request` para ver el cuerpo redactado de una petición o respuesta;
- use `browser open --viewport`, `page resize` y `page emulate` para revisar diseños adaptables, modo oscuro y estilos de impresión;
- deje los diálogos cancelados salvo que usted haya pedido la acción que los provoca, y suba solo los archivos que usted indicó, nunca secretos;
- deje las capturas en `.hound/runs/`, la carpeta privada de sitehound, o escriba `--output` solo en una carpeta de `mktemp -d` o en una carpeta ignorada por git, nunca en rutas versionadas o compartidas;
- se detenga y le pregunte cuando haga falta iniciar sesión o un perfil haya expirado.

Los datos de ejecución quedan siempre en `.hound/` de sitehound, sea cual sea el directorio actual del agente.

Obsoleto: `bin/hound mcp` ejecuta el servidor MCP oficial de Playwright por stdio, con un perfil precargado en memoria. Prefiera los comandos de la CLI anteriores. Si aún lo necesita, regístrelo en Claude Code:

```sh
claude mcp add sitehound -- pnpm --silent --dir /ruta/a/sitehound hound mcp --profile mi-app
```

El servidor MCP expone todas sus herramientas, incluida `browser_evaluate`. Úselo solo en sitios que esté autorizado a utilizar.

## Escribir una tarea

Una tarea es un paquete de workspace en `tasks/<nombre>/` cuyo `index.ts` exporta por defecto `defineTask(...)`.

```jsonc
// tasks/page-title/package.json
{
  "name": "@sitehound/task-page-title",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./index.ts",
  "dependencies": { "@sitehound/core": "workspace:*" }
}
```

```ts
// tasks/page-title/index.ts
import { defineTask } from "@sitehound/core";

export default defineTask({
  name: "page-title",
  description: "Prints the title of a page.",
  async run({ page, url, outDir, args, log, check }) {
    await page.goto(url);
    const title = await page.title();
    check("title is not empty", title.length > 0);
    log(`${title} (extra flags: ${JSON.stringify(args)})`);
    return { summary: "Title read", data: { title } };
  },
});
```

Ejecute `corepack pnpm install` una vez para enlazar el paquete nuevo, y después:

```sh
bin/hound task run --task page-title --url https://example.com --json
```

La tarea recibe un contexto con:

| Campo     | Descripción                                                                              |
| --------- | ---------------------------------------------------------------------------------------- |
| `url`     | La URL pasada en la línea de comandos.                                                   |
| `page`    | Un `Page` de Playwright, ya en un contexto con el perfil elegido.                        |
| `context` | El `BrowserContext` de Playwright.                                                       |
| `outDir`  | Directorio de ejecución privado, ignorado por git: `.hound/runs/<tarea>/<marca de tiempo>`. |
| `args`    | Argumentos extra pasados con `--arg clave=valor`.                                        |
| `log`     | Antepone el nombre de la tarea a los mensajes y los imprime. No registre contenido de página. |
| `check`   | `check(nombre, ok, detalle?)` registra una aserción en `result.json` y devuelve `ok`. Una verificación fallida hace fallar la ejecución. |

La tarea puede devolver `{ status?, summary?, data? }`. `summary` y `data` se escriben en `result.json`. Una verificación fallida siempre hace fallar la ejecución; un `status` devuelto solo puede degradar un `pass` a `fail`. Con `--profile`, una sesión que parezca caducada al final también hace fallar la ejecución.

`@sitehound/capture` ofrece funciones auxiliares que las tareas combinan:

- `capturePage(page, outDir)`: guarda `page.html`, `screenshot.png` y `meta.json`. Lo usa `snapshot`.
- `captureText(page, outDir)`: guarda `text.md` (texto visible) y `aria.yml` (árbol de accesibilidad).
- `captureElement(page, selector, outDir, opts)`: guarda el elemento y sus estilos, recursos y estados de puntero y foco. Lo usa `component`.

## Estructura del proyecto

```text
.
├── .claude/                 Instrucciones y ajustes de Claude Code, y la skill sitehound
├── .githooks/pre-commit     Bloquea commits que incluyen sesiones o secretos
├── .github/workflows/ci.yml Comprobación de tipos
├── bin/hound                Punto de entrada de la CLI (fija Node mediante fnm)
├── packages/
│   ├── core/                Sesiones, demonio de navegador (browserd/), perfiles, ejecuciones, resultados, rutas, errores y API de tareas
│   ├── capture/             Auxiliares de captura de página, texto y elemento
│   └── cli/                 La CLI: framework/ (análisis de argumentos, sobre, ayuda, schema) y commands/ (un archivo por dominio, más batch)
├── tasks/
│   ├── component/           Captura de componentes (captura, HTML, estilos, estados)
│   └── snapshot/            Instantánea de página (captura, HTML, texto, árbol de accesibilidad)
├── AGENTS.md                Instrucciones para agentes de IA que usan sitehound
├── .hound/                  Datos de ejecución (ignorados por git)
├── .env.example
├── .nvmrc
├── LICENSE                  MIT
├── README.md
├── README.es.md
└── SECURITY.md
```

## Seguridad

Un perfil guardado concede acceso a la cuenta de la que se creó. Trátelo como una contraseña.

- Todos los datos de ejecución viven en `.hound/`, que está ignorado por git y contiene su propio `.gitignore` con `*`.
- Un hook de pre-commit bloquea sesiones, archivos HAR, trazas, archivos `.env`, claves y patrones comunes de cookies y tokens en lo que se prepara para el commit.
- Los perfiles y las capturas se escriben con permisos `0600`; los directorios de ejecución, con `0700`.
- Ninguna dependencia tiene permitido ejecutar scripts de instalación.
- Una política de antigüedad mínima de publicación de pnpm limita la exposición a la cadena de suministro a paquetes publicados recientemente.

Consulte [SECURITY.md](SECURITY.md) para más detalles y para saber cómo reportar una vulnerabilidad.

## Hoja de ruta

Planificado, no implementado:

- Rastreo de sitios (Crawlee)
- Comparación visual (odiff)
- Captura completa de red y HAR para pruebas de datos. Hoy `diag network` y `result.json` solo listan solicitudes fallidas y errores HTTP.
- Análisis (axe-core, Lighthouse)
- Clonación de páginas y sitios (SingleFile, wget/Browsertrix)
- Exploración asistida por IA (Stagehand). Hoy los agentes controlan sesiones de navegador a través de la CLI; Stagehand no se usa.
- Modo sigiloso (Patchright)
- Entorno de ejecución Bun, cuando el soporte de Playwright sea estable

Ya implementado: sesiones de navegador y captura de `component` (marcado, estilos y estados de un componente). La clonación de componentes, es decir, la generación automática de código a partir de una captura, no está implementada.

## Uso responsable

Use sitehound solo en sitios que sean suyos o que esté autorizado a probar. Respete los términos de servicio, el `robots.txt` y los derechos de autor de cada sitio.

## Licencia

[MIT](LICENSE)
