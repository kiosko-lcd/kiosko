# Páginas: turnos, fijadas y páginas según el contexto

Una pantalla puede tener varias páginas: un panel de mando, la sala de los
gatos, una página para jugar. Esta guía cuenta cuál sale en el panel en cada
momento.

## Cómo se turnan las páginas

- **Turnos.** Las páginas activas se turnan, cada una su *Tiempo en
  pantalla* (`durationMs`, 10 minutos si no se dice), contra el reloj: dos
  Kiosko con las mismas páginas enseñan la misma.
- **Cuándo.** Una página puede salir *siempre*, solo *en horario laboral* o
  solo *fuera de él* (`when`, según el horario de Ajustes).
- **Fijada.** La chincheta de la tarjeta de una página la deja puesta
  (`pinnedPage`; Home Assistant y la API también pueden fijar una).
- Los **interludios** salen cada cierto tiempo sobre la página que esté, y las
  **alertas** se quedan el panel por encima de todo.

## Mostrar esta página cuando…

Una página también puede salir **sola** mientras pasa algo: hay un juego
abierto, estás en una llamada, la luz está cara, es viernes por la tarde, va a
empezar una reunión. Abre la página (pulsa su tarjeta y luego un hueco vacío
del lienzo) y, en sus ajustes, añade una condición en **Mostrar esta página
cuando…**:

| Condición | Se cumple mientras… |
|---|---|
| **Un programa abierto** | haya un proceso con ese nombre. Un patrón, sin distinguir mayúsculas: `steam*`, `obs*`, `zoom*`; varios, separados por comas. |
| **El valor de una fuente** | los datos de una fuente, en una ruta, cumplan la comparación, por ejemplo `calls/active` · `active` · *está activo*; `electricity/pvpc` · `now.price` · *es mayor que* · `0.2`. |
| **Una franja horaria** | la hora local esté dentro, los días que elijas. De `22:00` a `07:00` cruza la medianoche. |
| **Un widget de aquí es urgente** | un widget de esta página diga que es urgente (una reunión a punto de empezar, un permiso esperando). |

Mientras se cumple una condición, la página se queda la pantalla y deja los
turnos a un lado; cuando ya no se cumple ninguna, vuelven los turnos donde
diga el reloj. Una página con condiciones **solo** sale cuando se cumplen,
salvo que actives *Entrar también en la rotación*.

- **Varias a la vez.** Cada condición tiene **prioridad**: gana la más alta.
  Las páginas de igual prioridad se turnan entre ellas.
- **Sin parpadeo.** Una página de contexto se queda al menos 20 s desde que
  sale, y 10 s más cuando su condición deja de cumplirse, por si vuelve (un
  juego que se reinicia, un valor que ronda el umbral). Las dos cosas son por
  pantalla, en *Contra el parpadeo*. Una de más prioridad nunca espera.
- **Qué va antes**: una alerta, luego una página fijada, luego una de
  contexto, luego los turnos. Mientras hay una de contexto, los interludios
  programados esperan.
- **¿Por qué está esta página?** Junto a las páginas, el editor dice cuál
  tiene la pantalla y por qué: *fijada por: juego abierto (steam)*.

Una condición puede llevar **nombre** («juego abierto»): el editor lo enseña
como motivo. En el fichero de configuración, una misma condición puede mirar
varias cosas a la vez, y deben cumplirse todas:

```json
"showWhen": [
  { "label": "juego abierto", "priority": 5, "app": "steam*, *.x86_64" },
  { "label": "en llamada", "priority": 9, "source": "calls/active", "path": "active" },
  { "time": { "start": "18:00", "end": "23:00", "days": [5, 6] }, "source": "electricity/pvpc", "path": "now.price", "op": "lt", "value": 0.1 }
]
```

Comparaciones (`op`): `truthy` (la de por defecto sin `value`), `falsy`, `eq`
(la de por defecto con él), `ne`, `gt`, `gte`, `lt`, `lte`, `contains`. Una
fuente que aún no ha mandado datos, o una ruta que no está, nunca se cumple.
La fuente funciona aunque ningún widget la enseñe. Los márgenes de la
pantalla son `"context": { "minMs": 20000, "holdMs": 10000 }`.

### Los programas en cada sistema

Kiosko mira los programas abiertos cada 3 segundos, y solo mientras alguna
condición lo necesita, con lo que puede leer cualquier usuario:

- **Linux**: el nombre que da el núcleo a cada proceso (cortado a 15
  caracteres) y el nombre con el que se arrancó (`argv[0]`, el nombre
  entero). Si `/proc` está montado con `hidepid`, solo se ven los procesos
  propios. Los juegos con Proton de Steam suelen salir como su `.exe`
  (`*.exe` los coge todos).
- **macOS**: el nombre del ejecutable y el de su aplicación (`zoom.us`,
  `OBS`).
- **Windows**: el nombre de la imagen, con o sin `.exe` (`steam.exe`,
  `steam`).

Solo se leen nombres, nunca líneas de órdenes. Los programas de un
contenedor o de otro ordenador no se ven.

### Todavía no

Una reunión que empieza, un webhook o una pantalla que empieza a emitir aún
no son condiciones propias; el widget del calendario cuando es urgente, o una
fuente con ese valor, cubren parte.
