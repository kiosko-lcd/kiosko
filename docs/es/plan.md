# Tessera: plan de diseño

*De aimonitor (un tablero fijo para un Trofeo Vision) a un sistema de widgets
con editor visual que cualquiera pueda instalar en su panel.*

Documento de diseño del 2026-11-08. Recoge las decisiones tomadas, por qué, y
lo que queda pendiente. El código que lo implementa está en este mismo repo.

---

## 0. Resumen en diez líneas

1. **Proyecto nuevo** (`tessera`, nombre provisional) en vez de seguir
   cargando aimonitor: aimonitor es un producto personal muy afinado; Tessera
   es la plataforma. Se reaprovechan las cuatro librerías ya separadas
   (`agent-sessions`, `trcc-client`, `weather-astro`, `lcd-canvas-kit`).
2. **Una pantalla = una rejilla fija** (p. ej. 24×6 en 1920×462) donde cada
   widget ocupa un rectángulo de celdas (*tesela*). Es un mosaico, no un
   masonry de altura infinita: el panel no hace scroll.
3. **Cada tesela es una pila**: varios widgets que se turnan; uno *urgente* se
   queda la tesela. Es la generalización de las columnas compartidas de
   aimonitor y del turno horas/consumo del modo gatos.
4. **Varias páginas por pantalla** que rotan o se fijan (tablero ↔ gatos es
   eso) y **interludios** a pantalla completa (el guiño de cada cuarto de hora).
5. **Un widget es un objeto** `{ id, name, options, fetch?, render, redraw?,
   visible?, urgent?, idle?, demo }`. Las opciones se declaran con un esquema
   tipado que da a la vez el tipo TS, la validación y **el formulario del editor**.
6. **Las fuentes de datos se comparten** (`sessions`, `vitals`, `weather`,
   `ccusage`): diez widgets con la CPU no leen `/proc` diez veces.
7. **El editor es web**, servido por el propio daemon en `127.0.0.1:7420`:
   Linux, macOS y Windows con cualquier navegador, instalable como PWA. La
   vista previa la pinta **el servidor con el mismo código que el panel**, así
   que lo que ves es exactamente lo que sale.
8. **Las vistas actuales se traducen a plugins** con el mismo contrato que uno
   de terceros, y un adaptador ejecuta sin tocarlos los módulos propios de
   aimonitor (la pizarra).
9. `tessera import-aimonitor` convierte la config actual entera.
10. Pendiente de decidir por ti: nombre definitivo, scope de npm, y si
    aimonitor pasa a ser «Tessera + plugins de Loksly» o sigue aparte.

---

## 1. Por qué un proyecto nuevo

| | Seguir en aimonitor | Proyecto nuevo |
|---|---|---|
| Config | Un `Config` de 640 líneas con todo dentro | Pantallas → páginas → teselas → widgets |
| Vistas | Tres caminos de render (tablero, gatos, pantallas) | Un compositor |
| Añadir una vista | Tocar el daemon (1.400 líneas) | Un fichero de plugin |
| Público | Quien tenga *este* panel y *este* flujo | Cualquier panel USB, cualquier uso |
| Riesgo | Romper el panel que usas a diario | Ninguno: conviven |

aimonitor sigue funcionando tal cual mientras Tessera madura. Cuando Tessera
cubra lo que usas a diario, `tessera import-aimonitor --write` hace el cambio.

---

## 2. El sistema de mosaico (masonry)

### 2.1 Modelo

```
Config
└─ screens[]                 un panel físico (o virtual)
   ├─ device                 virtual | trcc | file
   ├─ width × height, rotate (0/90/180/270), pixelShift, sleepWhenIdle
   ├─ pages[]                maquetas que se turnan o se fijan
   │  ├─ grid {cols, rows, gap, padding}
   │  ├─ gravity             none | up | left
   │  ├─ background {color, image}
   │  ├─ when                always | work | off
   │  └─ tiles[]             rectángulos de celdas
   │     ├─ x, y, w, h, locked
   │     ├─ chrome           auto | card | bare
   │     ├─ rotateMs         turno dentro de la pila
   │     └─ widgets[]        la pila: {type, title, options, when, intervalMs}
   └─ interludes[]           {type, everyMs, maxSeconds, options}
```

