# Ein Panel über USB anschließen

Die **USB**-Verbindung (`"device": { "driver": "usb" }`) lässt Kiosko selbst
mit einem Thermalright-LY-Panel sprechen (Trofeo Vision 9.16 und Verwandte;
USB `0416:5408` und `0416:5409`), über libusb. Ohne Python, ohne `trcc serve`.

```json
"device": { "driver": "usb", "serial": "202592047DAE" }
```

- `serial`: die USB-Seriennummer. **Bei mehreren gleichen Panels ist sie das
  Einzige, was sie unterscheidet**, also trag sie ein. Auf eine Seriennummer,
  die nicht gefunden wird, wird gewartet; sie wird nie durch ein anderes Panel
  ersetzt (einen Zwilling zu nehmen, den ein anderer Prozess hält, würde ihn
  schwarz machen). Leer: das erste gefundene Panel.
- `keepalive`: Sekunden zwischen dem erneuten Senden eines unveränderten Bildes
  (Standard 1). Die Firmware zeigt 2–3 s nach dem letzten Bild wieder das
  Werkslogo.

`kiosko doctor` listet die Panels, die libusb sieht, mit ihren Seriennummern,
und im Editor bietet **Bildschirme → Bildschirm hinzufügen → Panels erkennen**
sie an.

Bilder sind immer JPEG. Die Firmware nimmt bis etwa 511 871 Bytes an und
verwirft alles Größere **stillschweigend**; Kiosko liest die Bestätigung des
Panels und meldet es im Status des Bildschirms („das Panel hat ein Bild mit …
KB verworfen: JPEG-Qualität senken“).

## Was jedes System braucht

**Linux.** Dein Benutzer muss das Gerät öffnen dürfen. Zeigt `kiosko doctor`
`(unreadable)` oder einen Zugriffsfehler, füge eine udev-Regel hinzu und steck
das Panel neu ein:

```
# /etc/udev/rules.d/99-kiosko-lcd.rules
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0416", ATTR{idProduct}=="540[89]", TAG+="uaccess"
```

(`sudo udevadm control --reload && sudo udevadm trigger`.) Kiosko löst den
Kernel-Treiber, solange es das Panel nutzt, und gibt ihn danach zurück. Zwei
Programme können ein Panel nicht gleichzeitig nutzen: Beende `trcc serve` oder
`kiosko-sender` für das Panel, das du Kiosko gibst.

**Windows.** libusb sieht nur Geräte mit dem **WinUSB**-Treiber. Installiere
ihn einmal als Administrator mit [Zadig](https://zadig.akeo.ie/) für das Panel
(Panel wählen, Treiber *WinUSB*, *Replace Driver*). Solange das Panel WinUSB
hat, sieht die offizielle Thermalright-Software TRCC es nicht mehr; stell den
ursprünglichen Treiber im Geräte-Manager wieder her, wenn du ihn brauchst.
Ohne WinUSB zeigt `kiosko doctor` `LIBUSB_ERROR_NOT_SUPPORTED`.

**macOS.** Nichts zu installieren.

Das native Modul (`usb`) ist eine **optionale** Abhängigkeit mit fertigen
Binärdateien für Linux, macOS und Windows; lässt es sich nicht laden,
funktioniert der Rest von Kiosko, und diese Verbindung sagt, warum.

## Stand

Geschrieben nach dem Protokoll, wie es
[thermalright-trcc-linux](https://github.com/Lexonight1/thermalright-trcc-linux)
9.12 umsetzt: Der Bytestrom eines Bildes ist bei den 22 Testbildern in
`packages/usb-ly` (von `trcc` selbst erzeugt) identisch mit dem von `trcc`,
und der Rest wird gegen eine simulierte Firmware getestet. **Mit einem echten
Panel wurde es noch nicht ausprobiert**, auch nicht unter macOS oder Windows:
Betrachte es als experimentell und halte `trcc serve` oder einen Sender in eine
Bilddatei als Ausweichlösung bereit.
