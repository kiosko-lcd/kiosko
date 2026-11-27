# Widgets JSON y pushes desde scripts

Dos formas de poner cualquier cosa en el panel sin escribir un plugin:

- **JSON desde una URL.** Kiosko consulta una URL cada cierto tiempo (una API,
  una página de estado, un sensor de tu red) y muestra un valor de la
  respuesta: en grande con su unidad y una curva, como lista o dentro de una
  frase.
- **Pushes.** Un script, una tarea de cron, tu CI o Home Assistant le mandan
  el valor a Kiosko con un `curl`, cuando tienen algo que contar: la última
  copia de seguridad, un despliegue, la temperatura del acuario.

Los dos vienen con Kiosko (el plugin Básicos): **Valor JSON**, **Lista JSON**,
**Texto JSON** y **Push** están en la biblioteca de widgets del editor, en
Desarrollo.

## JSON desde una URL

Añade un widget **Valor JSON** y rellena:

- **URL**: lo que consulta Kiosko, p. ej.
  `https://api.open-meteo.com/v1/forecast?latitude=40.42&longitude=-3.70&current=temperature_2m`
  (gratis, sin clave).
- **Ruta del valor**: dónde está el valor en la respuesta, p. ej.
  `$.current.temperature_2m`. Al principio déjala vacía: la tesela lista
  entonces las rutas que encuentra en la respuesta, con sus valores, para que
  copies una.
- **Unidad**, **Antes del valor** (`$`, `€`), **Decimales** y una **Etiqueta**.

**Lista JSON** muestra varios valores, uno por fila: enumera los **Campos**
(cada uno con etiqueta, ruta y unidad), o da la ruta de una lista de la
respuesta (**O una lista suya**, p. ej. `$.items`) y, dentro de cada
elemento, la ruta de su etiqueta y de su valor (`name`, `price`). Un objeto
también sirve como lista: cada clave es un elemento con `key` y `value`.

**Texto JSON** escribe una frase con valores dentro:
`Backup {$.status} at {$.finished}`. `{$.items[*].name}` los escribe todos,
separados por comas; `{{` y `}}` escriben llaves.

### Rutas

Una pequeña parte de JSONPath, que se lee sin ejecutar código:

