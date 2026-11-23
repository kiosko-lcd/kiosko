# Pantallas en navegador (tabletas, móviles)

> **Nuevo, experimental.** Cualquier navegador de tu red puede mostrar una
> pantalla de Kiosko a pantalla completa: una tableta vieja en la pared, un
> móvil que te sobra en la mesa. Sin comprar hardware y sin firmware: abres una
> dirección, escribes un código en el editor y listo. Para pantallas Wi-Fi
> pequeñas con el firmware propio de Kiosko, mira
> [remote-screens.md](remote-screens.md).

Lo que tienes:

- **Emparejamiento con un código.** El navegador muestra un código de 6
  cifras y tú lo escribes en el editor. Solo recibe imágenes un navegador que
  hayas emparejado, y viajan cifradas.
- **Se adapta al dispositivo.** La pantalla toma el tamaño de la ventana del
  navegador y gira cuando gira la tableta.
- **Vuelve sola.** Después de que la tableta se duerma, se caiga la Wi-Fi o se
  recargue la página, se reconecta sin volver a emparejar y muestra enseguida
  la imagen actual.
- **El editor sigue siendo privado.** Los navegadores hablan con un segundo
  servidor, pequeño, que solo sirve la página de la pantalla; el editor sigue
  escuchando solo en este ordenador.

## Encender las pantallas por la red

Están apagadas hasta que las enciendas. En el editor, **Pantallas**, abajo del
todo: **Pantallas por la red (navegadores)**. Enciéndelas y elige:

- **Escuchar en**: *La red local* (todas las interfaces, lo habitual), *Solo
  este ordenador* (para una tableta por cable USB, mira
  [Modo cable](#modo-cable-android-por-usb)), o una dirección de este
  ordenador.
- **Puerto**: 7429, salvo que ya esté ocupado.

La tarjeta muestra entonces la dirección que hay que abrir (una por cada
interfaz de red de este ordenador) y su código QR.

En el archivo de configuración queda así:

```json
"networkScreens": { "enabled": true, "host": "0.0.0.0", "port": 7429 }
```

Tu cortafuegos tiene que dejar que la tableta llegue a ese puerto (en Windows,
permite Node.js en redes privadas cuando te lo pregunte).

## Añadir un navegador

1. En la tableta o el móvil, abre la dirección que muestra el editor, p. ej.
   `http://192.168.1.20:7429/` (o escanea el código QR). La página muestra un
   código grande de 6 cifras y, debajo, qué navegador es y 4 caracteres de su
   identificador.
2. En el editor: **Pantallas → Añadir pantalla → Navegador (tableta,
   móvil…)**. Aparecen los navegadores que esperan a ser emparejados, con su
   tamaño y su dirección.
3. Elige el tuyo (si solo hay uno esperando, ya está elegido) y escribe su
   código. Un código erróneo se rechaza, el navegador muestra otro y el
   siguiente intento tiene que esperar un poco (más tras cada código erróneo).
4. Aparece una pantalla nueva, con el tamaño del navegador y su primera
   página. Edítala como cualquier otra.

Toca la página para ponerla a pantalla completa. Mantén pulsado en cualquier
sitio (o toca la esquina superior derecha) para abrir su menú: pantalla
completa y olvidar el emparejamiento.

Para emparejar un navegador con una pantalla que ya existe en vez de con una
nueva, usa **Volver a emparejar** en la tarjeta de esa pantalla.

## Tamaño y orientación

Con **Seguir el tamaño del navegador** activado (lo predeterminado), la
pantalla toma el tamaño de la ventana del navegador en píxeles del
dispositivo (el lado largo, como mucho 1920) y pasa de horizontal a vertical
cuando lo hace el dispositivo, recolocando sus páginas como en cualquier panel
que gires. Los cambios pequeños (una barra de direcciones que aparece y
desaparece) se ignoran. Desactívalo para mantener un tamaño que fijes tú: el
navegador muestra entonces la imagen tan grande como quepa.

## Mantener la pantalla encendida

Los navegadores dejan que la pantalla se apague salvo que la página les pida
lo contrario. La página hace lo que puede:

- **Wake Lock**, donde el navegador lo permite: solo en páginas seguras
  (`https`, o `http://127.0.0.1`, mira [Modo cable](#modo-cable-android-por-usb)).
  Una página en `http://192.168.x.x` no lo es.
- En los demás casos, un **vídeo diminuto y sin sonido** que no deja de
  reproducirse, lo que mantiene despiertos a la mayoría de los navegadores
  móviles. Algunos no cuentan un vídeo silenciado: entonces usa una de las
  opciones de abajo.

El menú de la página dice cuál está funcionando. Más fiable, sea cual sea el
navegador:

- El ajuste del propio dispositivo: el tiempo de espera de pantalla más largo;
  en Android, *Opciones para desarrolladores → Pantalla activa* la mantiene
  encendida mientras se carga.
- Una **app de navegador en modo quiosco** (en Android, apps como Fully Kiosk
  Browser; en iPad, *Acceso guiado* con *Bloqueo automático: Nunca*): pantalla
  completa, siempre despierta y arrancada al encender. Apúntala a la dirección
  de la página.
- Añadir la página a la pantalla de inicio la abre sin las barras del
  navegador.

## Modo cable (Android por USB)

Una tableta Android conectada por cable USB puede llegar a Kiosko sin ninguna
red, y como página segura (así que Wake Lock funciona):

1. En la tableta, activa *Opciones para desarrolladores → Depuración por USB*;
   conéctala y acepta el ordenador.
2. En el editor, pon las pantallas por la red a escuchar en **Solo este
   ordenador** (`"host": "127.0.0.1"`): no se expone nada a la red.
3. En el ordenador, ejecuta `adb reverse tcp:7429 tcp:7429`.
4. En la tableta, abre `http://127.0.0.1:7429/` y emparéjala como arriba.

`adb reverse` dura hasta que se desenchufa el cable o se reinicia la tableta:
entonces vuelve a ejecutarlo (puede hacerlo un pequeño script o una regla de
udev).

## Seguridad

Lo que expone el servidor de pantallas por la red, a cualquiera de tu red:

- la página del visor (su HTML, su script, su estilo y su icono);
- un WebSocket donde un navegador demuestra que tiene una clave de
  emparejamiento o espera a ser emparejado mostrando un código.

Todo lo demás responde 404. Es un servidor aparte, no el del editor con menos
permisos: no tiene ninguna ruta al editor, a su API, a la configuración, a los
registros ni a los plugins, y el editor sigue escuchando solo en 127.0.0.1.

Cómo se confía en los navegadores:

- **Emparejamiento**: es SPAKE2 (el mismo que el de las pantallas ESP32),
  sobre el código que muestra el navegador: alguien tiene que leerlo en la
  pantalla y escribirlo en el editor. Un código erróneo no revela nada, hace
  que el navegador saque otro y obliga a esperar al siguiente intento (5 s,
  doblando hasta un minuto).
- **Sesiones**: en cada conexión, los dos lados demuestran que tienen la clave
  sobre nonces nuevos, y después cada mensaje va sellado con
  ChaCha20-Poly1305 con claves creadas para esa conexión. Un navegador sin una
  clave válida no recibe ninguna imagen; un mensaje que no se puede abrir
  termina la sesión.
- **Límites**: 32 conexiones a la vez, 4 WebSockets por dirección, 8
  navegadores esperando, 4 KB por mensaje de un navegador; una página de otro
  sitio no puede abrir el WebSocket.
- **Revocar**: *Revocar* en la tarjeta de la pantalla quita la clave de la
  configuración y le dice al navegador que la olvide; vuelve a mostrar un
  código. *Olvidar el emparejamiento* en el menú de la página hace lo mismo
  desde la tableta.

De qué no protege:

- La página se sirve por HTTP sin cifrar: quien pueda manipular el tráfico de
  tu red local podría servirle a la tableta una página modificada. El modo
  cable, o una red de confianza, lo evita.
- La clave de emparejamiento se guarda en el almacenamiento del navegador:
  quien tenga la tableta desbloqueada puede copiarla. Revoca una tableta que
  pierdas.
- Cualquiera de tu red puede abrir la página, y un dispositivo puede meterse
  en la lista de navegadores esperando; aun así, emparejar necesita el código
  que muestra *tu* tableta. Comprueba la dirección y los 4 caracteres antes de
  escribirlo.

## Problemas

- **La página no abre**: ¿la tarjeta dice *Encendido, puerto 7429*? ¿Está la
  tableta en la misma red y la deja pasar el cortafuegos? Prueba las otras
  direcciones que muestra la tarjeta.
- **No hay ningún navegador en la lista**: la página tiene que estar abierta y
  mostrando un código. Una tableta que se ha dormido con la página abierta
  desaparece de la lista al cabo de medio minuto; despiértala.
- **La imagen se para cuando la tableta se duerme**: mira
  [Mantener la pantalla encendida](#mantener-la-pantalla-encendida). Se
  reanuda sola cuando la tableta despierta.
- **Vuelve a un código después de haber funcionado**: la pantalla se revocó o
  se borró en Kiosko, o se vació el almacenamiento del navegador. Vuelve a
  emparejarla.

Los mensajes están en
[packages/core/src/browser/protocol.ts](../../packages/core/src/browser/protocol.ts):
los del protocolo de pantallas remotas ([remote-screen.md](../remote-screen.md))
sobre un WebSocket, con el navegador conectando y hablando primero.
