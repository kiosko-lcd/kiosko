# Pantallas Wi-Fi (ESP32)

> **Nuevo, experimental.** Kiosko también maneja pequeñas pantallas Wi-Fi con
> un ESP32 y el firmware abierto de Kiosko. Muestran una pantalla de Kiosko
> como cualquier panel, en cualquier sitio de casa. Esta guía explica cómo
> usarlas; el protocolo está en [remote-screen.md](../remote-screen.md).

Lo que tienes:

- **Se anuncia sola.** Kiosko la encuentra en tu red sin que hagas nada.
- **La emparejas con el código de su pantalla.** Solo puede emparejarla quien
  esté delante de ella, y la conexión va cifrada.
- **Se resincroniza sola.** Si se desenchufa o cae la Wi-Fi, Kiosko la
  recupera y le envía la imagen actual en cuanto vuelve.
- **Cualquier orientación**, en vertical o en horizontal, desde Kiosko.
- **Varias a la vez**, cada una con su nombre y sus páginas.

## Qué necesitas

- Una placa compatible. Hoy: la **Waveshare ESP32-C6-LCD-1.47** (172×320).
  Vendrán más; el firmware tiene una capa de placa para ellas.
- Un cable USB-C para instalar el firmware una vez. Después, las
  actualizaciones van por la Wi-Fi.
- Una red Wi-Fi de 2,4 GHz compartida con el ordenador de Kiosko, que deje
  pasar el multicast (mDNS) entre ambos.

## Instalar el firmware

