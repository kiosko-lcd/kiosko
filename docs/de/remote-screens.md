# WLAN-Bildschirme (ESP32)

> **Neu, experimentell.** Kiosko steuert auch kleine WLAN-Bildschirme mit
> einem ESP32 und Kioskos eigener, offener Firmware. Sie zeigen einen
> Kiosko-Bildschirm wie jedes Panel, überall im Haus. Diese Anleitung erklärt
> die Benutzung; das Protokoll steht in [remote-screen.md](../remote-screen.md).

Was du bekommst:

- **Er meldet sich selbst.** Kiosko findet ihn in deinem Netzwerk von selbst.
- **Gekoppelt wird mit dem Code auf seinem Bildschirm.** Nur wer davorsteht,
  kann ihn koppeln, und die Verbindung ist verschlüsselt.
- **Er synchronisiert sich selbst.** Wird er abgesteckt oder fällt das WLAN
  aus, verbindet Kiosko ihn wieder und schickt das aktuelle Bild, sobald er
  zurück ist.
- **Jede Ausrichtung**, hochkant oder quer, eingestellt in Kiosko.
- **Mehrere gleichzeitig**, jeder mit eigenem Namen und eigenen Seiten.

## Was du brauchst

- Ein unterstütztes Board. Heute: das **Waveshare ESP32-C6-LCD-1.47**
  (172×320). Weitere folgen; die Firmware hat dafür eine Board-Schicht.
- Ein USB-C-Kabel, um die Firmware einmal zu installieren. Danach gehen
  Updates über das WLAN.
- Ein 2,4-GHz-WLAN, das der Rechner mit Kiosko auch nutzt, mit Multicast
  (mDNS) zwischen beiden.

## Firmware installieren

