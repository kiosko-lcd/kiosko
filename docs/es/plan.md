# Kiosko: plan de diseño

*De aimonitor (un tablero fijo para un Trofeo Vision) a un sistema de widgets
con editor visual que cualquiera pueda instalar en su panel.*

Documento de diseño del 2026-11-08. Recoge las decisiones tomadas, por qué, y
lo que queda pendiente. El código que lo implementa está en este mismo repo.

---

## 0. Resumen en diez líneas

1. **Proyecto nuevo** (`kiosko`, nombre provisional) en vez de seguir
   cargando aimonitor: aimonitor es un producto personal muy afinado; Kiosko
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
9. `kiosko import-aimonitor` convierte la config actual entera.
10. Pendiente de decidir por ti: nombre definitivo, scope de npm, y si
    aimonitor pasa a ser «Kiosko + plugins de Loksly» o sigue aparte.

---

## 1. Por qué un proyecto nuevo

| | Seguir en aimonitor | Proyecto nuevo |
|---|---|---|
| Config | Un `Config` de 640 líneas con todo dentro | Pantallas → páginas → teselas → widgets |
| Vistas | Tres caminos de render (tablero, gatos, pantallas) | Un compositor |
| Añadir una vista | Tocar el daemon (1.400 líneas) | Un fichero de plugin |
| Público | Quien tenga *este* panel y *este* flujo | Cualquier panel USB, cualquier uso |
| Riesgo | Romper el panel que usas a diario | Ninguno: conviven |

aimonitor sigue funcionando tal cual mientras Kiosko madura. Cuando Kiosko
cubra lo que usas a diario, `kiosko import-aimonitor --write` hace el cambio.

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
import { definePlugin, defineWidget, defineSource, t } from '@kiosko/sdk';

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
- Propios: una carpeta (o un `.js`) en `~/.config/kiosko/plugins/` (macOS:
  `~/Library/Application Support/Kiosko/plugins`, Windows:
  `%APPDATA%\Kiosko\plugins`). Un *hook* de resolución hace que
  `import … from '@kiosko/sdk'` funcione **sin `npm install`**.
- De npm: paquetes `kiosko-plugin-*`, instalables desde la página Plugins
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
`X-Kiosko: 1` (otra web no puede mandarla sin un *preflight* CORS que nunca
se concede) y se comprueba `Host` contra DNS rebinding. Instalar plugins usa
`--ignore-scripts` y sólo acepta nombres de paquete.

---

## 5. Traducción de las vistas actuales a plugins

| aimonitor | Kiosko | Tipo |
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
- La columna de tarjetas dentro de la escena de gatos desaparece: en Kiosko
  es una tesela con su pila al lado de la escena, configurable en el editor.

### 5.1 Importador

`kiosko import-aimonitor [--from ~/.aimonitor/config.json] [--write]`:

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

- **SDK** (`@kiosko/sdk`): widgets, fuentes, interludios, esquema de opciones
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
  `vitals`, `weather`, `calendar` (próxima reunión y agenda desde ICS, con
  caché sin URLs en claro), `news`, `mirror` (8 tarjetas), `gitlab`, `core`,
  `legacy` (tus módulos de aimonitor, la pizarra incluida).
- **Modo demo** (`--demo`) y `examples/showcase.json` para probar sin nada
  configurado; capturas del README hechas así (sin datos personales).
- **Distribución**: un solo paquete npm (`kiosko`) generado con esbuild
  (`npm run dist`), probado instalado fuera del repo, con plugins externos de
  un solo fichero funcionando sin `npm install` gracias a un *hook* de
  resolución.
- **CI** en GitHub Actions: Linux, macOS y Windows × Node 22/24, con prueba del
  paquete.
- Documentación: README (en), guía de plugins (en), este plan (es),
  CONTRIBUTING, plantillas de issues y PR.

### Pendiente

1. Horas e imputación (GitLab) y el gato del runner: dependen de servicios muy
   tuyos (foco, popup de imputar); propuesta: plugin aparte, no en el repo
   público.
