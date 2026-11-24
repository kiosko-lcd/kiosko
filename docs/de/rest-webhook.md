# JSON-Widgets und Pushes aus Skripten

Zwei Wege, alles Mögliche aufs Panel zu bringen, ohne ein Plugin zu
schreiben:

- **JSON von einer URL.** Kiosko fragt regelmäßig eine URL ab (eine API, eine
  Statusseite, einen Sensor in deinem Netzwerk) und zeigt einen Wert aus der
  Antwort: groß mit Einheit und Kurve, als Liste oder in einem Satz.
- **Pushes.** Ein Skript, ein Cronjob, deine CI oder Home Assistant schicken
  den Wert mit einem einzigen `curl` an Kiosko, sobald es etwas zu melden
  gibt: das letzte Backup, ein Deployment, die Temperatur im Aquarium.

Beides ist in Kiosko enthalten (Plugin Grundlagen): **JSON-Wert**,
**JSON-Liste**, **JSON-Text** und **Push** findest du in der
Widget-Bibliothek des Editors unter Entwicklung.

## JSON von einer URL

Füge ein **JSON-Wert**-Widget hinzu und fülle aus:

- **URL**: was Kiosko abfragt, z. B.
  `https://api.open-meteo.com/v1/forecast?latitude=40.42&longitude=-3.70&current=temperature_2m`
  (kostenlos, ohne Schlüssel).
- **Pfad zum Wert**: wo der Wert in der Antwort steht, z. B.
  `$.current.temperature_2m`. Lass ihn anfangs leer: Die Kachel listet dann
  die Pfade auf, die sie in der Antwort findet, mit ihren Werten, sodass du
  einen kopieren kannst.
- **Einheit**, **Vor dem Wert** (`$`, `€`), **Nachkommastellen** und eine
  **Beschriftung**.

**JSON-Liste** zeigt mehrere Werte, je einen pro Zeile: Trag die **Felder**
ein (jeweils Beschriftung, Pfad und Einheit) oder gib den Pfad einer Liste in
der Antwort an (**Oder eine Liste darin**, z. B. `$.items`) und, innerhalb
jedes Eintrags, den Pfad seiner Beschriftung und seines Werts (`name`,
`price`). Ein Objekt geht auch als Liste: Jeder Schlüssel ist ein Eintrag mit
`key` und `value`.

**JSON-Text** schreibt einen Satz mit Werten darin:
`Backup {$.status} at {$.finished}`. `{$.items[*].name}` schreibt alle,
durch Kommas getrennt; `{{` und `}}` schreiben geschweifte Klammern.

### Pfade

Ein kleiner Teil von JSONPath, gelesen, ohne Code auszuführen:

| Pfad | Findet |
|---|---|
| `$` | die ganze Antwort (auch reinen Text) |
| `$.current.temperature_2m` | einen Schlüssel, dann noch einen (`$` und der erste Punkt sind optional: `current.temperature_2m`) |
| `items[0].price` | den ersten Eintrag einer Liste |
| `items[-1]` | den letzten (negative Indizes zählen vom Ende) |
| `['key with spaces']` | einen Schlüssel mit Leerzeichen oder Punkten, in Anführungszeichen (`\` maskiert ein Anführungszeichen) |
| `items[*].name`, `prices.*` | jeden Eintrag oder jeden Wert eines Objekts (für Listen und Texte) |
| `items.length` | wie viele Einträge eine Liste hat |

Gelesen werden nur Schlüssel, die wirklich in der Antwort stehen. Ein Pfad
hat höchstens 300 Zeichen und 32 Schritte, und ein Platzhalter sammelt
höchstens 500 Werte.

### Farben nach Wert

**Farben nach Wert** ist eine Liste von Regeln; die erste, die zutrifft, gibt
dem Wert seine Farbe (Grün, Blau, Bernstein, Rot, die Akzentfarbe des Themas
oder Gedämpft):

| Regel | Trifft zu, wenn der Wert … ist |
|---|---|
| `>= 30`, `> 30`, `< 0`, `<= 5` | eine Zahl, verglichen |
| `30` | eine Zahl ab 30 (eine bloße Zahl bedeutet `>=`) |
| `= failed`, `!= ok` | dieser Text (oder nicht), ohne Groß-/Kleinschreibung; oder diese Zahl |

In einem **JSON-Text** legt **Farbe nach** fest, welchen Pfad die Regeln
prüfen (`$.status`); ohne prüfen sie den ganzen Satz.

### Die Kurve

**JSON-Wert** zeichnet den Verlauf seines Werts darunter: einen Punkt pro
Aktualisierung, bis zu **Punkte der Kurve** (standardmäßig 60). Er liegt in
Kioskos Cache (im Speicher), ein Neustart von Kiosko löscht ihn also nicht,
ein Neustart des Computers schon. Stell **Verlaufskurve** auf Keine, um nur
den Wert zu zeigen.

### Schlüssel, Tokens und Header

Trag den Schlüssel oder das Token unter **Geheimnis** ein: Der Editor
maskiert es, und es landet nie im Log. Standardmäßig kommt es unverändert in
den Header `Authorization`, schreib also den ganzen Wert (`Bearer abc123`,
`token abc123`). In den erweiterten Optionen:

- **Header für das Geheimnis**: ein anderer Header (`X-Api-Key`) oder leer.
- `{secret}` in der URL (`…?apikey={secret}`), in einem Header-Wert oder im
  Body setzt es stattdessen dort ein (in der URL URL-kodiert).
- **Weitere Header**, **Methode** (GET oder POST) und **Body (POST)** (als
  JSON gesendet, wenn es danach aussieht).

Wie jedes Geheimnis in Kiosko steht es in der Konfigurationsdatei
(`~/.config/kiosko/config.json` unter Linux), die nur du lesen kannst.

### Aktualisierung, Grenzen und Fehler

- Jedes Widget fragt standardmäßig jede Minute ab; ändern kannst du das mit
  **Aktualisieren alle** am Widget (mindestens 5 Sekunden; denk an die
  Limits der API). Zwei Widgets mit derselben URL im selben Moment teilen
  sich eine Anfrage.
- **Aufgeben nach** (standardmäßig 10 s, bis 60 s) und **Größte Antwort**
  (standardmäßig 512 KB, bis 5 MB): Eine längere Antwort wird abgelehnt.
- Kiosko stellt sich als `kiosko-core Kiosko (+https://kioskolcd.dev)` vor,
  schickt `If-None-Match`/`If-Modified-Since` zurück, wenn der Server ein
  ETag oder ein Datum geliefert hat, und wenn ein Server „zu viele Anfragen“
  meldet (429, `Retry-After`), wartet es so lange wie verlangt.
- Schlägt eine Anfrage fehl, behält das Widget seinen letzten Wert, und der
  Editor nennt den Grund unter den Optionen des Widgets, dort, wo er anzeigt,
  wann die Daten zuletzt aktualisiert wurden (`HTTP 404 from api.example.com`,
  `timed out after 10 s`, `response larger than 524288 bytes`).

Die URL tippst du selbst ein, deshalb führt Kiosko sie unter den Hosts auf,
die die Konfiguration kontaktiert (`kiosko config import` zeigt sie, bevor es
eine Konfiguration von jemand anderem übernimmt).

## Pushes aus Skripten

### Einrichten

Gib unter **Einstellungen → Push** einen Namen ein (Kleinbuchstaben, Ziffern,
`-` und `_`, z. B. `backup`) und klick auf **Hinzufügen**. Kiosko erzeugt
dafür ein zufälliges Token und zeigt URL, Token und ein `curl` zum
Ausprobieren. Dann füg einer Seite ein **Push**-Widget hinzu und wähle diesen
Namen.

```sh
curl -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"value": 42, "text": "Backup finished"}' http://127.0.0.1:7420/api/push/backup
```

**Neues Token** ersetzt es (Skripte mit dem alten werden ab dann
abgewiesen); das Papierkorb-Symbol löscht den Namen.

### Was du schickst

Ein JSON-Objekt; jedes Feld ist optional:

| Feld | Was das Push-Widget damit macht |
|---|---|
| `value` | zeigt ihn groß (eine Zahl oder ein kurzes Wort) |
| `text` (oder `message`) | eine Zeile darunter oder allein, so groß, wie es passt |
| `title` | klein, oben |
| `unit` | hinter dem Wert (oder die eigene **Einheit** des Widgets) |
| `level` | `ok` (Grün), `info` (Blau), `warn` (Bernstein), `alert` (Rot, und die Kachel bleibt so lange auf dem Bildschirm), `critical` (Rot, und ein Vollbild-Alarm auf den Bildschirmen, die Alarme durchlassen) |
| `ttlMs` | wie lange er gilt, in Millisekunden (bis 30 Tage): danach ist das Widget bis zum nächsten Push ausgeblendet |

Reiner Text (`curl -d 'Deploy done' …`) wird als `{"text": "Deploy done"}`
genommen und ein Formular (`-d value=21.5 -d unit=°C`) als Objekt, Zahlen als
Zahlen. JSON wird als JSON gelesen, egal welcher `Content-Type` (ein
einfaches `curl -d` behauptet, es sei ein Formular).

Jedes andere JSON geht auch: Zeig es mit einem **JSON-Wert**, einer
**JSON-Liste** oder einem **JSON-Text**, deren **Oder ein Push-Name** dieser
Name ist, und einem Pfad hinein (`{"temp": 21.4, "humidity": 48}` mit dem
Pfad `$.temp`). Die Kurve des JSON-Werts hat dann einen Punkt pro Push.

### Die Anfrage

| | |
|---|---|
| `POST /api/push/<name>` (oder `PUT`) | der neue Inhalt; antwortet `{"ok": true, "at": …}` |
| `GET /api/push/<name>` | was gerade vorliegt |
| `DELETE /api/push/<name>` | vergisst ihn |
| Token | `Authorization: Bearer <token>` oder `?token=<token>` in der URL |

Antworten: `401` für einen unbekannten Namen oder ein falsches Token
(dieselbe, damit sich Namen nicht erraten lassen), `400` für einen leeren
Body oder kaputtes JSON, das als JSON gesendet wurde, `413` über 64 KB,
`429` über 20 Anfragen am Stück und danach 5 pro Sekunde, je Name (warte,
was `Retry-After` sagt).

Der letzte Inhalt jedes Namens und ein kurzer Verlauf für die Kurve (bis 240
oder 64 KB) liegen im Speicher und in `push.json` neben der
Konfigurationsdatei, sodass ein Neustart eine Kachel, die sich einmal am Tag
ändert, nicht leert.

### Nur auf diesem Computer

Kioskos Editor und API lauschen auf `127.0.0.1:7420`, nur auf diesem
Computer, und Pushes kommen auf demselben Weg herein. Um von woanders zu
pushen:

- **Lass das Skript hier laufen**, wo Kiosko läuft (Cron, ein systemd-Timer,
  ein Git-Hook, ein selbst gehosteter CI-Runner).
- **Oder hol den Port über einen Tunnel**, vom anderen Rechner aus:
  `ssh -N -L 7420:127.0.0.1:7420 you@kiosko-machine`, und push dort an
  `http://127.0.0.1:7420/…`.
- Oder ein kleines Skript hier, das holt, was es braucht, und es pusht.

Öffne den Port dafür nicht für dein Netzwerk (`server.host: 0.0.0.0`): Dann
wäre auch der ganze Editor offen.

### Warum Pushes kein `X-Kiosko: 1` brauchen

Jede andere Anfrage, die etwas ändert, muss den Header `X-Kiosko: 1`
mitschicken: Eine Webseite, die du besuchst, kann ihn nicht an `127.0.0.1`
senden, ohne dass der Browser vorher Kiosko fragt, und Kiosko sagt nie ja –
so kann eine Seite den Editor nicht hinter deinem Rücken steuern (CSRF). Ein
Push bringt sein eigenes Geheimnis mit, das Token, das eine solche Seite
nicht kennen kann; den Header zusätzlich zu verlangen, würde die Skripte nur
länger machen. Ein Push kann nur setzen, was sein Name anzeigt; an die
Konfiguration, die Plugins oder sonst etwas kommt er nicht heran. Die
`Host`-Prüfung gegen DNS-Rebinding gilt weiterhin.

## Rezepte

### Das letzte Backup

Am Ende des Backup-Skripts:

```sh
#!/bin/sh
TOKEN=…   # Einstellungen → Push → backup
if restic backup /home; then
  body='{"title": "Backup", "value": "OK", "text": "'"$(date +%H:%M)"'", "level": "ok", "ttlMs": 129600000}'
else
  body='{"title": "Backup", "value": "FAILED", "level": "alert"}'
fi
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -d "$body" http://127.0.0.1:7420/api/push/backup
```

`ttlMs` von 36 Stunden: Fällt eine Nacht aus, verschwindet die Kachel, statt
„OK“ über ein altes Backup zu sagen.

### Das Deployment

Aus einem Deploy-Skript oder einem selbst gehosteten CI-Runner auf demselben
Rechner:

```sh
curl -fsS -X POST -H "Authorization: Bearer $KIOSKO_TOKEN" \
  -d "{\"title\": \"Deploy\", \"value\": \"#$CI_PIPELINE_ID\", \"text\": \"$CI_COMMIT_REF_NAME passed\", \"level\": \"ok\", \"ttlMs\": 3600000}" \
  http://127.0.0.1:7420/api/push/deploy
```

### Die Temperatur im Aquarium

Ein Sensor, den Cron alle 5 Minuten ausliest (`*/5 * * * *`), angezeigt von
einem **JSON-Wert** mit **Oder ein Push-Name** `aquarium`, Pfad `$.temp`,
Einheit `°C`, Farben `< 23` Blau und `> 27` Rot, und seiner Kurve:

```sh
t=$(cat /sys/bus/w1/devices/28-*/temperature)
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -d "{\"temp\": $(echo "scale=1; $t/1000" | bc)}" \
  http://127.0.0.1:7420/api/push/aquarium
```

### Home Assistant

Mit Home Assistant auf demselben Rechner (oder dem Port über einen Tunnel)
ein `rest_command` in `configuration.yaml`:

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

Ruf es aus einer Automatisierung auf (`action: rest_command.kiosko_doorbell`).
Um die Entitäten von Home Assistant ständig anzuzeigen, ist das Home-Assistant-Plugin
besser geeignet.

### Windows (PowerShell)

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7420/api/push/backup `
  -Headers @{ Authorization = "Bearer <token>" } -ContentType application/json `
  -Body '{"value": "OK", "level": "ok"}'
```
