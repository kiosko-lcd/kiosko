# Conectar un panel por USB

La conexión **USB** (`"device": { "driver": "usb" }`) permite a Kiosko hablar
él solo con un panel LY de Thermalright (Trofeo Vision 9.16 y hermanos; USB
`0416:5408` y `0416:5409`), mediante libusb. Sin Python y sin `trcc serve`.

```json
"device": { "driver": "usb", "serial": "202592047DAE" }
```

- `serial`: el número de serie USB. **Con varios paneles iguales es lo único
  que los distingue**, así que rellénalo. Un número de serie que no aparece se
  espera; nunca se sustituye por otro panel (coger un gemelo que usa otro
  proceso lo dejaría en negro). Vacío: el primer panel que se encuentre.
- `keepalive`: segundos entre reenvíos de un fotograma que no cambia (1 por
  defecto). El firmware vuelve a mostrar el logo de fábrica 2–3 s después del
  último fotograma.

`kiosko doctor` lista los paneles que ve libusb, con sus números de serie, y
en el editor **Pantallas → Añadir pantalla → Detectar paneles** los ofrece.

Los fotogramas van siempre en JPEG. El firmware admite hasta unos 511 871
bytes y descarta **sin avisar** lo que pase de ahí; Kiosko lee la confirmación
del panel y lo dice en el estado de la pantalla («el panel descartó un
fotograma de … KB: baja la calidad JPEG»).

## Paneles desenchufados: su pantalla se pausa (presencia)

Una pantalla sin panel gasta CPU para nadie: su página se compone, sus widgets
se pintan y sus fotogramas se codifican igual. Por eso Kiosko **pausa la
pantalla cuyo panel falta**: no se compone, pinta ni codifica nada para ella,
sus interludios, animaciones y alertas esperan, y las fuentes y consultas que
solo ella enseña se paran. Se vuelve a buscar de forma barata (a los 2 s, 4 s,
8 s… hasta cada 30 s, y al momento con un evento de conexión USB: inotify en
`/dev/bus/usb` en Linux, los eventos hotplug de libusb en el resto) y la
pantalla **vuelve con un fotograma nuevo y completo** en cuanto vuelve el
panel. El editor dice *Panel desconectado · en pausa (ahorrando CPU)* y
`kiosko doctor` enseña la presencia de cada pantalla de tipo Fichero de
fotograma. Una pantalla que apagaste sigue apagada: la presencia no es su
interruptor.

Una pantalla que se pinta en un hilo propio devuelve además ese hilo cuando
lleva un minuto en pausa (su memoria: sus plugins, tipos de letra, imágenes y
teselas pintadas, decenas de MB), y recibe uno nuevo, que pinta el fotograma
entero desde cero, cuando vuelve el panel.

- Conexión **USB**: automática. El panel falta cuando no hay enchufado ningún
  panel LY con su `serial` (ninguno en absoluto, si no tiene). Se mira sin abrirlo.
- **Pantalla remota**: automática. Desconectada (sin sesión ni anuncio mDNS) o
  sin emparejar cuenta como ausente; su anuncio la trae de vuelta al momento.
- **Fichero de frame**: Kiosko no ve el panel que lleva su emisor, así que
  hay que decirle cómo con `presence` (sin ello la pantalla se pinta siempre,
  como hasta ahora):

```json
"device": {
  "driver": "file",
  "dir": "$XDG_RUNTIME_DIR/kiosko/left",
  "presence": {
    "usb": { "vendorId": "0416", "productId": "5408", "serial": "202592047DAE" },
    "heartbeat": { "path": ".heartbeat", "maxAgeMs": 5000 }
  }
}
```

- `usb`: hay enchufado un dispositivo USB con ese fabricante y producto (y
  número de serie). Solo lectura: en Linux desde sysfs, sin abrir el
  dispositivo; en el resto libusb lo abre un instante para leer el número de
  serie, una vez por conexión, y nunca lo reclama. El emisor sigue con el
  panel sin enterarse.
- `heartbeat`: un fichero que el emisor toca mientras lleva el panel; si falta
  o tiene más de `maxAgeMs` (5000 por defecto), el panel falta. Una ruta
  relativa va dentro de `dir`. El emisor de `contrib/usb-sender` toca
  `.heartbeat` en la carpeta que enseña cada segundo mientras su panel está
  conectado.