**Im Browser (am einfachsten).** Öffne den
[Web-Installer](https://kioskolcd.dev/de/flash/) in Chrome oder Edge auf
einem Computer, schließ das Board per USB an, drück *Verbinden und
installieren* und wähl seinen Port. Er schreibt das ganze Image des neuesten
Releases; nichts zu installieren. Weiter mit
[Erster Start und WLAN](#erster-start-und-wlan).

**Fertige Images.** Jedes Kiosko-Release auf
[GitHub](https://github.com/kiosko-lcd/kiosko/releases/latest) enthält, mit
SHA-256:

- `kiosko-screen-<Version>-waveshare-esp32c6-lcd-1.47-full.bin`: den ganzen
  Flash, für ein neues Board per USB. Es löscht, was auf dem Board war.
- `kiosko-screen-<Version>-waveshare-esp32c6-lcd-1.47.bin`: nur die App, für
  Updates aus Kiosko oder von der Einrichtungsseite des Bildschirms.

Zum Schreiben des ganzen Images das Board anschließen und `esptool` in Docker
nutzen (nichts zu installieren):

```sh
docker run --rm -v "$PWD:/w" --device /dev/ttyACM0 espressif/idf:v5.5.5 \
  esptool.py --chip esp32c6 -b 921600 write_flash 0x0 /w/kiosko-screen-0.1.1-waveshare-esp32c6-lcd-1.47-full.bin
```

Nimm den Port, unter dem dein Board erscheint (`ls /dev/serial/by-id/` unter
Linux). Jedes andere `esptool` oder Espressifs Web-Flasher geht auch.

**Selbst bauen.** In [firmware/esp32-screen](../../firmware/esp32-screen)
läuft alles in Docker:

```sh
./idf build           # build/kiosko_screen.bin
./idf flash           # per USB
./idf backup old.bin  # vorher eine Kopie des jetzigen Flash
```

**USB-Rechte unter Linux.** Dein Benutzer muss den seriellen Port öffnen
dürfen. Tritt der Gruppe `dialout` bei, dann ab- und wieder anmelden:

```sh
sudo usermod -aG dialout "$USER"
```

## Erster Start und WLAN

Ohne gespeichertes WLAN, oder wenn er sich nicht innerhalb von 20 s
verbindet, öffnet der Bildschirm ein eigenes Netz, `Kiosko-<Name>-setup`, und
zeigt dessen Passwort an.

1. Verbinde dich mit dem Handy oder Laptop mit diesem Netz.
2. Die Einrichtungsseite öffnet sich selbst; sonst `http://192.168.4.1`.
3. Wähle dein WLAN und gib sein Passwort ein. Hier kannst du dem Bildschirm
   auch einen Namen geben (`a-z`, `0-9`, `-`) und seine Zeitzone.
4. Speichern. Der Bildschirm startet neu und tritt deinem Netz bei. Dann
   zeigt er seinen Namen, seine Adresse und *Noch nicht gekoppelt: in Kiosko
   hinzufügen*.

## In Kiosko hinzufügen

Auf eine dieser Arten:

- **Editor.** *Bildschirme → Bildschirm hinzufügen → Panels erkennen*. Der
  Bildschirm erscheint in der Liste. Klicke ihn an, und er zeigt einen
  6-stelligen Code. Gib ihn im Editor ein. Ein neuer Bildschirm in der Größe
  des Displays entsteht.
- **Einrichtungsassistent.** Der Schritt *Dein Panel* zeigt WLAN-Bildschirme
  neben den USB-Panels, jeweils mit einer Schaltfläche **Koppeln**.
- **Kommandozeile.**
  ```sh
  kiosko remote list
  kiosko remote pair <uid oder Adresse>
  ```
  `pair` fragt nach dem Code auf dem Bildschirm.

Der Code gilt für einen Versuch und 2 Minuten.

## Ausrichtung

Auf der Karte des Bildschirms in Kiosko: *Querformat* oder *Hochformat*, und
*Um 180° drehen*. Kiosko schickt die Seite so, wie du sie im Editor
siehst, und der Bildschirm dreht sie selbst, ohne Aufwand. Steht sie auf dem
Kopf, drücke *Um 180° drehen*. Es gilt Kioskos Einstellung: der Bildschirm bekommt
sie bei jeder Verbindung.

## Helligkeit und Temperatur

Ab Bildschirm-Firmware 0.1.2 hat die Karte des Bildschirms einen Regler für
die **Helligkeit** (0–100 %). Der Bildschirm behält sie, auch ohne Kiosko.
Nicht gesetzt, nimmt er seine eigene: 70 % oder die auf seiner
Einrichtungsseite gewählte. Weniger Helligkeit heißt weniger Wärme.

**Nachtmodus** (Bildschirm-Firmware 0.1.4 oder neuer): auf der Karte
einschalten, die Uhrzeiten wählen (etwa 22:30 bis 07:00) und die Helligkeit
nachts, bis *Licht aus*. Wenn die Nacht endet, kehrt der Bildschirm zu seiner
Helligkeit zurück. Alarme, die den Bildschirm übernehmen, leuchten trotzdem
hell. Und immer wenn Kiosko den Bildschirm schwarz zeigt (aus Home Assistant
ausgeschaltet, oder schlafend, weil auf der Seite nichts zu zeigen ist), geht
auch seine Beleuchtung aus. Nichts davon wird auf dem Bildschirm gespeichert:
Verschwindet Kiosko, leuchtet der Bildschirm wieder.

Die Statuszeile der Karte zeigt auch die **Temperatur des Chips**. Sie liegt
über der Raumtemperatur: etwa 35–45 °C sind für diesen Chip normal.

## Mehrere Bildschirme

Koppel jeden einzeln. Jeder bekommt eigene Karte, Seiten und Ausrichtung. Gib
ihnen auf ihrer Einrichtungsseite Namen (*kueche*, *schreibtisch*), damit du
sie unterscheiden kannst. Kiosko erkennt jeden an seiner eindeutigen ID, also
macht ein neuer Name nichts kaputt. Ihre Hostnamen sind `kiosko-<Name>.local`.

## Die BOOT-Taste

| Drücken | Was passiert |
|---|---|
| Kurz | Erlaubt bei einem gekoppelten Bildschirm 2 Minuten lang eine neue Kopplung (oder bricht eine laufende ab) |
| 5 s halten | Vergisst die Kopplung |
| 10 s halten | Vergisst Kopplung und WLAN und startet in die Einrichtung |

Der Bildschirm zählt die Sekunden mit, während du die Taste hältst.

## Firmware aktualisieren

Bringt dieses Kiosko eine neuere Firmware mit, als der Bildschirm hat, sagt
es seine Karte und bietet **Firmware auf X aktualisieren** an. Erst bei
diesem Klick lädt Kiosko die Firmware aus seinem eigenen Release auf GitHub,
prüft ihre SHA-256 und sendet sie. Ohne Internet (oder ohne GitHub) lade die
Datei von der Release-Seite und nimm *Firmware aktualisieren…*.

Von Hand: *Firmware aktualisieren…* auf der Karte des Bildschirms, dann die App-`.bin`
wählen (nicht die `-full`). Oder auf der Kommandozeile:

```sh
kiosko remote ota <Bildschirm> kiosko-screen-<Version>-waveshare-esp32c6-lcd-1.47.bin
```

Der Bildschirm prüft das Image und startet damit neu. Kommt die neue Firmware
nicht ins WLAN, oder kann Kiosko danach nicht mit ihr sprechen, kehrt der
Bildschirm von selbst zur vorigen zurück.

## Zurücksetzen und entkoppeln

- **In Kiosko:** *Entkoppeln* auf der Karte, oder
  `kiosko remote unpair <Bildschirm>`. Der Bildschirm vergisst dieses Kiosko
  und lässt sich neu koppeln.
- **Am Bildschirm:** BOOT 5 s halten (nur die Kopplung) oder 10 s (Kopplung
  und WLAN).
- **An ein anderes Kiosko geben:** BOOT einmal drücken, dann innerhalb von 2
  Minuten vom anderen Kiosko aus koppeln.

## Fehlersuche

- **Er wird im Netzwerk nicht gefunden.**
  - Prüfe, ob der Bildschirm eine IP-Adresse anzeigt.
  - Rechner und Bildschirm müssen im selben Netz sein, mit erlaubtem
    Multicast (mDNS). Gästenetze, getrennte VLANs und manche Mesh-Systeme
    blockieren das.
  - `kiosko doctor` zeigt, was Kiosko hört.
  - Ausweg: die Adresse des Bildschirms auf seiner Karte eintragen
    (*Adresse*), oder per Adresse koppeln: `kiosko remote pair 192.168.1.50`.
- **„Das ist nicht der Code auf dem Bildschirm“.** Jeder Code gilt einmal.
  Neu beginnen: der Bildschirm zeigt einen neuen.
- **„Zu viele falsche Codes“.** Nach jedem falschen Code wartet der
  Bildschirm länger, bevor er einen neuen Versuch annimmt (5 s, 10 s, 20 s …
  bis 5 Minuten). Warten, dann erneut versuchen.
- **„Schon mit einem anderen Kiosko gekoppelt“.** BOOT einmal am Bildschirm
  drücken, dann innerhalb von 2 Minuten koppeln.
- **„Lehnt den Schlüssel dieses Kiosko ab“.** Der Bildschirm wurde
  zurückgesetzt oder anderswo gekoppelt. *Neu koppeln* auf seiner Karte.
- **Offline.** Der Bildschirm ist abgesteckt oder nicht im WLAN. Kiosko
  verbindet sich wieder, sobald er zurück ist, und füllt das Protokoll
  solange nicht.
- **Langsame Bilder.** Jedes Bild zu dekodieren dauert etwa 60–90 ms, daher
  schaffen lebhafte Animationen etwa 8–10 fps. Ruhige Seiten betrifft das
  nicht.
