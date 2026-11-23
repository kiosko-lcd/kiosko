# Browser-Bildschirme (Tablets, Handys)

> **Neu, experimentell.** Jeder Browser in deinem Netzwerk kann einen
> Kiosko-Bildschirm im Vollbild zeigen: ein altes Tablet an der Wand, ein
> übriges Handy auf dem Schreibtisch. Keine Hardware zu kaufen, keine
> Firmware: eine Adresse öffnen, einen Code im Editor eingeben, fertig. Für
> kleine WLAN-Bildschirme mit Kioskos eigener Firmware siehe
> [remote-screens.md](remote-screens.md).

Was du bekommst:

- **Koppeln mit einem Code.** Der Browser zeigt einen 6-stelligen Code; du
  gibst ihn im Editor ein. Nur ein Browser, den du gekoppelt hast, bekommt
  Bilder, und die gehen verschlüsselt über das Netz.
- **Er folgt dem Gerät.** Der Bildschirm übernimmt die Größe des
  Browserfensters und dreht sich, wenn sich das Tablet dreht.
- **Er kommt von selbst zurück.** Nachdem das Tablet geschlafen hat, das WLAN
  weg war oder die Seite neu geladen wurde, verbindet er sich ohne neues
  Koppeln und zeigt sofort das aktuelle Bild.
- **Der Editor bleibt privat.** Browser sprechen mit einem zweiten, kleinen
  Server, der nur die Bildschirmseite ausliefert; der Editor lauscht weiterhin
  nur auf diesem Computer.

## Netzwerk-Bildschirme einschalten

Sie sind aus, bis du sie einschaltest. Im Editor unter **Bildschirme**, ganz
unten: **Netzwerk-Bildschirme (Browser)**. Schalte sie ein und wähle:

- **Lauschen auf**: *Das lokale Netzwerk* (alle Schnittstellen, die übliche
  Wahl), *Nur dieser Computer* (für ein Tablet am USB-Kabel, siehe
  [Kabelmodus](#kabelmodus-android-per-usb)) oder eine Adresse dieses
  Computers.
- **Port**: 7429, außer er ist schon belegt.

Die Karte zeigt dann die zu öffnende Adresse (eine pro Netzwerkschnittstelle
dieses Computers) und einen QR-Code dazu.

In der Konfigurationsdatei sieht das so aus:

```json
"networkScreens": { "enabled": true, "host": "0.0.0.0", "port": 7429 }
```

Deine Firewall muss das Tablet zu diesem Port durchlassen (unter Windows
Node.js in privaten Netzwerken erlauben, wenn danach gefragt wird).

## Einen Browser hinzufügen

1. Öffne auf dem Tablet oder Handy die Adresse, die der Editor zeigt, z. B.
   `http://192.168.1.20:7429/` (oder scanne den QR-Code). Die Seite zeigt
   einen großen 6-stelligen Code und darunter, welcher Browser es ist, und 4
   Zeichen seiner ID.
2. Im Editor: **Bildschirme → Bildschirm hinzufügen → Browser (Tablet,
   Handy…)**. Die Browser, die auf das Koppeln warten, werden mit Größe und
   Adresse aufgelistet.
3. Wähle deinen (wartet nur einer, ist er schon gewählt) und gib seinen Code
   ein. Ein falscher Code wird abgelehnt, der Browser zeigt einen neuen, und
   der nächste Versuch muss etwas warten (nach jedem falschen Code länger).
4. Ein neuer Bildschirm erscheint, mit der Größe des Browsers und seiner
   ersten Seite. Bearbeite ihn wie jeden anderen.

Tippe auf die Seite für Vollbild. Halte irgendwo gedrückt (oder tippe in die
obere rechte Ecke) für ihr Menü: Vollbild und Kopplung vergessen.

Um einen Browser mit einem bestehenden statt einem neuen Bildschirm zu
koppeln, nimm **Neu koppeln** auf der Karte dieses Bildschirms.

## Größe und Ausrichtung

Mit **Der Browsergröße folgen** (Standard) übernimmt der Bildschirm die Größe
des Browserfensters in Gerätepixeln (die längere Seite höchstens 1920) und
wechselt zwischen Quer- und Hochformat, wenn das Gerät es tut; seine Seiten
werden dabei neu angeordnet wie bei jedem Panel, das du drehst. Kleine
Änderungen (eine Adressleiste, die kommt und geht) werden ignoriert. Schalte
es aus, um eine selbst gewählte Größe zu behalten: der Browser zeigt das Bild
dann so groß, wie es passt.

## Den Bildschirm wach halten

Browser lassen den Bildschirm ausgehen, außer die Seite bittet sie, es nicht
zu tun. Die Seite tut, was sie kann:

- **Wake Lock**, wo der Browser es erlaubt: nur auf sicheren Seiten (`https`
  oder `http://127.0.0.1`, siehe [Kabelmodus](#kabelmodus-android-per-usb)).
  Eine Seite unter `http://192.168.x.x` gehört nicht dazu.
- Sonst ein **winziges stummes Video**, das ständig läuft und die meisten
  mobilen Browser wach hält. Manche zählen ein stummes Video nicht: dann nimm
  eine der Möglichkeiten unten.

Das Menü der Seite zeigt, was gerade wirkt. Zuverlässiger, egal welcher
Browser:

- Die Einstellung des Geräts selbst: die längste Bildschirm-Zeitüberschreitung;
  unter Android hält *Entwickleroptionen → Aktiv lassen* ihn beim Laden an.
- Eine **Kiosk-Browser-App** (unter Android Apps wie Fully Kiosk Browser; auf
  dem iPad *Geführter Zugriff* mit *Automatische Sperre: Nie*): Vollbild, wach
  gehalten, beim Booten neu gestartet. Richte sie auf die Adresse der Seite.
- Die Seite zum Home-Bildschirm hinzufügen öffnet sie ohne die Leisten des
  Browsers.

## Kabelmodus (Android per USB)

Ein Android-Tablet am USB-Kabel erreicht Kiosko ganz ohne Netzwerk, und zwar
als sichere Seite (Wake Lock funktioniert also):

1. Aktiviere auf dem Tablet *Entwickleroptionen → USB-Debugging*; schließe es
   an und erlaube den Computer.
2. Lass im Editor die Netzwerk-Bildschirme auf **Nur dieser Computer**
   lauschen (`"host": "127.0.0.1"`): nichts ist im Netzwerk erreichbar.
3. Führe auf dem Computer `adb reverse tcp:7429 tcp:7429` aus.
4. Öffne auf dem Tablet `http://127.0.0.1:7429/` und kopple es wie oben.

`adb reverse` hält, bis das Kabel abgezogen wird oder das Tablet neu startet:
dann erneut ausführen (ein kleines Skript oder eine udev-Regel kann das
übernehmen).

## Sicherheit

Was der Server für Netzwerk-Bildschirme jedem in deinem Netzwerk anbietet:

- die Anzeigeseite (ihr HTML, Skript, Stil und Symbol);
- einen WebSocket, über den ein Browser entweder beweist, dass er einen
  Kopplungsschlüssel hat, oder mit einem angezeigten Code auf das Koppeln
  wartet.

Alles andere antwortet mit 404. Es ist ein eigener Server, nicht der des
Editors mit weniger Rechten: er hat keinen Weg zum Editor, seiner API, der
Konfiguration, den Protokollen oder den Plugins, und der Editor lauscht
weiterhin nur auf 127.0.0.1.

Wie Browsern vertraut wird:

- **Koppeln** läuft über SPAKE2 (wie bei den ESP32-Bildschirmen), mit dem
  Code, den der Browser zeigt: jemand muss ihn vom Bildschirm ablesen und im
  Editor eingeben. Ein falscher Code verrät nichts, lässt den Browser einen
  neuen ziehen und den nächsten Versuch warten (5 s, verdoppelt bis zu einer
  Minute).
- **Sitzungen**: bei jeder Verbindung beweisen beide Seiten mit frischen
  Nonces, dass sie den Schlüssel haben; danach wird jede Nachricht mit
  ChaCha20-Poly1305 unter eigens für diese Verbindung erzeugten Schlüsseln
  versiegelt. Ein Browser ohne gültigen Schlüssel bekommt kein Bild; eine
  Nachricht, die sich nicht öffnen lässt, beendet die Sitzung.
- **Grenzen**: 32 Verbindungen gleichzeitig, 4 WebSockets pro Adresse, 8
  wartende Browser, 4 KB pro Nachricht eines Browsers; eine Seite einer
  anderen Website kann den WebSocket nicht öffnen.
- **Widerrufen**: *Widerrufen* auf der Karte des Bildschirms entfernt den
  Schlüssel aus der Konfiguration und sagt dem Browser, ihn zu vergessen; er
  zeigt wieder einen Code. *Kopplung vergessen* im Menü der Seite tut dasselbe
  vom Tablet aus.

Wogegen es nicht schützt:

- Die Seite kommt über einfaches HTTP: wer den Verkehr in deinem lokalen
  Netzwerk manipulieren kann, könnte dem Tablet eine veränderte Seite
  ausliefern. Der Kabelmodus oder ein Netzwerk, dem du vertraust, verhindert
  das.
- Der Kopplungsschlüssel liegt im Speicher des Browsers: wer das Tablet
  entsperrt in der Hand hat, kann ihn kopieren. Widerrufe ein Tablet, das du
  verlierst.
- Jeder in deinem Netzwerk kann die Seite öffnen, und ein Gerät kann sich in
  die Liste der wartenden Browser setzen; das Koppeln braucht trotzdem den
  Code auf *deinem* Tablet. Prüfe Adresse und die 4 Zeichen, bevor du ihn
  eingibst.

## Fehlersuche

- **Die Seite öffnet sich nicht**: steht auf der Karte *An, Port 7429*? Ist
  das Tablet im selben Netzwerk, und lässt die Firewall es durch? Probiere die
  anderen Adressen, die die Karte auflistet.
- **Kein Browser in der Liste**: die Seite muss offen sein und einen Code
  zeigen. Ein Tablet, das mit offener Seite eingeschlafen ist, verschwindet
  nach einer halben Minute aus der Liste; wecke es.
- **Das Bild bleibt stehen, wenn das Tablet schläft**: siehe
  [Den Bildschirm wach halten](#den-bildschirm-wach-halten). Es geht von
  selbst weiter, wenn das Tablet aufwacht.
- **Wieder ein Code, obwohl es lief**: der Bildschirm wurde widerrufen oder in
  Kiosko entfernt, oder der Speicher des Browsers wurde gelöscht. Kopple ihn
  neu.

Die Nachrichten stehen in
[packages/core/src/browser/protocol.ts](../../packages/core/src/browser/protocol.ts):
die des Protokolls für entfernte Bildschirme ([remote-screen.md](../remote-screen.md))
über einen WebSocket, wobei der Browser die Verbindung aufbaut und zuerst
spricht.