**Desde el navegador (lo más fácil).** Abre el
[instalador web](https://kioskolcd.dev/es/flash/) en Chrome o Edge en un
ordenador, conecta la placa por USB, pulsa *Conectar e instalar* y elige su
puerto. Graba la imagen completa de la última versión; sin instalar nada.
Luego sigue con [Primer arranque y Wi-Fi](#primer-arranque-y-wi-fi).

**Imágenes ya hechas.** Cada versión de Kiosko en
[GitHub](https://github.com/kiosko-lcd/kiosko/releases/latest) incluye, con su
SHA-256:

- `kiosko-screen-<versión>-waveshare-esp32c6-lcd-1.47-full.bin`: la flash
  entera, para una placa nueva por USB. Borra lo que tuviera la placa.
- `kiosko-screen-<versión>-waveshare-esp32c6-lcd-1.47.bin`: solo la
  aplicación, para actualizar desde Kiosko o desde la página de configuración
  de la pantalla.

Para grabar la imagen completa, conecta la placa y usa `esptool` en Docker
(sin instalar nada):

```sh
docker run --rm -v "$PWD:/w" --device /dev/ttyACM0 espressif/idf:v5.5.5 \
  esptool.py --chip esp32c6 -b 921600 write_flash 0x0 /w/kiosko-screen-0.1.1-waveshare-esp32c6-lcd-1.47-full.bin
```

Usa el puerto que te aparezca (`ls /dev/serial/by-id/` en Linux). Sirve
también cualquier otro `esptool` o el grabador web de Espressif.

**Compilarlo tú.** En [firmware/esp32-screen](../../firmware/esp32-screen)
todo va en Docker:

```sh
./idf build           # build/kiosko_screen.bin
./idf flash           # por USB
./idf backup old.bin  # antes, una copia de la flash actual de la placa
```

**Permiso de USB en Linux.** Tu usuario tiene que poder abrir el puerto serie.
Entra en el grupo `dialout` y vuelve a iniciar sesión:

```sh
sudo usermod -aG dialout "$USER"
```

## Primer arranque y Wi-Fi

Sin Wi-Fi guardada, o si no conecta en 20 s, la pantalla abre su propia red,
`Kiosko-<nombre>-setup`, y muestra su contraseña.

1. Conéctate a esa red desde el móvil o el portátil.
2. La página de configuración se abre sola; si no, ve a `http://192.168.4.1`.
3. Elige tu red Wi-Fi y escribe su contraseña. Aquí también puedes ponerle
   nombre a la pantalla (`a-z`, `0-9`, `-`) y su zona horaria.
4. Guarda. La pantalla se reinicia y entra en tu red. Después muestra su
   nombre, su dirección y *Sin emparejar: añádela en Kiosko*.

## Añadirla en Kiosko

De cualquiera de estas formas:

- **Editor.** *Pantallas → Añadir pantalla → Detectar paneles*. La pantalla
  aparece en la lista. Púlsala y mostrará un código de 6 cifras. Escríbelo en
  el editor. Se crea una pantalla nueva con el tamaño del cristal.
- **Asistente del primer arranque.** El paso *Tu panel* muestra las pantallas
  Wi-Fi junto a las USB, cada una con su botón **Emparejar**.
- **Línea de órdenes.**
  ```sh
  kiosko remote list
  kiosko remote pair <uid o dirección>
  ```
  `pair` pide el código que sale en la pantalla.

El código vale para un intento y dura 2 minutos.

## Orientación

Se elige en la tarjeta de la pantalla en Kiosko: *Horizontal* o *Vertical*, y
*Girar 180°* para darle media vuelta. Kiosko envía la página tal como la ves en el
editor, y la pantalla la gira ella misma, sin coste. Si sale boca abajo, pulsa
*Girar 180°*. Manda lo que diga Kiosko: la pantalla lo recibe cada vez que se
conecta.

## Brillo y temperatura

Con el firmware 0.1.2 o posterior, la tarjeta de la pantalla tiene un control
de **Brillo** (0–100 %). La pantalla lo conserva, también sin Kiosko. Sin
fijar, usa el suyo: 70 %, o el que elegiste en su página de configuración.
Con menos brillo se calienta menos.

**Modo noche** (firmware 0.1.4 o posterior en la pantalla): actívalo en la
tarjeta, elige las horas (por ejemplo de 22:30 a 07:00) y el brillo de noche,
hasta *luz apagada*. Al acabar la noche la pantalla vuelve a su brillo. Las
alertas que ocupan la pantalla la encienden igualmente. Y siempre que Kiosko
muestra la pantalla en negro (apagada desde Home Assistant, o dormida porque
nada de la página tiene qué enseñar), su retroiluminación se apaga también.
Nada de esto se guarda en la pantalla: si Kiosko desaparece, la pantalla se
vuelve a encender.

La línea de estado de la tarjeta muestra también la **temperatura del chip**.
Marca más que la habitación: unos 35–45 °C es lo normal en este chip.

## Varias pantallas

Empareja cada una. Cada pantalla tiene su tarjeta, sus páginas y su
orientación. Ponles nombre en su página de configuración (*cocina*,
*escritorio*) para distinguirlas. Kiosko las sigue por su identificador único,
así que cambiarles el nombre no rompe nada. Su nombre en la red es
`kiosko-<nombre>.local`.

## El botón BOOT

| Pulsación | Qué hace |
|---|---|
| Corta | En una pantalla emparejada, admite un nuevo emparejamiento durante 2 minutos (o cancela el que esté en curso) |
| 5 s | Olvida el emparejamiento |
| 10 s | Olvida el emparejamiento y la Wi-Fi, y arranca en modo configuración |

La pantalla cuenta los segundos mientras mantienes el botón.

## Actualizar el firmware

Cuando este Kiosko trae un firmware más nuevo que el de la pantalla, su
tarjeta lo dice y ofrece **Actualizar el firmware a X**. Al pulsarlo, y solo
entonces, Kiosko descarga el firmware de su propia versión en GitHub,
comprueba su SHA-256 y lo envía. Sin acceso a internet (o sin llegar a
GitHub), descarga el fichero de la página de la versión y usa *Actualizar
firmware…*.

A mano: *Actualizar firmware…* en la tarjeta de la pantalla, y elige el `.bin` de la
aplicación (no el `-full`). O desde la línea de órdenes:

```sh
kiosko remote ota <pantalla> kiosko-screen-<versión>-waveshare-esp32c6-lcd-1.47.bin
```

La pantalla comprueba la imagen y se reinicia con ella. Si el firmware nuevo
no consigue entrar en la Wi-Fi, o Kiosko no puede hablar con él después, la
pantalla vuelve sola al anterior.

## Reiniciar y desemparejar

- **Desde Kiosko:** *Desemparejar* en su tarjeta, o
  `kiosko remote unpair <pantalla>`. La pantalla olvida este Kiosko y puede
  volver a emparejarse.
- **En la pantalla:** mantén BOOT 5 s (solo el emparejamiento) o 10 s
  (emparejamiento y Wi-Fi).
- **Para pasarla a otro Kiosko:** pulsa BOOT una vez y empareja desde el otro
  Kiosko antes de 2 minutos.

## Problemas

- **No aparece en la red.**
  - Mira que la pantalla muestre una dirección IP.
  - El ordenador y la pantalla tienen que estar en la misma red, con
    multicast (mDNS) permitido. Las redes de invitados, las VLAN separadas y
    algunos sistemas mesh lo bloquean.
  - `kiosko doctor` muestra lo que oye Kiosko.
  - Como alternativa, escribe la dirección de la pantalla en su tarjeta
    (*Dirección*), o empareja por dirección: `kiosko remote pair 192.168.1.50`.
- **«Ese no es el código de la pantalla».** Cada código sirve una vez.
  Empieza de nuevo: la pantalla muestra otro.
- **«Demasiados códigos erróneos».** Tras cada código erróneo la pantalla
  espera más antes de aceptar otro intento (5 s, 10 s, 20 s… hasta 5
  minutos). Espera y vuelve a intentarlo.
- **«Ya está emparejada con otro Kiosko».** Pulsa BOOT una vez en la pantalla
  y empareja antes de 2 minutos.
- **«Rechaza la clave de este Kiosko».** La pantalla se reinició o se
  emparejó con otro. Usa *Volver a emparejar* en su tarjeta.
- **Desconectada.** La pantalla está desenchufada o fuera de la Wi-Fi. Kiosko
  se reconecta solo en cuanto vuelve, y mientras tanto no llena el registro.
  Mientras no está no se pinta nada para ella (*Panel desconectado · en
  pausa*): no gasta CPU, y vuelve con una imagen nueva.
- **Imágenes lentas.** Decodificar cada imagen cuesta unos 60–90 ms, así que
  las animaciones vivas llegan a unos 8–10 fps. Las páginas quietas no se
  ven afectadas.