### 2.2 Por qué rejilla y no masonry «de verdad»

Un masonry tipo Pinterest reparte columnas de altura variable y crece hacia
abajo. Un panel LCD **no tiene «abajo»**: tiene 462 px y punto. Lo que sí se
toma del masonry es la idea de **empaquetar**: el botón *Ordenar solo* coloca
las teselas de mayor a menor en el primer hueco libre (`autoPack`), encogiendo
lo que no cabe.

### 2.3 Rejilla sugerida por resolución

Celdas aproximadamente cuadradas de ~80 px (`suggestGrid`):

| Panel | Rejilla | Celda |
|---|---|---|
| 1920×462 (Trofeo Vision 9.16″) | 24×6 | 79×75 |
| 1280×480 | 16×6 | 79×78 |
| 480×480 | 6×6 | 78×78 |
| 320×240 | 4×3 | 78×78 |

El usuario cambia la densidad con −/+; las teselas se reescalan en proporción
(`rescale`).

### 2.4 Gravedad y colisiones

- `none`: colocación libre; mover encima de otra la empuja si cabe.
- `up`: masonry clásico; todo sube a cerrar huecos.
- `left`: lo natural en tiras apaisadas (1920×462): todo se pega a la izquierda.

Mover o redimensionar llama a `place(items, id, rect, grid, gravity)`: empuja
en el eje de la gravedad y, si algo saldría de la rejilla o tocaría una tesela
fijada (`locked`), **rechaza** el movimiento (el editor lo pinta en rojo).
Nunca se pierde una tesela por salirse del panel.

### 2.5 Pilas, urgencia y reposo

`pickInStack(entries, now, rotateMs)`:

1. Si algún widget visible es `urgent()`, se queda la tesela.
2. Si no, los `visible()` se turnan contra el **reloj de pared** (dos paneles
   con el mismo turno cambian a la vez, y reiniciar no resetea el turno).
3. Si ninguno es visible, la tesela queda vacía (y en el panel no se ve).

`idle()`: si todos los widgets de la página están en reposo y la pantalla
tiene `sleepWhenIdle`, el panel se pone a negro (el `blankWhenIdle` de
aimonitor, ahora genérico).

### 2.6 Páginas e interludios

- Páginas: se turnan con su `durationMs` contra el reloj de pared, o se fija
  una (`pinnedPage`, también en caliente desde la API: el `~/.aimonitor/modo`
  de antes). `when: work|off` quita páginas fuera de su franja.
- Interludios: a pantalla completa cada `everyMs`, sólo en el primer minuto de
  su franja y una vez por franja; `skip()` los salta si algo reclama (permiso
  pendiente, reunión encima). Se preparan antes de reproducirse.

### 2.7 Repintado

Por eventos, no a fps fijos: se pinta cuando cambian los datos de algo visible,
cuando un widget lo pide (`redraw: 'second' | 'minute' | {everyMs}`), cuando
toca turno de pila o de página, o al editar. Un frame idéntico al anterior no
se envía (cada frame cuesta USB y, con `trcc serve`, una copia en disco).

---

## 3. El widget: interfaz de programación

### 3.1 Contrato

```ts
import { definePlugin, defineWidget, defineSource, t } from '@tessera/sdk';

export const countdown = defineWidget({
  id: 'countdown',
  name: { en: 'Countdown', es: 'Cuenta atrás' },
  icon: 'hourglass',                       // cualquier icono de Lucide
  category: 'time',
  size: { min: { w: 200, h: 120 }, preferred: { w: 480, h: 300 } },  // px del panel
  options: t.object({
    events: t.list(t.object({ name: t.string(), date: t.string({ format: 'date' }) })),
    max: t.integer({ default: 4, min: 1, max: 10, slider: true }),
  }),
  redraw: 'minute',
  render(g, { box, options, now, theme, kit, t }) { /* canvas 2D */ },
  visible: ({ options, now }) => upcoming(options.events, now).length > 0,
  urgent: ({ options, now }) => upcoming(options.events, now)[0]?.days === 0,
  demo: () => ({ /* datos de muestra para la galería */ }),
});

export default definePlugin({ id: 'mirror', name: 'Mirror cards', version: '1.0.0', widgets: [countdown] });
```

