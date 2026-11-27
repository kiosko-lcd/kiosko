# Seiten: Wechsel, Anheften und Seiten je nach Kontext

Ein Bildschirm kann mehrere Seiten haben: ein Dashboard, ein Katzenzimmer,
eine Seite zum Spielen. Diese Anleitung erklärt, welche gerade auf dem Panel
ist.

## Wie Seiten wechseln

- **Wechsel.** Die aktiven Seiten wechseln sich ab, jede für ihre eigene
  *Anzeigedauer* (`durationMs`, standardmäßig 10 Minuten), nach der Uhr: zwei
  Kiosko-Rechner mit denselben Seiten zeigen dieselbe.
- **Wann.** Eine Seite erscheint *immer*, nur *in der Arbeitszeit* oder nur
  *außerhalb* (`when`, nach dem Arbeitsplan in den Einstellungen).
- **Angeheftet.** Die Nadel auf der Karte einer Seite hält sie fest
  (`pinnedPage`; Home Assistant und die API können auch eine anheften).
- **Zwischenspiele** laufen ab und zu über der aktuellen Seite, und
  **Alarme** übernehmen das Panel über allem.

## Diese Seite zeigen, wenn…

Eine Seite kann auch **von selbst** erscheinen, solange etwas passiert: ein
Spiel ist offen, du bist in einem Anruf, der Strom ist teuer, es ist
Freitagabend, gleich beginnt ein Termin. Öffne die Seite (ihre Karte
anklicken, dann eine leere Stelle der Bühne) und füge in ihren Einstellungen
unter **Diese Seite zeigen, wenn…** eine Bedingung hinzu:

| Bedingung | Sie trifft zu, solange… |
|---|---|
| **Ein Programm ist offen** | ein Prozess mit diesem Namen läuft. Ein Muster, ohne Groß-/Kleinschreibung: `steam*`, `obs*`, `zoom*`; mehrere durch Kommas getrennt. |
| **Wert einer Quelle** | die Daten einer Quelle an einem Pfad den Vergleich erfüllen, zum Beispiel `calls/active` · `active` · *ist an*; `electricity/pvpc` · `now.price` · *ist größer als* · `0.2`. |
| **Eine Uhrzeit** | die Ortszeit im Zeitfenster liegt, an den gewählten Tagen. `22:00` bis `07:00` geht über Mitternacht. |
| **Ein Widget hier ist dringend** | ein Widget dieser Seite dringend ist (ein Termin beginnt gleich, eine Freigabe wartet). |

Solange eine Bedingung zutrifft, übernimmt die Seite den Bildschirm statt des
Wechsels; trifft keine mehr zu, geht der Wechsel dort weiter, wo die Uhr
steht. Eine Seite mit Bedingungen erscheint **nur**, wenn sie zutreffen, außer
du schaltest *Auch in der Rotation zeigen* ein.

- **Mehrere gleichzeitig.** Jede Bedingung hat eine **Priorität**: die
  höchste gewinnt. Seiten gleicher Priorität wechseln sich ab.
- **Kein Flackern.** Eine Kontextseite bleibt mindestens 20 s, nachdem sie
  erschienen ist, und noch 10 s, nachdem ihre Bedingung nicht mehr zutrifft,
  falls sie wieder zutrifft (ein Spiel startet neu, ein Wert pendelt um die
  Schwelle). Beides gilt je Bildschirm, unter *Gegen Flackern*. Eine Seite
  mit höherer Priorität wartet nie.
- **Was zuerst kommt**: ein Alarm, dann eine angeheftete Seite, dann eine
  Kontextseite, dann der Wechsel. Solange eine Kontextseite läuft, warten
  geplante Zwischenspiele.
- **Warum ist diese Seite da?** Neben den Seiten sagt der Editor, welche
  Seite den Bildschirm hat und warum: *festgelegt durch: Spiel offen
  (steam)*.

Eine Bedingung kann einen **Namen** haben („Spiel offen“): der Editor zeigt
ihn als Grund. In der Konfigurationsdatei kann eine Bedingung mehreres
zugleich prüfen; dann muss alles zutreffen:

```json
"showWhen": [
  { "label": "Spiel offen", "priority": 5, "app": "steam*, *.x86_64" },
  { "label": "im Anruf", "priority": 9, "source": "calls/active", "path": "active" },
  { "time": { "start": "18:00", "end": "23:00", "days": [5, 6] }, "source": "electricity/pvpc", "path": "now.price", "op": "lt", "value": 0.1 }
]
```

Vergleiche (`op`): `truthy` (Standard ohne `value`), `falsy`, `eq` (Standard
mit), `ne`, `gt`, `gte`, `lt`, `lte`, `contains`. Eine Quelle, die noch keine
Daten geschickt hat, oder ein Pfad, den es nicht gibt, trifft nie zu. Die
Quelle läuft, auch wenn kein Widget sie zeigt. Die Abstände des Bildschirms
sind `"context": { "minMs": 20000, "holdMs": 10000 }`.

### Programme auf jedem System

Kiosko schaut alle 3 Sekunden nach den laufenden Programmen, und nur solange
eine Bedingung es braucht, mit dem, was jeder Benutzer lesen darf:

- **Linux**: der Kernel-Name jedes Prozesses (auf 15 Zeichen gekürzt) und der
  Name, mit dem er gestartet wurde (`argv[0]`, der volle Name). Ist `/proc`
  mit `hidepid` eingehängt, sieht man nur die eigenen Prozesse. Spiele unter
  Steams Proton erscheinen meist als ihre `.exe` (`*.exe` erfasst sie alle).
- **macOS**: der Name der ausführbaren Datei und der ihrer App (`zoom.us`,
  `OBS`).
- **Windows**: der Abbildname, mit oder ohne `.exe` (`steam.exe`, `steam`).

Es werden nur Namen gelesen, nie Befehlszeilen. Programme in einem Container
oder auf einem anderen Rechner sieht Kiosko nicht.

### Noch nicht

Ein beginnender Termin, ein Webhook oder ein Bildschirm, der zu streamen
beginnt, sind noch keine eigenen Bedingungen; das dringende Kalender-Widget
oder eine Quelle mit diesem Wert decken einen Teil ab.
