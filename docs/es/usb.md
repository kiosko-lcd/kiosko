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