### 3.2 Decisiones

- **Canvas 2D, no HTML.** El panel es una imagen; el contexto es el de
  `@napi-rs/canvas`, idéntico al `CanvasRenderingContext2D` del navegador, así
  que lo que sabe hacer cualquiera que haya pintado en un `<canvas>` vale.
- **`render` síncrono y rápido; `fetch` asíncrono y aparte.** El frame nunca
  espera a la red. Las imágenes se decodifican en `fetch` y se pintan en
  `render` (lección de aimonitor).
- **Opciones como esquema** (`t.string/number/integer/boolean/enum/color/
  list/object/map/duration`, con `label`, `help`, `secret`, `advanced`,
  `slider`, `unit`, textos en varios idiomas). De ahí salen: el tipo
  TypeScript, la validación con valores por defecto (`validate`, nunca lanza)
  y el formulario del inspector. También se exporta como JSON Schema estándar.
- **`demo` obligatorio en la práctica.** Sin él, la galería y la vista previa
  no enseñan nada hasta configurar tokens. Con él, el widget se ve al
  arrastrarlo.
- **Fuentes compartidas** (`defineSource` con `read` periódico o `watch` por
  eventos): el widget declara `sources: ['agents/sessions']` y recibe
  `ctx.sources['agents/sessions']`.
- **Tema, no colores**: `ctx.theme.colors` (`bg, surface, surfaceEdge, ink,
  inkDim, inkFaint, accent, alert, warn, info, ok`) y `ctx.theme.fonts`. El
  semáforo `alert/warn/info` es el de aimonitor: la normalidad es apagada.
- **Fuentes empaquetadas** (DejaVu vía `dejavu-fonts-ttf`): el mismo frame en
  Linux, macOS y Windows.
- **Errores aislados**: si un `render` lanza, su tesela lo dice en rojo y el
  resto del frame sale.

### 3.3 Distribución de plugins

- Incluidos: `plugins/*` del repo.
- Propios: una carpeta (o un `.js`) en `~/.config/tessera/plugins/` (macOS:
  `~/Library/Application Support/Tessera/plugins`, Windows:
  `%APPDATA%\Tessera\plugins`). Un *hook* de resolución hace que
  `import … from '@tessera/sdk'` funcione **sin `npm install`**.
- De npm: paquetes `tessera-plugin-*`, instalables desde la página Plugins
  (con `--ignore-scripts` y aviso de que se ejecutan con tus permisos).
- Compatibilidad: `legacy/module` ejecuta un `defineModule` de aimonitor sin
  cambios (la pizarra con MathJax incluida).

---

## 4. La interfaz (editor)

### 4.1 Principios

1. **WYSIWYG real**: la imagen del escenario la pinta el servidor con el mismo
   compositor que el panel. Las teselas son cajas DOM encima.
2. **Nada que guardar**: cada cambio se guarda solo (500 ms), con
   deshacer/rehacer (Ctrl+Z / Ctrl+Shift+Z) de 100 pasos.
3. **Ver antes de configurar**: miniaturas con datos de muestra en la
   biblioteca, y vista previa con datos demo donde aún no hay reales.
4. **El panel manda en la estética**: oscuro por defecto, marco de bisel
   alrededor del panel, acento violeta→cian; tema claro opcional.
5. **Multiplataforma sin empaquetar un navegador**: web servida en local,
   instalable como PWA. (Un envoltorio Tauri queda en la hoja de ruta.)

### 4.2 Pantallas del editor