- `command`: `{ "argv": ["lsusb", "-d", "0416:5408"], "everyMs": 30000 }`: un
  programa (sin shell) que sale con 0 mientras el panel está; se ejecuta cada
  `everyMs` (como poco cada 5 s) y se mata a los 10 s. Al importar una config
  aparece en la revisión, como todo valor que ejecuta programas.

Con varias comprobaciones, falta si **alguna** dice que falta. Una que no
puede saberlo (sin libusb, un gemelo cuyo número de serie no se lee) dice
*desconocido*, y esas pantallas se pintan como siempre.

En el editor: **Pantallas → (la pantalla) → Fichero de frame → Pausar
cuando su panel esté desenchufado**, y **Detectar números de serie** lista los
dispositivos con ese VID:PID y sus números de serie (solo lectura), diciendo
qué pantalla usa ya cada uno.

**Los paneles iguales necesitan el número de serie.** Todos los Trofeo Vision
dicen `0416:5408`. Sin `serial`, Kiosko solo sabe que hay *algún* panel
enchufado, nunca *cuál*, así que solo pausa la pantalla cuando no hay
**ninguno**. Con dos de tres desenchufados y sin números de serie no se pausa
nada, a propósito: pausar una pantalla cuyo panel sí está la dejaría
congelada. `kiosko doctor` lista los números de serie (también `lsusb -v -d
0416:5408 | grep iSerial`).

### Con el emisor de trcc (`contrib/usb-sender`)

Cada emisor lleva un panel, elegido por número de serie, y enseña el
`frame.jpg` de una carpeta. A cada pantalla Fichero de frame, la presencia
de *su* emisor:

- Sin `wheel` en la config de los emisores vale cualquiera: `usb` con el
  `serial` del emisor no necesita nada de él; `heartbeat` además nota que el
  emisor no está corriendo.
- **Con `wheel`** (los paneles se turnan cada pocas horas en enseñar cada
  carpeta) la carpeta que enseña un panel cambia, así que su número de serie
  no dice qué pantalla enseña: usa solo **`heartbeat`** (`{ "path":
  ".heartbeat" }`). El emisor toca el latido de la carpeta que enseña *ahora*,
  así que se pintan justo las pantallas que algún panel conectado está
  enseñando; en el cambio de turno el latido de la carpeta nueva se toca en
  menos de un segundo y su pantalla vuelve.

El latido necesita el `kiosko-sender.py` actualizado (toca `.heartbeat` salvo
que su config diga `"heartbeat": false`). Un emisor antiguo no lo toca nunca y
la pantalla se quedaría en pausa: actualiza antes el emisor.

## Lo que necesita cada sistema

**Linux.** Tu usuario debe poder abrir el dispositivo. Si `kiosko doctor`
muestra `(unreadable)` o un error de acceso, añade una regla de udev y vuelve
a enchufar el panel:

```
# /etc/udev/rules.d/99-kiosko-lcd.rules
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0416", ATTR{idProduct}=="540[89]", TAG+="uaccess"
```

(`sudo udevadm control --reload && sudo udevadm trigger`.) Kiosko suelta el
controlador del núcleo mientras usa el panel y lo devuelve al terminar. Dos
programas no pueden usar un panel a la vez: para `trcc serve` o
`kiosko-sender` en el panel que le des a Kiosko.

**Windows.** libusb solo ve los dispositivos con el controlador **WinUSB**.
Instálalo para el panel con [Zadig](https://zadig.akeo.ie/) (elige el panel,
controlador *WinUSB*, *Replace Driver*) una vez, como administrador. Mientras
el panel tenga WinUSB, el programa oficial TRCC de Thermalright deja de verlo;
recupera el controlador original desde el Administrador de dispositivos si lo
necesitas. Sin WinUSB, `kiosko doctor` muestra `LIBUSB_ERROR_NOT_SUPPORTED`.

**macOS.** No hay que instalar nada.

El módulo nativo (`usb`) es una dependencia **opcional** con binarios ya
compilados para Linux, macOS y Windows; si no se puede cargar, todo lo demás
de Kiosko funciona y esta conexión dice por qué.

## Estado

Escrito a partir del protocolo tal como lo implementa
[thermalright-trcc-linux](https://github.com/Lexonight1/thermalright-trcc-linux)
9.12: los bytes de un fotograma son idénticos a los de `trcc` en los 22
fotogramas de prueba de `packages/usb-ly` (generados por el propio `trcc`), y
el resto se prueba contra un firmware simulado. **Aún no se ha probado con un
panel real**, ni en macOS ni en Windows: tómalo como experimental y guarda
`trcc serve` o un emisor de fotogramas a fichero como alternativa.
