[English](README.md) · **Español**

# sitehound

Arnés de navegador agnóstico a la tarea para explorar, probar (visual y de datos), analizar y clonar sitios web. Construido con TypeScript y Playwright.

Funciona con sitios públicos y con sitios protegidos por inicio de sesión: usted inicia sesión manualmente una sola vez y la sesión guardada se reutiliza en ejecuciones posteriores.

> **Estado:** etapa temprana (v0.1.0). Hoy existen el núcleo, la CLI, dos tareas integradas (`snapshot` y `component`), scripts `exec` de un solo archivo, `check` y un puente hacia MCP. Consulte la [hoja de ruta](#hoja-de-ruta).

## Características

- **Sesiones reutilizables.** Inicie sesión manualmente una vez; las cookies, localStorage e IndexedDB se guardan como un perfil con nombre y se cargan con `--profile`.
- **Núcleo agnóstico.** El arnés abre un navegador, carga un perfil y entrega una página a una tarea. Cada caso de uso vive en su propio paquete de tarea o en un script de un solo archivo.
- **Resultados estructurados.** Cada ejecución escribe un `result.json` con comprobaciones, errores, solicitudes fallidas y estado de la sesión.
- **Listo para agentes.** Scripts para pruebas repetibles y un servidor MCP con un perfil precargado. Consulte [AGENTS.md](AGENTS.md).
- **Privado por defecto.** Todos los datos de ejecución van a un directorio `.hound/` ignorado por git, con permisos restrictivos.
- **CLI pequeña.** `login`, `run`, `exec`, `check`, `mcp`, `tasks`, `profiles`, `forget`.

## Requisitos

- Node.js 22.22.2, fijado en `.nvmrc` (es el único lugar donde se define la versión de Node)
- pnpm 12, mediante corepack
- Agentes de IA: vea [AGENTS.md](AGENTS.md) ("Running commands") para ejecutar los comandos con fnm y la versión de Node fijada.

## Inicio rápido

Instale [fnm](https://github.com/Schniz/fnm) y agregue su hook de shell una sola vez, para que Node cambie de versión al entrar en el repositorio:

```sh
# fish (config.fish)
fnm env --use-on-cd | source
# bash / zsh (.bashrc / .zshrc)
eval "$(fnm env --use-on-cd)"
```

Después:

```sh
fnm install          # lee .nvmrc
fnm use
corepack enable
pnpm install
pnpm browsers        # instala Chromium para Playwright
pnpm hound run snapshot https://example.com
```

Si usa nvm en su lugar, `nvm use` también lee `.nvmrc`.

La tarea `snapshot` escribe una captura de pantalla de la página completa, el HTML renderizado, el texto visible, un árbol de accesibilidad y metadatos básicos en un directorio de ejecución privado, en `.hound/runs/snapshot/<timestamp>/`, junto con un `result.json`.

## Uso

```sh
pnpm hound login <url> --profile <name>      # inicia sesión a mano una vez; la sesión se guarda
pnpm hound run <task> <url> [--profile <name>] [--headed] [task flags]
pnpm hound exec <file.ts> <url> [--profile <name>] [--headed] [flags]
pnpm hound check <profile>                   # ¿la sesión guardada sigue siendo válida? (0 válida, 2 expirada, 3 desconocida)
pnpm hound mcp [--profile <name>] [--headed] [-- <flags de @playwright/mcp>]
pnpm hound tasks                             # lista las tareas disponibles
pnpm hound profiles                          # lista los perfiles guardados
pnpm hound forget <profile>                  # elimina un perfil guardado
```

Los flags aceptan `--clave valor` o `--clave=valor`. Un flag sin valor equivale a `true`. Los flags de la tarea van después de la URL.

### Sitios con autenticación

```sh
# 1. Se abre una ventana del navegador. Inicie sesión y presione Enter en la terminal.
pnpm hound login https://app.example.com --profile my-app

# 2. Compruebe que la sesión siga siendo válida antes de un trabajo con sesión iniciada.
pnpm hound check my-app

# 3. Reutilice la sesión en cualquier ejecución.
pnpm hound run snapshot https://app.example.com/dashboard --profile my-app
```

La sesión se almacena en `.hound/profiles/my-app.json` (modo `0600`). Los nombres de perfiles y tareas admiten letras, dígitos, `.`, `_` y `-`.

`check` abre el perfil, navega a la página donde inició sesión e informa `valid`, `expired` o `unknown` con un motivo. La comprobación es heurística: busca formularios de inicio de sesión y URLs con apariencia de inicio de sesión.

### Scripts exec

Un script `exec` es un único archivo `.ts` sin importaciones. Su exportación por defecto recibe un contexto con `page`, `url`, `outDir`, `args`, `log` y `check`:

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
pnpm hound exec .hound/scripts/home-h1.ts https://example.com
```

Los scripts están pensados para pruebas e informes. Guárdelos en `.hound/scripts/`, que está ignorado por git.

### Configuración

Copie `.env.example` a `.env` (ignorado por git). La CLI lo carga si existe.

| Variable            | Valor por defecto | Propósito                                                                      |
| ------------------- | ----------------- | ------------------------------------------------------------------------------ |
| `HOUND_HOME`        | `.hound`          | Raíz de los datos de ejecución (perfiles, corridas). Debe seguir ignorada por git. |
| `HOUND_HEADLESS`    | `true`            | Ejecuta sin interfaz por defecto; `--headed` lo anula por comando.             |
| `ANTHROPIC_API_KEY` | vacío             | Opcional. Reservada para tareas asistidas por IA; el código actual no la usa.  |

## Resultados (result.json)

Cada `run` y `exec` escribe `result.json` en su directorio de ejecución. El código de salida es `0` para `pass` y `1` en los demás casos.

| Campo             | Significado                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `status`          | `pass`, `fail` o `error` (la tarea lanzó una excepción o el navegador no pudo iniciarse).            |
| `summary`         | Resultado en una línea, devuelto por la tarea.                                                       |
| `checks`          | Aserciones con nombre: `{ name, ok, detail? }`. Cualquier comprobación fallida hace que la ejecución sea `fail`. |
| `data`            | Lo que la tarea devolvió como `data`.                                                                |
| `consoleErrors`   | Errores de la consola del navegador, con la ubicación del script.                                    |
| `pageErrors`      | Excepciones no capturadas en la página.                                                              |
| `failedRequests`  | Solicitudes fallidas, o respuestas con HTTP 400 o superior. Se eliminan las cadenas de consulta.     |
| `session`         | Solo con `--profile`: `state` (`valid`, `expired`, `unknown`), `reason` y conteos de cookies.        |
| `trace`           | Solo con `--trace`: `{ file, steps, actions, redactions }`, o `{ error }`. Véase más abajo.          |
| `files`           | Todos los archivos del directorio de ejecución, incluido `result.json`.                              |

Las URL en los resultados no incluyen la cadena de consulta ni el fragmento. Nunca se registran encabezados, cookies ni cuerpos de respuesta. Si una ejecución falla, se guarda junto a ella una captura `failure.png`.

### Traza limpia

Añada `--trace` a `run` o `exec` para grabar una traza de Playwright. Con `--trace on-failure` solo se conserva cuando la ejecución no termina en `pass`. Las trazas sin procesar contienen cookies, encabezados de autenticación, cuerpos de solicitudes y valores de formularios, por lo que sitehound nunca conserva una: graba en un directorio temporal privado, escribe una copia depurada y siempre borra el archivo original, incluso si la limpieza falla.

```sh
pnpm hound exec .hound/scripts/login-test.ts https://example.com --profile work --trace on-failure
pnpm exec playwright show-trace .hound/runs/exec-login-test/<timestamp>/debug-trace.zip
```

| Archivo           | Contenido                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `debug-trace.zip` | La traza limpia. Se abre con `playwright show-trace`: acciones, instantáneas del DOM, consola y lista de red. Sin screencast. |
| `steps.json`      | Acciones en orden (título, selector, parámetros depurados, inicio, duración, error) y errores de consola, para que un agente pueda depurar sin descomprimir. |

En `result.json`, `trace.redactions` cuenta lo que se eliminó (`headers`, `cookies`, `bodies`, `inputValues`, `urls`). Si la limpieza falla, `trace` contiene un `error` breve y no se conserva ningún archivo parcial.

Lo que la traza limpia conserva: nombres de acciones, selectores y tiempos; la estructura del DOM y el texto visible de cada instantánea; CSS, imágenes y fuentes; la lista de red (método, estado, tipo de contenido, tamaños y tiempos) con las URL reducidas a origen y ruta; el texto de la consola solo para errores y advertencias (depurado, 300 caracteres como máximo); mensajes de error recortados a una longitud segura.

Lo que elimina, de forma conservadora:

- Screencast: no se graban capturas ni fotogramas de vídeo, porque los píxeles pueden mostrar valores escritos. Las instantáneas del DOM (con los valores de formulario en blanco) son el registro visual. `failure.png` es un artefacto aparte y explícito, no forma parte de la traza.
- Red: todos los encabezados salvo `content-type`, `content-length`, `accept`, `cache-control` y `location` (sin la cadena de consulta); cookies, listas de consulta y cuerpos de solicitud; cuerpos de respuesta salvo CSS, imágenes y fuentes; cadenas de consulta y fragmentos en todas las URL; segmentos de ruta con aspecto de token (se muestran como `:token`).
- Opciones del contexto: estado de almacenamiento, encabezados adicionales, credenciales HTTP, proxy y certificados de cliente.
- Acciones: los valores de toda llamada que introduce datos (`fill`, `type`, `pressSequentially`, `selectOption`, `setInputFiles`, texto del teclado, pulsaciones de teclas imprimibles), en parámetros, títulos, registros de la llamada y mensajes de error, sea cual sea el selector; parámetros de código y marcado (expresiones de `evaluate`, scripts de inicio, HTML de `setContent`); argumentos de evaluación y valores devueltos que no sean números ni booleanos; cualquier parámetro cuyo nombre parezca un secreto.
- Instantáneas del DOM: todos los valores de formulario (inputs, áreas de texto, opciones, botones, casillas), el texto dentro de áreas de texto y elementos `contenteditable`, campos ocultos, metaetiquetas CSRF y atributos con nombre de secreto; cadenas de consulta en atributos de URL, valores `data-*` y CSS (`url()`, `@import`).
- Consola: el texto de `log`, `info` y `debug` y todos los argumentos (solo se conservan el tipo y la ubicación).
- Cualquier cadena: los JWT, los valores `Bearer` y las secuencias largas de letras y dígitos (24 caracteres o más) se sustituyen por `[token]`.
- Todo lo que el limpiador no reconoce.

Límites: el texto visible de la página, el origen y la ruta de las URL y el título de la página se conservan tal como se grabaron y pueden contener datos personales; la traza sigue siendo salida privada de la ejecución: no la suba al repositorio ni la comparta. Los archivos de traza sin procesar de Playwright viven en un directorio privado bajo `.hound/tmp/traces/` mientras el navegador está abierto y se eliminan al terminar la ejecución.

## Captura de componentes

```sh
pnpm hound run component https://example.com --selector "h1" --viewports 375,768,1280 --states hover,focus
```

Para cada viewport, la ejecución escribe, en `.hound/runs/component/<timestamp>/<width>/`:

- `page.png`: captura de la página completa.
- `element.png`: captura del elemento.
- `element.html`: el HTML del elemento.
- `styles.json`: un árbol de estilos calculados que difieren de los valores por defecto del navegador, más las propiedades personalizadas.
- `assets.json`: los recursos que usa el elemento, sin cadenas de consulta.
- Con `--states`: `element.<state>.png` y `styles.<state>.json`, con los cambios al pasar el cursor o al enfocar.

La lista de archivos está en `result.json`, bajo `data.files`. Use las capturas y el HTML como referencia, y `styles.json` para reconstruir el marcado y el CSS.

## Agentes y MCP

[AGENTS.md](AGENTS.md) explica cómo debe usar sitehound un agente de IA: cuándo escribir un script `exec`, cuándo usar el servidor interactivo `mcp`, cómo leer los resultados y qué reglas aplican a los datos de sesiones iniciadas.

`pnpm hound mcp` ejecuta el servidor oficial de Playwright MCP por stdio, con un perfil precargado en memoria. Para registrarlo en Claude Code:

```sh
claude mcp add sitehound -- pnpm --silent --dir /path/to/sitehound hound mcp --profile my-app
```

El servidor MCP expone todas sus herramientas, incluida `browser_evaluate`. Úselo únicamente en sitios que esté autorizado a usar.

## Escribir una tarea

Una tarea es un paquete del workspace en `tasks/<name>/` cuyo `index.ts` exporta por defecto `defineTask(...)`.

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
  description: "Imprime el título de una página.",
  async run({ page, url, outDir, args, log, check }) {
    await page.goto(url);
    const title = await page.title();
    check("title is not empty", title.length > 0);
    log(`${title} (flags adicionales: ${JSON.stringify(args)})`);
    return { summary: "Title read", data: { title } };
  },
});
```

Ejecute `pnpm install` una vez para enlazar el nuevo paquete y luego:

```sh
pnpm hound run page-title https://example.com
```

La tarea recibe un contexto con:

| Campo     | Descripción                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------- |
| `url`     | La URL indicada en la línea de comandos.                                                       |
| `page`    | Un `Page` de Playwright, ya dentro de un contexto con el perfil elegido.                       |
| `context` | El `BrowserContext` de Playwright.                                                             |
| `outDir`  | Directorio de ejecución privado e ignorado por git: `.hound/runs/<task>/<timestamp>`.          |
| `args`    | Flags adicionales (`--flags`) de la línea de comandos.                                         |
| `log`     | Antepone el nombre de la tarea a los mensajes y los imprime. No registre el contenido de la página. |
| `check`   | `check(name, ok, detail?)` registra una aserción en `result.json` y devuelve `ok`. Una comprobación fallida hace fallar la ejecución. |

La tarea puede devolver `{ status?, summary?, data? }`. `summary` y `data` se escriben en `result.json`. Una comprobación fallida siempre hace fallar la ejecución; un `status` devuelto solo puede bajar un `pass` a `fail`. Con `--profile`, una sesión que parece caducada al final también hace fallar la ejecución.

`@sitehound/capture` ofrece utilidades que las tareas pueden componer:

- `capturePage(page, outDir)`: guarda `page.html`, `screenshot.png` y `meta.json`. La usa `snapshot`.
- `captureText(page, outDir)`: guarda `text.md` (texto visible) y `aria.yml` (árbol de accesibilidad).
- `captureElement(page, selector, outDir, opts)`: guarda el elemento y sus estilos, recursos y estados de cursor o foco. La usa `component`.

## Estructura del proyecto

```text
.
├── .claude/                 Instrucciones y configuración del proyecto para Claude Code
├── .githooks/pre-commit     Bloquea commits que incluyen sesiones o secretos
├── .github/workflows/ci.yml Verificación de tipos
├── packages/
│   ├── core/                Sesiones, perfiles, ejecuciones, resultados, rutas, API de tareas
│   ├── capture/             Utilidades de captura de página, texto y elementos
│   └── cli/                 El comando `pnpm hound`, incluido el puente hacia MCP
├── tasks/
│   ├── component/           Captura de componentes (captura de pantalla, HTML, estilos, estados)
│   └── snapshot/            Captura de página (captura de pantalla, HTML, texto, árbol de accesibilidad)
├── AGENTS.md                Instrucciones para agentes de IA que usan sitehound
├── .hound/                  Datos de ejecución (ignorado por git)
├── .env.example
├── .nvmrc
├── LICENSE                  MIT
├── README.md
├── README.es.md
└── SECURITY.md
```

## Seguridad

Un perfil guardado otorga acceso a la cuenta para la que fue creado. Trátelo como una contraseña.

- Todos los datos de ejecución viven en `.hound/`, ignorado por git, que además contiene su propio `.gitignore` con `*`.
- Un hook de pre-commit bloquea sesiones, archivos HAR, trazas, archivos `.env`, claves y patrones comunes de cookies y tokens en el área de preparación.
- Los perfiles y las capturas se escriben con permisos `0600`; los directorios de ejecución, con `0700`.
- Solo `esbuild` tiene permitido ejecutar scripts de instalación.
- Una política de antigüedad mínima de lanzamiento de pnpm (minimum-release-age) reduce la exposición a paquetes recién publicados en la cadena de suministro.

Consulte [SECURITY.md](SECURITY.md) para más detalles y para reportar una vulnerabilidad.

## Hoja de ruta

Planificado, aún no implementado:

- Rastreo (Crawlee)
- Diferencias visuales (odiff)
- Captura completa de red y HAR para pruebas de datos. Hoy `result.json` solo lista las solicitudes fallidas y los errores HTTP.
- Análisis (axe-core, Lighthouse)
- Clonación de páginas y sitios (SingleFile, wget/Browsertrix)
- Exploración asistida por IA (Stagehand). El comando `mcp` ya da a los agentes control interactivo del navegador, pero no se usa Stagehand.
- Modo sigiloso (Patchright)
- Entorno de ejecución Bun, cuando el soporte de Playwright sea estable

Ya implementado: la captura de componentes con `component` (marcado, estilos y estados de un componente). La clonación de componentes, es decir, la generación automática de código a partir de una captura, no está implementada.

## Uso responsable

Utilice sitehound únicamente en sitios que usted posea o que esté autorizado a probar. Respete los términos de servicio, el archivo `robots.txt` y los derechos de autor de cada sitio.

## Licencia

[MIT](LICENSE)