```
┌───────┬──────────────────────────────────────────────────────────────────┐
│ logo  │ [● Trofeo 1920×462] [● Noticias] [● Pantalla 3]     ☁ guardado    │
├───────┼──────────────┬─────────────────────────────────┬─────────────────┤
│Editor │  WIDGETS  12 │ ↶ ↷ │gravedad│ densidad │ordenar  │ TESELA · 6×5    │
│Pantal.│  [buscar…]   │                                 │ Widgets aquí:   │
│Plugins│  (chips cat.)│   ╔═════════════════════════╗   │  ▣ Sesiones  ✕  │
│Ajustes│  ┌────────┐  │   ║  ▣▣▣ panel a escala ▣▣  ║   │  ▣ Consumo   ✕  │
│Activ. │  │miniat. │  │   ║  rejilla + teselas      ║   │  + añadir aquí  │
│       │  │nombre  │  │   ╚═════════════════════════╝   │ Turno 30 s      │
│       │  └────────┘  │   Trofeo · 1920×462 · 24×6      │ Marco: tarjeta  │
│       │  ┌────────┐  │                                 │ OPCIONES        │
│       │  │…       │  │ Páginas: [●Tablero 4 📌][Gatos 2]│ (formulario     │
│       │              │                                 │  automático)    │
└───────┴──────────────┴─────────────────────────────────┴─────────────────┘
```

- **Biblioteca** (izquierda): búsqueda, categorías, miniatura real de cada
  widget, descripción y plugin. Se arrastra al panel o se hace clic (busca
  hueco). **Soltar sobre una tesela la apila allí.**
- **Escenario** (centro): el panel a escala dentro de un bisel; rejilla
  punteada; teselas con chip de nombre, contador de pila y aviso de error;
  8 tiradores de tamaño; flechas para mover (Shift+flechas para redimensionar),
  Supr para borrar, Ctrl+D para duplicar. Botón *Panel en vivo* para ver lo que
  está saliendo de verdad (incluidos interludios y el reposo).
- **Páginas** (abajo): pestañas con su número de teselas, el punto verde de la
  que está en el panel ahora y la chincheta para fijarla.
- **Inspector** (derecha): sin selección, la página (nombre, fondo, cuándo,
  duración); con una tesela, su pila (reordenar, quitar, añadir), el turno, el
  marco, y las opciones del widget elegido, su título, su franja y su refresco.
- **Pantallas**: cada panel con su modelo (preajustes), resolución, giro,
  conexión (virtual / trcc / fichero), detectar paneles por `trcc serve`,
  antiquemado, reposo, calidad, fps, interludios con *Reproducir ya*, y
  exportar la maqueta en JSON para compartirla.
- **Plugins**: tarjetas con lo que aporta cada uno y su interruptor; instalar
  de npm; «escribe el tuyo» con un ejemplo copiable.
- **Ajustes**: tema del panel (Midnight, Graphite, Aurora, Phosphor, Paper),
  aspecto del editor, idioma (es/en), ubicación (con «usar mi ubicación»),
  jornada, opciones de las fuentes de datos compartidas con su estado.
- **Actividad**: el log en vivo.
- **Responsive**: por debajo de 1020 px el escenario va arriba y la biblioteca
  pasa a carrusel; en móvil la navegación baja a una barra inferior.

### 4.3 API del servidor

| Método | Ruta | Para |
|---|---|---|
| GET | `/api/state` | config, catálogo (con esquemas), temas, preajustes, estado |
| PUT | `/api/config` | guardar (normaliza, escribe 0600 atómico, aplica en caliente) |
| POST | `/api/preview` | pintar una página sin guardar (PNG + teselas) |
| GET | `/api/thumbnail` | miniatura de un widget con datos demo |
| GET | `/api/screens/:id/frame.png` | el último frame real |
| GET | `/api/events` | SSE: frames, log, estado |
| POST | `/api/screens/:id/pin` · `/interlude` | fijar página · reproducir interludio |
| POST | `/api/plugins/install` · `/:id/enabled` | instalar · activar |

Seguridad: escucha en 127.0.0.1; las mutaciones exigen la cabecera
`X-Tessera: 1` (otra web no puede mandarla sin un *preflight* CORS que nunca
se concede) y se comprueba `Host` contra DNS rebinding. Instalar plugins usa
`--ignore-scripts` y sólo acepta nombres de paquete.