2. Animaciones dentro de una tesela (gestos de los gatos, paseos): el SDK ya
   tiene `animation` (ver `docs/plugins.md`, «Animations»). Falta medirlas en un
   panel real (fps sostenibles con `trcc serve`), un interruptor por pantalla
   y portar los gestos del plugin de los gatos.
3. Vídeos propios como interludio (`easterEgg.source` con ffmpeg).
4. Emisor USB propio por número de serie y PR aguas arriba a
   `thermalright-trcc-linux` para `--serial`.
5. Envoltorio de escritorio (Tauri) con icono en la bandeja.
6. Galería pública de maquetas exportadas (los plugins, en la tienda del
   punto 8).
7. **Actualizar plugins desde el editor.** Hoy un plugin instalado desde npm
   se queda en su versión hasta que se reinstala a mano.
   - *Detectar*: el servidor pregunta al registro de npm por la última
     versión (`dist-tags.latest`) al arrancar y luego una vez al día, con
     caché en `cacheDir` y ETag, y sin quejarse si no hay red. Compara por
     semver con la instalada y con lo que la nueva pide de Kiosko
     (`peerDependencies` de `@kiosko/sdk`, `engines`): una versión que
     necesita un Kiosko más nuevo no se ofrece, se avisa («requiere Kiosko ≥
     x.y»).
   - *Interfaz*: insignia «Actualización disponible» en la tarjeta del plugin
     (vista Plugins) y un contador en la barra lateral; botón **Actualizar**
     (y «Actualizar todos») que reinstala con el mismo camino que «Instalar
     de npm» (`--ignore-scripts`), enseña las novedades (releases de GitHub
     si `repository` apunta allí) y recarga el plugin o pide reiniciar.
   - *Seguridad*: antes de aplicar, decir si la versión nueva trae opciones
     con `risk` nuevas (ejecutar, red, ficheros); guardar la versión anterior
     y volver a ella sola si la nueva no carga.
   - Por decidir: los plugins oficiales van como dependencias opcionales del
     producto y se actualizan con él; ¿se ofrecen también sueltos? Y el
     mismo aviso para el propio Kiosko.
8. **Tienda de plugins** (sustituye a la galería de plugins del punto 6). Hay
   que trabajarla antes de escribir código; lo que se ha pensado:
   - *Catálogo*: un índice propio (en kioskolcd.dev o un repo
     `kiosko-lcd/plugin-index`) alimentado desde npm (palabra clave
     `kiosko-plugin`) con lo que la propia definición del plugin dice:
     widgets, fuentes, requisitos y opciones con riesgo, lo mismo que ya
     extrae `plugins:scaffold`. Las capturas las genera el compositor con
     los datos de demo, en varios temas y tamaños, no se suben a mano: así
     son fieles a lo que se verá en el panel.
   - *Ficha*: capturas, descripción, requisitos, **permisos** (qué puede
     hacer: ejecutar programas, conectarse a hosts, leer ficheros; sale de
     `risk`), versiones y novedades, compatibilidad con la versión de Kiosko
     y el sistema operativo, y notas del autor (puntualizaciones, límites
     conocidos).
   - *Valoraciones y comentarios*: exigen cuentas (¿con GitHub?), moderación,
     anti-spam y denuncias. Alternativa ligera para empezar: las Discussions
     del repo de cada plugin, enlazadas desde la ficha.
   - *Insignias*: «Oficial» (de kiosko-lcd); «Verificado» (autor
     identificado y código revisado en una versión concreta, ligado al hash
     `integrity` de npm, que se pierde al publicar una versión sin revisar);
     «Probado en» tal panel; «Popular». Falta definir el proceso de revisión
     y quién lo hace.
   - *Instalar*: un clic desde la ficha, en el editor (el mismo camino que
     npm) y con enlace profundo desde la web.
   - *Riesgos*: un plugin ejecuta código con los permisos del usuario, así
     que la tienda es cadena de suministro: provenance de npm, revisión, y
     una lista de versiones retiradas que el editor consulte para avisar o
     desactivar.
   - Abierto: plugins de pago, alojamiento y coste, términos de uso y RGPD
     de los comentarios.
