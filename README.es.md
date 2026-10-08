[English](README.md) · **Español**

# sitehound

Arnés de navegador agnóstico a la tarea para explorar, probar (visual y de datos), analizar y clonar sitios web. Construido con TypeScript y Playwright.

Funciona con sitios públicos y con sitios protegidos por inicio de sesión: usted inicia sesión manualmente una sola vez y la sesión guardada se reutiliza en ejecuciones posteriores.

> **Estado:** etapa temprana (v0.1.0). Hoy existen el núcleo, la CLI y una tarea de ejemplo (`snapshot`). Consulte la [hoja de ruta](#hoja-de-ruta).

## Características

- **Sesiones reutilizables.** Inicie sesión manualmente una vez; las cookies, localStorage e IndexedDB se guardan como un perfil con nombre y se cargan con `--profile`.
- **Núcleo agnóstico.** El arnés abre un navegador, carga un perfil y entrega una página a una tarea. Cada caso de uso vive en su propio paquete de tarea.
- **Privado por defecto.** Todos los datos de ejecución van a un directorio `.hound/` ignorado por git, con permisos restrictivos.
- **CLI pequeña.** Cinco comandos: `login`, `run`, `tasks`, `profiles`, `forget`.

## Requisitos

- Node.js >= 22 (vea `.nvmrc`)
- pnpm 12, mediante corepack

## Inicio rápido

```sh
corepack enable
pnpm install
pnpm browsers        # instala Chromium para Playwright
pnpm hound run snapshot https://example.com
```

La tarea `snapshot` escribe una captura de pantalla de la página completa, el HTML renderizado y metadatos básicos en un directorio de ejecución privado, en `.hound/runs/snapshot/<timestamp>/`.

## Uso

```sh
pnpm hound login <url> --profile <name>      # inicia sesión a mano una vez; la sesión se guarda
pnpm hound run <task> <url> [--profile <name>] [--headed] [task flags]
pnpm hound tasks                             # lista las tareas disponibles
pnpm hound profiles                          # lista los perfiles guardados
pnpm hound forget <profile>                  # elimina un perfil guardado
```

### Sitios con autenticación

```sh
# 1. Se abre una ventana del navegador. Inicie sesión y presione Enter en la terminal.
pnpm hound login https://app.example.com --profile my-app

# 2. Reutilice la sesión en cualquier ejecución.
pnpm hound run snapshot https://app.example.com/dashboard --profile my-app
```

La sesión se almacena en `.hound/profiles/my-app.json` (modo `0600`). Los nombres de perfiles y tareas admiten letras, dígitos, `.`, `_` y `-`.

### Configuración

Copie `.env.example` a `.env` (ignorado por git). La CLI lo carga si existe.

| Variable            | Valor por defecto | Propósito                                                                      |
| ------------------- | ----------------- | ------------------------------------------------------------------------------ |
| `HOUND_HOME`        | `.hound`          | Raíz de los datos de ejecución (perfiles, corridas). Debe seguir ignorada por git. |
| `HOUND_HEADLESS`    | `true`            | Ejecuta sin interfaz por defecto; `--headed` lo anula por comando.             |
| `ANTHROPIC_API_KEY` | vacío             | Opcional. Reservada para tareas asistidas por IA; el código actual no la usa.  |

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
  async run({ page, url, outDir, args, log }) {
    await page.goto(url);
    log(`${await page.title()} (flags adicionales: ${JSON.stringify(args)})`);
  },
});
```

Ejecute `pnpm install` una vez para enlazar el nuevo paquete y luego:

```sh
pnpm hound run page-title https://example.com
```

La tarea recibe un contexto con:

| Campo     | Descripción                                                                  |
| --------- | ---------------------------------------------------------------------------- |
| `url`     | La URL indicada en la línea de comandos.                                     |
| `page`    | Un `Page` de Playwright, ya dentro de un contexto con el perfil elegido.     |
| `context` | El `BrowserContext` de Playwright.                                           |
| `outDir`  | Directorio de ejecución privado e ignorado por git: `.hound/runs/<task>/<timestamp>`. |
| `args`    | Flags adicionales (`--flags`) de la línea de comandos.                       |
| `log`     | Antepone el nombre de la tarea a los mensajes y los imprime.                 |

`@sitehound/capture` ofrece `capturePage(page, outDir)`, usada por `snapshot`, para guardar el HTML, una captura de pantalla y metadatos.

## Estructura del proyecto

```text
.
├── .claude/                 Instrucciones y configuración del proyecto para Claude Code
├── .githooks/pre-commit     Bloquea commits que incluyen sesiones o secretos
├── .github/workflows/ci.yml Verificación de tipos
├── packages/
│   ├── core/                Sesiones, perfiles, rutas, API de tareas
│   ├── capture/             Utilidades de captura de páginas
│   └── cli/                 El comando `pnpm hound`
├── tasks/
│   └── snapshot/            Tarea de ejemplo
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
- Captura de red y HAR para pruebas de datos
- Análisis (axe-core, Lighthouse)
- Clonación de componentes, páginas y sitios (SingleFile, wget/Browsertrix)
- Exploración asistida por IA (Stagehand)
- Modo sigiloso (Patchright)
- Entorno de ejecución Bun, cuando el soporte de Playwright sea estable

## Uso responsable

Utilice sitehound únicamente en sitios que usted posea o que esté autorizado a probar. Respete los términos de servicio, el archivo `robots.txt` y los derechos de autor de cada sitio.

## Licencia

[MIT](LICENSE)