---

## 5. Traducción de las vistas actuales a plugins

| aimonitor | Tessera | Tipo |
|---|---|---|
| Tablero: casillas de sesiones (`render.ts`, `select.ts`) | `agents/sessions` + fuente `agents/sessions` | widget + fuente |
| Cabecera (RAM · consolas · te esperan · reloj) | `agents/summary` | widget |
| Columna de vitales (`drawSystem`) | `vitals/vitals` sobre `system/vitals` | widget |
| Carril de consumo y sparkline (`usage.ts`, `drawRail`) | `usage/rail`, `usage/blocks` + fuente `usage/ccusage` | widgets + fuente |
| Modo gatos (`scene/*`, ~10k líneas) | `cats/room` (a sangre) | widget de escena |
| Guiño plataformas (`platformer.ts`) | `agents/runner` | interludio |
| Duelo de espadas (`duel.ts`) | `cats/duel` | interludio |
| Noticias (`news/*`) | `news/headline`, `news/column` | widgets |
| Tiempo (`weather-astro`) | `weather/forecast` + fuente `weather/current` | widget + fuente |
| countdown, compliments, tasks, nowplaying, onthisday, airquality, earthquakes, rainmap | `mirror/*` | widgets |
| pipelines, reviews | `gitlab/*` | widgets |
| syshealth | `system/health` | widget |
| Módulos propios (pizarra) | `legacy/module` | adaptador |
| agenda, imputacion, horas, runner (gato) | **pendiente** (dependen de servicios propios: foco, calendario, timesheet) | — |
| `modo` tablero/gatos/alternar | páginas fijadas o turnándose | modelo |
| `screens[]` con `column`/`weight` | pantallas con teselas y pilas | modelo |
| `blankWhenIdle` | `idle()` + `sleepWhenIdle` | modelo |

Estrategia de traducción: **copiar y adaptar, no reescribir**. El código de
pintado de aimonitor está muy afinado (medidas, pesos visuales, cachés), así
que se copia al plugin y se sustituye el `Config` global por las opciones del
widget. La escena de gatos se pinta en un canvas a la altura de diseño (462) y
se escala a la tesela.

Lo que cambia en el camino:

- Los textos fijos en castellano pasan a elegirse por `ctx.locale`.
- Las rutas `~/.aimonitor/...` pasan a ser opciones con ese valor por defecto
  (compatibles con el hook ya instalado).
- La columna de tarjetas dentro de la escena de gatos desaparece: en Tessera
  es una tesela con su pila al lado de la escena, configurable en el editor.

### 5.1 Importador

`tessera import-aimonitor [--from ~/.aimonitor/config.json] [--write]`:

- Pantalla principal con dos páginas, **Dashboard** (cabecera, sesiones,
  vitales, consumo) y **Cats** (habitación + pila con tus `modules`), fijadas o
  alternando según `scene.mode`.
- Cada `screens[]` → una pantalla con driver `file` a su `dir`, con sus
  `column` como pilas y `weight` como anchos sobre 24 columnas.
- `when: jornada|fuera` → `work|off`; `header` → título; `updateMs` → refresco.
- Módulos propios → `legacy/module`.
- **No copia** las URL de calendario ICS (son secretos) y avisa de lo que no
  tiene equivalente todavía.

---

## 6. Estado y hoja de ruta

### Hecho

- **SDK** (`@tessera/sdk`): widgets, fuentes, interludios, esquema de opciones
  `t` → tipos + validación + formulario + JSON Schema, temas, i18n.
- **Motor de mosaico** con tests: rejilla sugerida por resolución (24×6 en
  1920×462), colocación con empuje y rechazo, gravedad, compactación,
  `autoPack` (masonry), reescalado de densidad, pilas con turno y urgencia,
  páginas por turnos o fijadas.
- **Runtime** por eventos, compositor único, drivers `virtual`, `trcc` y
  `file`, rotación de montaje, antiquemado, reposo, interludios.