9. **Venta afiliada de hardware.** Recomendar paneles compatibles desde el
   portal de configuración y recibir parte del ingreso de las ventas que
   salgan de ahí. Hay que trabajarlo; lo pensado:
   - *Dónde*: la vista Pantallas ya detecta el panel del usuario; si no hay
     ninguno (o en la demo web), una sección «Paneles compatibles» con
     resolución, protocolo y estado de soporte por sistema operativo
     (verificado en un panel real o no). Nunca en el propio panel, solo en
     el editor y en la web.
   - *Cómo*: dos vías, no excluyentes. Programas de afiliados ya existentes
     (Amazon Afiliados, AliExpress Portals, tiendas de los fabricantes):
     rápido y sin negociar. Acuerdos directos con fabricantes (Thermalright
     y otros) con código de referido o descuento: más margen, pero hay que
     negociar y medir.
   - *Atribución sin telemetría*: Kiosko es local y no rastrea; el enlace
     lleva el identificador de afiliado y la atribución la hace la tienda.
     No se añade telemetría para esto.
   - *Transparencia*: marcar los enlaces como de afiliado (lo exigen la
     normativa de consumo de la UE, la FTC y las propias plataformas), decir
     que financian el proyecto y permitir ocultar la sección.
   - *Encaje con la tienda*: un sello «Compatible con Kiosko» para
     fabricantes, de la misma familia que las insignias del punto 8.
   - Pendiente: alta como afiliado, facturación e impuestos de las
     comisiones, y qué tiendas cubren los países de los usuarios.
10. **Más idiomas, empezando por el chino.** Prioridad: el **chino
    tradicional de Taiwán (`zh-TW`)**, el del fabricante de los paneles
    (Thermalright), y el **chino simplificado (`zh-CN`)**, el de la China
    continental. Son dos traducciones distintas (caracteres y a veces
    vocabulario: 分鐘/分钟, 設定/设置), no una con dos nombres. Lo que hay hoy
    y lo que falta:
    - *Textos*: el editor (`packages/web/src/i18n.ts`, unas 450 claves) y
      los plugins (`Localized`, hoy `{ en, es }`) solo tienen inglés y
      español. Hay comprobaciones sueltas de `locale.startsWith('es')` en el
      editor y la demo que habría que llevar al sistema de traducciones.
    - *Variantes regionales*: `localize` ya busca primero la etiqueta
      completa (`zh-TW`) y luego el idioma (`zh`), pero `ctx.fmt` (horas,
      «hace 5 min», duraciones) elige sus palabras solo por idioma: hay que
      dejarle distinguir `zh-TW` de `zh-CN`. Fechas y números ya salen bien
      con `Intl`.
    - *Fuentes del panel*: DejaVu no tiene caracteres chinos, así que el
      panel pintaría cuadros vacíos. Hace falta una fuente CJK (Noto Sans
      CJK TC y SC, o Source Han Sans) que pesa megas: descargarla bajo
      demanda al elegir el idioma (en `cacheDir` no, en `dataDir`), o
      recortarla a los caracteres usados. Comprobar también las versalitas
      (`smallCaps`) y el `tracking` de las etiquetas, que no tienen sentido
      en chino, y los recortes de texto (`truncate` mide por caracteres).
    - *Editor web*: Inter tampoco tiene chino; basta con caer en la fuente
      del sistema (PingFang, Microsoft JhengHei/YaHei, Noto).
    - *Colores con significado cultural*: en China y Taiwán **el rojo es
      subir y el verde es bajar** (bolsa, precios, cualquier variación), al
      revés que en Occidente. Para errores y peligro el rojo sigue
      significando peligro (alarmas, semáforos, errores en sus propias
      aplicaciones), así que `alert`/`warn`/`ok` se quedan como están.
      Además el rojo tiene una carga positiva (suerte, celebración) que el
      verde no tiene, así que no conviene pintar de rojo lo bueno ni de
      verde lo que no lo es. Qué hacer:
      - separar en el tema el color de **subida y bajada** (`up`, `down`)
        del de **estado** (`alert`, `warn`, `ok`); hoy cualquier widget que
        marque una variación usa `ok`/`alert` y la invertiría mal;
      - un ajuste «Color de las subidas: verde (Occidente) / rojo (Asia
        oriental)» que tome por defecto el del idioma (`zh`, y también
        `ja` y `ko` en bolsa), igual que la hora de 12 o 24 h;
      - una regla en la guía de plugins (`docs/plugins.md`, «Option
        conventions»): variaciones con `up`/`down`, nunca con `ok`/`alert`;
        y en los temas, no fiarlo todo al color (flecha o signo junto al
        número), que además ayuda a los daltónicos;
      - revisar los widgets que ya muestran tendencias: la de Home Assistant
        va en gris neutro con flecha (sirve en ambas culturas), y la futura
        de bolsa y cripto de la lista de ideas tendría que nacer con esto.
    - *Traducción*: primera versión con IA y revisión por un hablante
      nativo (¿el propio fabricante?), un fichero por idioma para que la
      comunidad pueda aportar otros, y una prueba que avise de claves sin
      traducir. Los plugins oficiales, igual, con `zh-TW` y `zh-CN` en sus
      `Localized`.
    - Después: documentación (README, `docs/plugins.md`) y la web
      (kioskolcd.dev) en chino, y el resto de idiomas que pida la gente.