| Ruta | Encuentra |
|---|---|
| `$` | la respuesta entera (también texto plano) |
| `$.current.temperature_2m` | una clave y luego otra (`$` y el primer punto son opcionales: `current.temperature_2m`) |
| `items[0].price` | el primer elemento de una lista |
| `items[-1]` | el último (los índices negativos cuentan desde el final) |
| `['key with spaces']` | una clave con espacios o puntos, entre comillas (`\` escapa una comilla) |
| `items[*].name`, `prices.*` | todos los elementos, o todos los valores de un objeto (para listas y textos) |
| `items.length` | cuántos elementos tiene una lista |

Solo se leen las claves que de verdad están en la respuesta. Una ruta tiene
como mucho 300 caracteres y 32 pasos, y un comodín reúne como mucho 500
valores.

### Colores según el valor

**Colores según el valor** es una lista de reglas; la primera que se cumple
le da su color al valor (verde, azul, ámbar, rojo, el acento del tema o
tenue):

| Regla | Se cumple cuando el valor es |
|---|---|
| `>= 30`, `> 30`, `< 0`, `<= 5` | un número, comparado |
| `30` | un número de 30 o más (un número solo significa `>=`) |
| `= failed`, `!= ok` | ese texto (o no), sin distinguir mayúsculas; o ese número |

En un **Texto JSON**, **Color según** dice qué ruta miran las reglas
(`$.status`); sin él miran la frase entera.

### La curva

**Valor JSON** dibuja debajo el histórico de su valor: un punto por cada
refresco, hasta **Puntos de la curva** (60 por defecto). Se guarda en la
caché de Kiosko (en memoria), así que reiniciar Kiosko no la borra; reiniciar
el ordenador sí. Pon **Curva del histórico** en Ninguna para ver solo el
valor.

### Claves, tokens y cabeceras

Pon la clave o el token en **Secreto**: el editor lo oculta y nunca va a los
registros. Por defecto va tal cual en la cabecera `Authorization`, así que
escribe el valor completo (`Bearer abc123`, `token abc123`). En las opciones
avanzadas:

- **Cabecera del secreto**: otra cabecera (`X-Api-Key`), o vacía.
- `{secret}` escrito en la URL (`…?apikey={secret}`), en el valor de una
  cabecera o en el cuerpo lo pone ahí en su lugar (codificado para URL en la
  URL).
- **Otras cabeceras**, **Método** (GET o POST) y **Cuerpo (POST)** (se envía
  como JSON cuando lo parece).

Como todos los secretos de Kiosko, se guarda en el fichero de configuración
(`~/.config/kiosko/config.json` en Linux), que solo puedes leer tú.

### Refresco, límites y errores

- Cada widget consulta cada minuto por defecto; cámbialo con **Refrescar
  cada** del widget (5 segundos como mínimo: ojo con los límites de la API).
  Dos widgets con la misma URL en el mismo momento comparten una petición.
- **Abandonar tras** (10 s por defecto, hasta 60 s) y **Respuesta más
  grande** (512 KB por defecto, hasta 5 MB): una respuesta mayor se rechaza.
- Kiosko se presenta como `kiosko-core Kiosko (+https://kioskolcd.dev)`,
  devuelve `If-None-Match`/`If-Modified-Since` cuando el servidor dio un ETag
  o una fecha, y cuando un servidor dice «demasiadas peticiones» (429,
  `Retry-After`) espera lo que le digan.
- Cuando una petición falla, el widget conserva su último valor y el editor
  dice por qué bajo las opciones del widget, donde muestra cuándo se
  actualizaron sus datos (`HTTP 404 from api.example.com`,
  `timed out after 10 s`, `response larger than 524288 bytes`).

La URL la escribes tú, así que Kiosko la incluye entre los hosts con los que
contacta la configuración (`kiosko config import` la enseña antes de aplicar
una configuración escrita por otra persona).

## Pushes desde scripts

### Crear uno

En **Ajustes → Push**, escribe un nombre (minúsculas, cifras, `-` y `_`,
p. ej. `backup`) y pulsa **Añadir**. Kiosko le crea un token aleatorio y
muestra su URL, su token y un `curl` para probarlo. Después añade un widget
**Push** a una página y elige ese nombre.

```sh
curl -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"value": 42, "text": "Backup finished"}' http://127.0.0.1:7420/api/push/backup
```

**Token nuevo** lo sustituye (desde ese momento se rechazan los scripts con
el anterior); el icono de la papelera borra el nombre.

### Qué enviar

Un objeto JSON; todos los campos son opcionales:

| Campo | Qué hace con él el widget Push |
|---|---|
| `value` | lo muestra en grande (un número o una palabra corta) |
| `text` (o `message`) | una línea debajo, o sola, tan grande como quepa |
| `title` | pequeño, arriba |
| `unit` | detrás del valor (o la **Unidad** del propio widget) |
| `level` | `ok` (verde), `info` (azul), `warn` (ámbar), `alert` (rojo, y la tesela se queda en pantalla mientras dure), `critical` (rojo, y una alerta a pantalla completa en las pantallas que dejan pasar alertas) |
| `ttlMs` | cuánto vale, en milisegundos (hasta 30 días): pasado ese tiempo el widget se oculta hasta el siguiente push |

El texto plano (`curl -d 'Deploy done' …`) se toma como
`{"text": "Deploy done"}`, y un formulario (`-d value=21.5 -d unit=°C`) como
un objeto, con los números como números. El JSON se lee como JSON sea cual
sea el `Content-Type` (un `curl -d` a secas dice que es un formulario).

Cualquier otro JSON sirve también: muéstralo con un **Valor JSON**, una
**Lista JSON** o un **Texto JSON** cuyo **O un nombre de push** sea ese
nombre, y una ruta dentro (`{"temp": 21.4, "humidity": 48}` con la ruta
`$.temp`). La curva del Valor JSON tiene entonces un punto por push.

### La petición

| | |
|---|---|
| `POST /api/push/<name>` (o `PUT`) | el contenido nuevo; responde `{"ok": true, "at": …}` |
| `GET /api/push/<name>` | lo que tiene ahora |
| `DELETE /api/push/<name>` | lo olvida |
| Token | `Authorization: Bearer <token>`, o `?token=<token>` en la URL |

Respuestas: `401` para un nombre desconocido o un token incorrecto (la misma,
para que no se puedan adivinar nombres), `400` para un cuerpo vacío o un JSON
roto enviado como JSON, `413` por encima de 64 KB, `429` por encima de 20
peticiones seguidas y de 5 por segundo después, por nombre (espera lo que
diga `Retry-After`).

El último contenido de cada nombre, y un breve histórico para la curva (hasta
240 o 64 KB), se guardan en memoria y en `push.json` junto al fichero de
configuración, así que un reinicio no deja en blanco una tesela que cambia
una vez al día.

### Solo en este ordenador

El editor y la API de Kiosko escuchan en `127.0.0.1:7420`, solo en este
ordenador, y los pushes entran por el mismo sitio. Para enviar desde otro
lado:

- **Ejecuta el script aquí**, donde corre Kiosko (cron, un temporizador de
  systemd, un hook de git, un runner de CI propio).
- **O trae el puerto por un túnel**, desde la otra máquina:
  `ssh -N -L 7420:127.0.0.1:7420 you@kiosko-machine`, y envía allí a
  `http://127.0.0.1:7420/…`.
- O un pequeño script aquí que vaya a buscar lo que necesita y lo envíe.

No abras el puerto a tu red (`server.host: 0.0.0.0`) para esto: también
quedaría abierto todo el editor.

### Por qué los pushes no necesitan `X-Kiosko: 1`

Cualquier otra petición que cambie algo tiene que llevar la cabecera
`X-Kiosko: 1`: una página web que visites no puede enviarla a `127.0.0.1` sin
que el navegador pregunte antes a Kiosko, y Kiosko nunca dice que sí, así que
una página no puede manejar el editor a tus espaldas (CSRF). Un push lleva su
propio secreto, el token, que esa página no puede conocer, así que pedir
también la cabecera solo alargaría los scripts. Un push solo puede cambiar lo
que muestra su nombre; no puede tocar la configuración, los plugins ni nada
más. La comprobación de `Host` que frena el DNS rebinding se sigue aplicando.

## Recetas

### La última copia de seguridad

Al final del script de copia:

```sh
#!/bin/sh
TOKEN=…   # Ajustes → Push → backup
if restic backup /home; then
  body='{"title": "Backup", "value": "OK", "text": "'"$(date +%H:%M)"'", "level": "ok", "ttlMs": 129600000}'
else
  body='{"title": "Backup", "value": "FAILED", "level": "alert"}'
fi
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -d "$body" http://127.0.0.1:7420/api/push/backup
```

`ttlMs` de 36 horas: si falla una noche, la tesela desaparece en vez de decir
«OK» de una copia vieja.

### El despliegue

Desde un script de despliegue o un runner de CI propio en la misma máquina:

```sh
curl -fsS -X POST -H "Authorization: Bearer $KIOSKO_TOKEN" \
  -d "{\"title\": \"Deploy\", \"value\": \"#$CI_PIPELINE_ID\", \"text\": \"$CI_COMMIT_REF_NAME passed\", \"level\": \"ok\", \"ttlMs\": 3600000}" \
  http://127.0.0.1:7420/api/push/deploy
```

### La temperatura del acuario

Un sensor que cron lee cada 5 minutos (`*/5 * * * *`), mostrado con un
**Valor JSON** con **O un nombre de push** `aquarium`, ruta `$.temp`, unidad
`°C`, colores `< 23` azul y `> 27` rojo, y su curva:

```sh
t=$(cat /sys/bus/w1/devices/28-*/temperature)
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -d "{\"temp\": $(echo "scale=1; $t/1000" | bc)}" \
  http://127.0.0.1:7420/api/push/aquarium
```

### Home Assistant

Con Home Assistant en la misma máquina (o el puerto traído por un túnel), un
`rest_command` en `configuration.yaml`:

```yaml
rest_command:
  kiosko_doorbell:
    url: http://127.0.0.1:7420/api/push/doorbell
    method: POST
    headers:
      authorization: "Bearer <token>"
    content_type: application/json
    payload: '{"title": "Doorbell", "text": "Someone at the door", "level": "alert", "ttlMs": 120000}'
```

Llámalo desde una automatización (`action: rest_command.kiosko_doorbell`).
Para ver las entidades de Home Assistant todo el tiempo, es mejor el plugin
de Home Assistant.

### Windows (PowerShell)

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7420/api/push/backup `
  -Headers @{ Authorization = "Bearer <token>" } -ContentType application/json `
  -Body '{"value": "OK", "level": "ok"}'
```