- **Servidor** (API + SSE + estáticos, protegido contra CSRF/DNS rebinding) y
  **CLI**: `start [--demo]`, `render`, `import-aimonitor`, `doctor`,
  `service install|uninstall|print` (systemd, launchd, Programador de tareas).
- **Editor**: escenario a escala con bisel, rejilla, mover/redimensionar con
  teclado y ratón, arrastrar desde la biblioteca, apilar soltando encima,
  tira de páginas con miniaturas vivas, **plantillas de página** adaptadas a
  la forma del panel, inspector con formularios automáticos y **estado de los
  datos** de cada widget, pantallas (detección por trcc), plugins (activar,
  instalar de npm), ajustes (5 temas de panel, editor claro/oscuro, idioma,
  ubicación, jornada, fuentes de datos), actividad; responsive hasta móvil;
  autoguardado con deshacer/rehacer.
- **Plugins portados**: `agents` (fuente de sesiones, casillas, cabecera,
  interludio de plataformas), `cats` (habitación, duelo), `usage`, `system`,
  `vitals`, `weather`, `news`, `mirror` (8 tarjetas), `gitlab`, `core`,
  `legacy` (tus módulos de aimonitor, la pizarra incluida).
- **Modo demo** (`--demo`) y `examples/showcase.json` para probar sin nada
  configurado; capturas del README hechas así (sin datos personales).
- **Distribución**: un solo paquete npm (`tessera-lcd`) generado con esbuild
  (`npm run dist`), probado instalado fuera del repo, con plugins externos de
  un solo fichero funcionando sin `npm install` gracias a un *hook* de
  resolución.
- **CI** en GitHub Actions: Linux, macOS y Windows × Node 22/24, con prueba del
  paquete.
- Documentación: README (en), guía de plugins (en), este plan (es),
  CONTRIBUTING, plantillas de issues y PR.

### Pendiente

1. Agenda y próxima reunión (ICS) — en curso como plugin `calendar`.
2. Horas e imputación (GitLab) y el gato del runner: dependen de servicios muy
   tuyos (foco, popup de imputar); propuesta: plugin aparte, no en el repo
   público.
3. Animaciones dentro de una tesela (gestos de los gatos, paseos): requiere
   ampliar el SDK con `animate` y un presupuesto de fps por pantalla.
4. Vídeos propios como interludio (`easterEgg.source` con ffmpeg).
5. Emisor USB propio por número de serie y PR aguas arriba a
   `thermalright-trcc-linux` para `--serial`.
6. Envoltorio de escritorio (Tauri) con icono en la bandeja.
7. Galería pública de maquetas exportadas y de plugins.

### Decisiones abiertas para ti

- **Nombre**: `Tessera` es provisional (el paquete npm está como
  `tessera-lcd`; `tessera` a secas está cogido). Los paquetes internos usan
  `@tessera/*`, que no se publican por separado en esta versión.
- **Publicar**: no he creado el repositorio en GitHub ni publicado en npm;
  el README ya asume `Loksly/tessera` y `npm install -g tessera-lcd`.
- **Plugins personales** (gitlab con tus alias, horas, imputación): en el
  repo público van genéricos; tu configuración se queda en tu
  `config.json`.
- **Licencia**: MIT, como aimonitor.
- **Arte del interludio**: el corredor de aimonitor reproducía de cerca el
  nivel 1-1 de Super Mario Bros. (marcador «WORLD 1-1», bloques «?», tubería
  verde, mástil y castillo). Para publicarlo lo he hecho original y a juego
  con el producto: marcador «RELEASE vX.Y», bloques de código `</>`,
  conductos de cable, antena con baliza y un centro de datos al final. En el
  duelo de los gatos, «lightsaber» (marca de Lucasfilm) pasa a «espadas
  láser». Tu aimonitor sigue como estaba.
- **Firma de commits**: tu git firma con GPG y aquí no había pinentry; los
  commits de este repo van sin firmar (`git rebase --exec 'git commit --amend
  --no-edit -S' --root` los firma todos si quieres).