11. **Noticias por tesela, no globales.** Que una pantalla muestre noticias
    de un tema (tecnología, deportes, tu ciudad) y otra de otro. Hoy los
    feeds RSS se configuran una vez, en la fuente compartida `news/deck`
    (Ajustes → Fuentes de datos), que los lee, agrupa la misma noticia entre
    cabeceras y ordena el mazo para todos; cada widget solo puede filtrar
    por cabecera (`outlets`). Sirve para «solo El País aquí», no para temas
    con feeds distintos (las secciones de cada periódico tienen su RSS).
    - *Propuesta, general para el SDK*: **perfiles de fuente**, varias
      configuraciones con nombre de una misma fuente (`news/deck` «General»,
      «Tecnología», «Deportes»), cada una con sus feeds y leída por separado;
      cada widget elige el suyo con una opción (`profile`), y el inspector
      permite crear uno nuevo desde la propia tesela. Valdría igual para
      otros plugins que hoy tienen una sola configuración: varias cuentas de
      GitHub o GitLab, dos Home Assistant, calendarios de trabajo y
      personales.
    - *Alternativa más corta, solo en noticias*: una opción `feeds` en el
      widget que, si se rellena, sustituye a los globales, y la fuente lee
      la unión agrupando por conjunto de feeds. Más rápido, pero cada plugin
      tendría que reinventarlo.
    - *Además*: un filtro por palabras clave por tesela (`topics`, con `!`
      para excluir) sobre titular y entradilla, que con los feeds generales
      ya da temas sin configurar nada más.
    - Cuidado con: el agrupado entre cabeceras («lo cuentan 4 medios»), que
      tiene sentido por perfil y no mezclado; no leer dos veces el mismo
      feed si lo usan dos perfiles (caché por URL); y la migración de las
      configuraciones actuales al perfil por defecto.
12. **Agenda: unión por defecto, separación clara.** La fuente
    `calendar/events` lee todos los ICS (hasta 10) y une sus reuniones; cada
    widget puede quedarse con algunos por el nombre del calendario
    (`calendars`, con `*` y `!`). La unión por defecto es lo correcto (el día
    es uno: la cuenta atrás tiene que ver también la reunión personal que
    pisa la de trabajo) y separar sirve para paneles compartidos o una
    tesela solo de festivos. Aquí no hacen falta los perfiles del punto 11:
    leer todo una vez y elegir por tesela es más simple y barato. Lo que
    falta:
    - un **nombre propio por dirección**, porque el que trae el ICS a veces
      es genérico o repetido (los publicados de Outlook), y entonces el
      filtro no los distingue;
    - un **color por calendario** y su marca en la agenda y en la próxima
      reunión, para saber de cuál es cada una al verlos unidos;
    - comprobar que una reunión invitada en dos calendarios sale una sola
      vez (mismo `UID` o mismo título y hora);
    - en el editor, elegir los calendarios de la tesela con casillas con sus
      nombres, no escribiendo patrones.
