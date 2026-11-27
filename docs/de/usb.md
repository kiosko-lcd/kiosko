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

## Ausgesteckte Panels pausieren ihren Bildschirm (Anwesenheit)

Ein Bildschirm ohne Panel kostet CPU für niemanden: Seite zusammensetzen,
Widgets zeichnen, Bilder kodieren, alles wie sonst. Deshalb **pausiert Kiosko
einen Bildschirm, dessen Panel fehlt**: Für ihn wird nichts zusammengesetzt,
gezeichnet oder kodiert, Zwischenspiele, Animationen und Alarme warten, und
die Quellen und Abrufe, die nur er zeigt, halten an. Er wird sparsam wieder
gesucht (nach 2 s, 4 s, 8 s … bis alle 30 s, und sofort bei einem
USB-Hotplug-Ereignis: inotify auf `/dev/bus/usb` unter Linux, die
Hotplug-Ereignisse von libusb sonst), und der Bildschirm **macht mit einem
frischen, vollständigen Bild weiter**, sobald das Panel zurück ist. Der Editor
zeigt *Panel getrennt · pausiert (spart CPU)*, und `kiosko doctor` zeigt die
Anwesenheit jedes Bilddatei-Bildschirms. Ein Bildschirm, den du ausgeschaltet
hast, bleibt aus: Anwesenheit ist nicht sein Schalter.

Ein Bildschirm, der in einem eigenen Thread gemalt wird, gibt diesen Thread
außerdem zurück, sobald er eine Minute pausiert ist (der Speicher des
Threads: seine Plugins, Schriften, Bilder und gemalten Kacheln, einige zehn
MB), und bekommt einen neuen, der das ganze Bild von vorn malt, wenn das
Panel wieder da ist.

- **USB**-Verbindung: automatisch. Das Panel fehlt, wenn kein LY-Panel mit
  seiner `serial` eingesteckt ist (ohne Seriennummer: gar keins). Nachgeschaut,
  ohne es zu öffnen.
- **Remote-Bildschirm**: automatisch. Offline (keine Sitzung, keine
  mDNS-Ankündigung) oder nicht gekoppelt gilt als fehlend; seine Ankündigung
  holt ihn sofort zurück.
- **Bilddatei**: Kiosko sieht das Panel nicht, das sein Sender steuert, also
  sag es ihm mit `presence` (ohne wird der Bildschirm wie bisher immer
  gezeichnet):

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

- `usb`: Ein USB-Gerät mit dieser Hersteller- und Produkt-ID (und
  Seriennummer) ist eingesteckt. Nur lesend: unter Linux aus sysfs, ohne das
  Gerät überhaupt zu öffnen; sonst öffnet libusb es kurz, um die Seriennummer
  zu lesen, einmal pro Einstecken, und beansprucht es nie. Der Sender behält
  das Panel ungestört.
- `heartbeat`: Eine Datei, die der Sender berührt, solange er das Panel
  steuert; fehlt sie oder ist sie älter als `maxAgeMs` (Standard 5000), fehlt
  das Panel. Ein relativer Pfad liegt in `dir`. Der Sender in
  `contrib/usb-sender` berührt jede Sekunde `.heartbeat` im Ordner, den er
  gerade zeigt, solange sein Panel verbunden ist.
- `command`: `{ "argv": ["lsusb", "-d", "0416:5408"], "everyMs": 30000 }`: ein
  Programm (ohne Shell), das mit 0 endet, solange das Panel da ist; läuft alle
  `everyMs` (mindestens 5 s), wird nach 10 s beendet. Beim Import einer
  Konfiguration wird es zur Prüfung aufgelistet, wie jeder Wert, der Programme
  startet.

Mehrere Prüfungen: Fehlt, wenn **eine** sagt, es fehlt. Eine, die es nicht
wissen kann (kein libusb, ein Zwilling mit unlesbarer Seriennummer), sagt
*unbekannt*, und solche Bildschirme werden wie immer gezeichnet.

Im Editor: **Bildschirme → (der Bildschirm) → Bilddatei → Pausieren, wenn das
Panel ausgesteckt ist**, und **Seriennummern erkennen** listet die Geräte mit
dieser VID:PID und ihre Seriennummern (nur lesend) und sagt, welcher
Bildschirm welches schon benutzt.

**Gleiche Panels brauchen die Seriennummer.** Alle Trofeo-Vision-Panels melden
`0416:5408`. Ohne `serial` weiß Kiosko nur, dass *irgendein* Panel
eingesteckt ist, nie *welches*, und pausiert den Bildschirm erst, wenn **gar
keins** eingesteckt ist. Mit zwei von drei ausgesteckt und ohne Seriennummern
pausiert nichts, mit Absicht: Ein pausierter Bildschirm, dessen Panel doch da
ist, bliebe eingefroren. `kiosko doctor` listet die Seriennummern (auch
`lsusb -v -d 0416:5408 | grep iSerial`).

### Mit dem trcc-Sender (`contrib/usb-sender`)

Jeder Sender steuert ein Panel, nach Seriennummer gewählt, und zeigt das
`frame.jpg` eines Ordners. Gib jedem Bilddatei-Bildschirm die Anwesenheit
*seines* Senders:

- Ohne `wheel` in der Konfiguration der Sender geht beides: `usb` mit der
  `serial` des Senders braucht nichts vom Sender; `heartbeat` merkt auch einen
  Sender, der nicht läuft.
- **Mit `wheel`** (die Panels zeigen abwechselnd alle paar Stunden jeden
  Ordner) wechselt der Ordner eines Panels, seine Seriennummer sagt also
  nicht, welchen Bildschirm es zeigt: nimm nur **`heartbeat`** (`{ "path":
  ".heartbeat" }`). Der Sender berührt den Heartbeat des Ordners, den er
  *jetzt* zeigt, also werden genau die Bildschirme gezeichnet, die ein
  verbundenes Panel gerade zeigt; beim Wechsel wird der Heartbeat des neuen
  Ordners binnen einer Sekunde berührt und sein Bildschirm macht weiter.

Der Heartbeat braucht das aktualisierte `kiosko-sender.py` (es berührt
`.heartbeat`, außer seine Konfiguration sagt `"heartbeat": false`). Ein alter
Sender berührt ihn nie, und der Bildschirm bliebe pausiert: zuerst den Sender
aktualisieren.

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