13. **Finanzas: bolsa, índices, divisas y cripto** (`kiosko-plugin-finance`).
    - *De dónde sacar los datos*, con un proveedor intercambiable porque
      ninguno es perfecto:
      - **Yahoo Finance**: el más completo y sin clave, pero su API no es
        oficial (cambia sin aviso, a veces pide cookie y «crumb», y sus
        términos no permiten usarla así). Bien como opción, no como única.
      - **Google Finance**: no tiene API desde 2012 (solo `GOOGLEFINANCE` en
        Hojas de cálculo); descartado salvo que aparezca algo.
      - Con clave gratuita: **Finnhub** (60 peticiones/min), **Twelve Data**
        (800/día), **Alpha Vantage** (25/día, poco). Sin clave: **Stooq**
        (CSV, con retraso).
      - Divisas: el **BCE** (oficial, gratis, una vez al día) vía Frankfurter;
        cripto: **CoinGecko** (sin clave).
    - *Widgets*: una cotización en grande con la curva del día (al estilo de
      la entidad de Home Assistant); una lista de valores; una cinta que
      pasa en una franja; el estado del mercado (abierto, cerrado, preapertura,
      con su horario y festivos por bolsa); y, opcional, el valor de una
      cartera con las posiciones guardadas solo en local.
    - *Avisos*: umbrales por valor (precio o % del día) que pintan y se
      quedan la tesela, como el resto de plugins; reposo con el mercado
      cerrado.
    - *Colores*: subidas y bajadas con `up`/`down` y flecha, nunca con
      `ok`/`alert`, y el ajuste verde/rojo del punto 10 (en China y Taiwán
      el rojo es subir). Este plugin es el primero que lo necesita.
    - *A tener en cuenta*: avisar del retraso de cada proveedor (15-20 min
      en muchos mercados), respetar sus límites con una sola fuente
      compartida y caché, y que los datos de bolsa tienen licencia: verlos
      en tu panel es uso personal, pero no redistribuirlos (ojo con la demo
      web y las capturas: datos de muestra, no reales).
14. **El tráfico de tu ruta.** Hoy `mirror/trafficmap` pinta el flujo de
    TomTom alrededor de tu ubicación: un mapa, que no sabe adónde vas. Lo que
    se busca es «a la oficina hoy: 34 min, 9 más de lo normal, sal ya».
    - *Rutas*: una o varias con nombre (casa → oficina, oficina → casa,
      colegio), origen y destino por dirección o coordenadas, guardadas solo
      en local.
    - *Proveedor*, intercambiable:
      - **TomTom Routing** con tráfico en vivo: la misma clave gratuita que
        el mapa (unas 2.500 peticiones/día), da duración con tráfico y sin
        él, y el retraso.
      - **HERE Routing** (capa gratuita) o **Mapbox Directions** con perfil
        `driving-traffic` como alternativas; **Google Routes** es de pago
        por uso.
      - **OSRM/Valhalla** no tienen tráfico en vivo: solo como respaldo.
      - En España, las incidencias de la **DGT** (datos abiertos DATEX II,
        gratis): obras, accidentes y cortes que tocan la ruta.
    - *Widgets*: el tiempo de la ruta en grande con el retraso frente a lo
      normal (verde, ámbar, rojo por umbrales) y la hora de llegada si sales
      ahora; la ruta alternativa si es más rápida; las incidencias en el
      camino; opcional, un mapa de la ruta con su tráfico (reusar las
      teselas de `trafficmap`).
    - *Cuándo*: solo en la franja en que importa, con la jornada de Ajustes
      (`ctx.workday`): la ida antes de la hora de entrada y la vuelta al
      acabar, nada en festivos ni fines de semana (y reposo el resto del
      tiempo). Que se quede la tesela si el retraso pasa de un umbral cerca
      de la hora de salir: «sal ya» o «sal 10 min antes».
    - *Con la agenda*: si la próxima reunión tiene lugar, el tiempo hasta
      allí y a qué hora salir (enlaza con el punto 12).
    - Cuidado con: el límite de peticiones (consultar cada 5 min solo dentro
      de la franja), que origen y destino son datos personales (en local,
      fuera de capturas y de la demo), y medir «lo normal» guardando un
      histórico propio por franja horaria si el proveedor no lo da.
15. **Redes sociales** (`kiosko-plugin-social`). Lo difícil son las APIs,
    cada vez más cerradas:
    - Abiertas y gratis: **Bluesky** (AT Protocol) y **Mastodon** (API de
      cada instancia). Por aquí se empieza.
    - Con clave: **YouTube Data API** (suscriptores, visitas, último vídeo),
      **Twitch** (en directo o no), **Reddit** (OAuth, con límites).
    - Cerradas o de pago: **X** (API de pago), **Instagram** y **Facebook**
      (solo cuentas profesionales vía Graph API; la Basic Display API se
      cerró en 2024), **LinkedIn** (sin API útil). No prometerlas.
    - *Widgets*: tus cifras (seguidores, «me gusta», suscriptores) con su
      tendencia; menciones y notificaciones sin leer, que pueden quedarse la
      tesela; el último post de una cuenta o una lista; «en directo» de los
      canales que sigues.
    - Cuidado con: los tokens (secretos, en local) y no mostrar contenido
      ajeno sin filtro en un panel siempre encendido (filtro de palabras,
      solo cuentas elegidas).
16. **Marco de fotos** (`kiosko-plugin-photos`). El widget **Imagen** de
    `core` ya muestra una carpeta por turnos; el marco va más allá:
    - *De dónde*: carpeta local o del NAS, **Immich**, **Nextcloud** y
      WebDAV, **Synology Photos**, álbumes compartidos de **iCloud** (enlace
      público). **Google Photos** ya no deja leer la biblioteca desde 2025
      (solo el selector o lo que suba la propia app): no prometerlo.
    - *Cómo se ve*: recorte inteligente para paneles muy apaisados (una
      franja de 1920×462 corta cabezas): centrar en caras o en lo
      importante; movimiento lento tipo Ken Burns con la API `animation`;
      transiciones; fecha y lugar de la foto (EXIF) en una esquina; «tal día
      como hoy, hace 3 años».
    - *Qué fotos*: álbumes elegidos, aleatorio sin repetir hasta agotar,
      favoritas, excluir capturas de pantalla y fotos privadas por etiqueta.
    - Cuidado con: decodificar en `fetch` y reducir al tamaño del panel
      (fotos de 20 MP), caché en `cacheDir`, y que es contenido personal
      (fuera de la demo y de capturas).
17. **Deportes: resultados y agenda** (`kiosko-plugin-sports`), un plugin
    con una fuente de **equipos y competiciones favoritos** compartida:
    - *Proveedores*: **football-data.org** (gratis con clave, ligas
      principales), **API-Football** (capa gratuita de 100 peticiones/día),
      **TheSportsDB** (muchos deportes), **Jolpica** (F1, sucesor de
      Ergast) y **OpenF1** (tiempos en vivo). Los de ESPN no son oficiales:
      como respaldo, no como base.
    - *Resultados*: marcador en directo de tus equipos (que se queda la
      tesela con un gol y lo celebra con una animación corta), resultados de
      la jornada, clasificación con tu equipo resaltado.
    - *Agenda*: próximos partidos con fecha, hora local, competición y
      **canal de TV** (no hay una API limpia de dónde se emite en España: a
      investigar); la cuenta atrás al siguiente; y exportarla como
      calendario o leer los ICS que publican muchos clubes con el plugin de
      calendario (punto 12).
    - *Cuándo*: consultar cada pocos segundos solo durante los partidos de
      tus equipos, y cada pocas horas el resto del tiempo, por los límites
      de las APIs gratuitas.
18. **Widget genérico REST/JSON y webhook de entrada.** Dos piezas en `core`
    que convierten en widget cualquier cosa sin escribir un plugin:
    - *REST/JSON*: una URL (con cabeceras y secreto opcionales), una ruta
      dentro de la respuesta (`$.data.temperature`, o una expresión
      sencilla para listas) y una presentación: número grande con unidad y
      umbrales, lista, curva con histórico propio, texto. Con `intervalMs`,
      `timeoutMs` y `risk: 'network'` como cualquier fuente.
    - *Webhook*: `POST /api/push/<nombre>` con un JSON (`{ "value": 42,
      "text": "Backup terminado", "level": "warn", "ttlMs": 3600000 }`) que
      pinta un widget **Push** con ese nombre; `level: alert` se queda la
      tesela y `ttlMs` lo apaga solo. Sirve para scripts, cron, CI, Home
      Assistant, n8n.
    - *Seguridad*: el servidor hoy solo escucha en local y se protege de
      CSRF y DNS rebinding; el push necesitaría un token por nombre (y
      decidir si se permite desde la red local), sin abrir el resto de la
      API.
    - Recetas en la documentación: «el último backup», «el despliegue»,
      «la temperatura del acuario» con `curl`.
19. **FPS del juego, ventiladores y refrigeración líquida.** Es lo primero
    que enseña el software del fabricante (TRCC) y lo que espera quien
    compra el panel para su PC.
    - *FPS y tiempos de fotograma*: MangoHud (Linux, registro a fichero o su
      socket), PresentMon (Windows, la base de las métricas de Intel y AMD);
      FPS medios, 1 % bajos y una curva de tiempos de fotograma que delata
      los tirones. Solo con un juego abierto.
    - *Ventiladores, bombas y líquido*: liquidctl (AIO y controladores de
      Corsair, NZXT…, en Linux, macOS y Windows), lm-sensors en Linux,
      LibreHardwareMonitor en Windows (por su servidor web o WMI): RPM,
      temperatura del líquido, curvas.
    - Encaja con el punto 21: al abrir un juego, la página de juego.
20. **Precio de la luz por horas** (España, PVPC). Red Eléctrica publica el
    precio de cada hora del día y, hacia las 20:30, el de mañana: API de
    REData o ESIOS, gratis (ESIOS pide un token gratuito).
    - *Widgets*: el precio de ahora frente al del día (barato, normal, caro
      en verde, gris, ámbar), las 24 barras del día con la hora actual
      marcada, y «la hora más barata para la lavadora» (ventana de N horas
      seguidas más barata de lo que queda de día, y de mañana si ya está).
    - Opcional: el excedente solar o el consumo desde Home Assistant
      (`homeassistant/states`) para decir «ahora gastas con luz cara».
    - Plugin en la carpeta de oficiales con nombre neutral
      (`kiosko-plugin-electricity`) y el PVPC como primer proveedor, para
      que otros países añadan el suyo (Nord Pool, aWATTar, Octopus).
21. **Páginas según el contexto.** Hoy una página puede mostrarse siempre,
    en horario laboral o fuera (`when`), y una pantalla puede fijar una
    (`pinnedPage`). Faltan condiciones que cambien de página solas:
    - *Señales*: una aplicación abierta (un juego, OBS, la herramienta de
      videollamadas), estar en una llamada (`calls/active` ya existe), la
      hora o el día, una reunión que empieza, un widget urgente de otra
      página, el valor de una fuente («si la luz está cara»), o un webhook
      del punto 18.
    - *Modelo*: reglas por página con prioridad (`showWhen: { app:
      'steam_app_*' }`, `{ source: 'calls/active', is: true }`), que mandan
      sobre el turno normal mientras se cumplen, y vuelta a la rotación al
      dejar de cumplirse.
    - *Cuidado con*: el parpadeo (un tiempo mínimo en cada página y un
      margen al salir), detectar aplicaciones en los tres sistemas sin
      permisos raros, y enseñar en el editor por qué está cada página en
      pantalla («fijada por: juego abierto»).
22. **Fractales** (`kiosko-plugin-fractals`): animaciones generativas para
    lucir el panel. Lo pesado va en interludios (se preparan antes de
    reproducirse, en `prepare`); lo ligero, como animación de tesela
    (`animation`, 600 fotogramas como mucho). Que algo se mueva además
    ayuda contra el quemado. Por orden de impacto:
    - **Llama fractal que se revela** (*fractal flame*, el algoritmo de
      Apophysis y Electric Sheep), como interludio: millones de puntos sobre
      transformaciones no lineales (espiral, remolino, esfera…) acumulados
      con densidad logarítmica, así que la imagen aparece como una foto en
      el revelador, de un polvo tenue a filamentos luminosos. Semilla por
      franja horaria: cada cuarto de hora, una obra distinta; paleta del
      tema. Unos 20 ms por millón de puntos en JS: cabe en `prepare`.
      **Recomendada**: es la que hace que alguien se pare a mirar.
    - **Árbol que crece**, como widget de tesela: ramas recursivas que
      brotan, se mecen y florecen; vectorial y barato, y en una franja
      ancha, un bosque. Ligado a datos: crece con la jornada (horas,
      commits, tokens) y florece al acabarla; la estación y el viento de
      `weather/current`. **Recomendado** como compañero diario.
    - **Julia que se transforma**: el parámetro recorre el borde del
      Mandelbrot y la figura se retuerce; bucle perfecto, color continuo,
      barato.
    - **Zoom en el Mandelbrot** (valle de los caballitos de mar): clásico
      pero caro a 1920×462 (media resolución y escalar) y sin zoom muy
      profundo (la precisión de `double` se acaba).
    - Más ligeros: el **helecho de Barnsley** o el juego del caos punto a
      punto, la **curva del dragón** desplegándose, y **coral o rayo**
      (agregación por difusión, figuras de Lichtenberg) creciendo desde un
      punto.
    - Cuidado con: el tiempo de `prepare` en máquinas modestas (calcular a
      menos resolución o menos puntos según lo que tarde el primer
      fotograma), la memoria de 300 fotogramas a pantalla completa, y que se
      vea bien en los cinco temas (incluido `paper`, claro).
23. **Cámaras de seguridad (RTSP)** (`kiosko-plugin-cameras`). Lo útil no
    es tenerlas siempre puestas, sino que salgan solas cuando pasa algo.
    - *Hace falta un modo de vídeo en vivo*: ni `animation` ni los
      interludios sirven (precalculan sus fotogramas). Un widget que recibe
      fotogramas continuamente y repinta solo su tesela, a 5-10 fps; con el
      compositor y el tope de ~500 KB por fotograma de los paneles LY es
      viable. Pieza del SDK que también valdría para el reproductor de
      vídeos propios (punto 3) y el visualizador de audio.
    - *Decodificar*: `ffmpeg` como proceso hijo (RTSP → reducido al tamaño
      de la tesela → JPEG por stdout a los fps pedidos), sin dependencias
      nativas, en los tres sistemas. Usar el **subflujo** de la cámara
      (640×360 o similar), no el principal, para que varias quepan en la
      CPU. Sin `ffmpeg`: **go2rtc**, **Frigate** o **Home Assistant**
      (`camera_proxy`) ya dan instantáneas o MJPEG por HTTP; y para una
      instantánea lenta ya basta el widget **Imagen** con la URL.
    - *Widgets*: una cámara, un mosaico de 2-4 o una que va rotando; hora y
      nombre sobreimpresos; aviso si deja de responder.
    - *Eventos*: con **Frigate** (personas, coches) o el timbre y los
      sensores de movimiento de Home Assistant (`homeassistant/states`), la
      cámara de la puerta se queda la tesela unos segundos (`urgent`), con
      el recuadro de lo detectado. Reposo el resto del tiempo, o solo de
      noche, o solo con movimiento.
    - Cuidado con: las credenciales van en la URL RTSP (secreto, y la
      opción con `risk: ['network', 'exec']` porque lanza `ffmpeg`); nunca
      imágenes de cámaras en capturas ni en la demo; la CPU y el ancho de
      banda USB con varios flujos; y el quemado de una imagen fija durante
      horas (desplazamiento de píxeles y reposo).

### Decisiones abiertas para ti

- **Nombre**: `Kiosko` es provisional (el paquete npm está como
  `kiosko`; `kiosko` a secas está cogido). Los paquetes internos usan
  `@kiosko/*`, que no se publican por separado en esta versión.
- **Publicar**: no he creado el repositorio en GitHub ni publicado en npm;
  el README ya asume `kiosko-lcd/kiosko` y `npm install -g kiosko`.
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
