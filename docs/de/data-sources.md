# Datenquellen und Profile

Viele Widgets holen ihre Daten nicht selbst: Sie lesen eine **gemeinsame
Datenquelle** (`plugin/quelle`), die einmal für alle Widgets gelesen wird, die
sie verwenden. Der Nachrichtenstapel (`news/deck`), das Wetter, deine Kalender,
ein Home Assistant: Jedes davon ist eine Datenquelle. Ihre Einstellungen
findest du im Editor unter **Einstellungen → Datenquellen**; jede Zeile zeigt,
wie oft sie gelesen wird und wie der letzte Lesevorgang lief.

Eine Datenquelle läuft nur, solange ein Widget auf einem aktiven Bildschirm sie
verwendet. Quellen, die Alarme auslösen können (Unwetterwarnungen, Erdbeben),
können auch ohne Widget laufen: **Ohne Widget auf Alarme achten**.

## Profile: eine Quelle, mehrere Konfigurationen

Manche Datenquellen haben **Profile**: mehrere benannte Konfigurationen
derselben Quelle, jede mit eigenen Optionen und für sich gelesen. Ein
Bildschirm zeigt allgemeine Nachrichten, ein anderer Technik; eine Kachel dein
dienstliches GitHub-Konto, eine andere dein privates. Jede Quelle sagt, ob sie
Profile hat; Quellen, die etwas Einmaliges auf diesem Rechner lesen (ein Akku,
ein Sensor), haben keine.

- **Einstellungen → Datenquellen**: Eine Quelle mit Profilen zeigt sie als
  Reiter. **Standard** ist die Konfiguration, die alle Widgets lesen, die kein
  anderes wählen. **+ Profil** fügt eines hinzu; jeder Reiter lässt sich
  umbenennen, duplizieren oder löschen (er sagt, wie viele Kacheln ihn lesen;
  diese lesen dann wieder das Standardprofil).
- **In einer Kachel**: Der Inspektor zeigt **Profil der Datenquelle**. Wähle
  eines oder **Neues Profil…**: Das kopiert das Profil, das das Widget gerade
  liest, gibt ihm einen Namen und lässt dich seine Optionen direkt dort ändern
  (**Profil bearbeiten**).

Jedes Profil hat eigene Daten, ein eigenes Intervall und einen eigenen Status:
Im Inspektor eines Widgets heißt die Datenzeile `news/deck#technik`. Die
Optionen eines Profils gelten für alle Kacheln, die es lesen.

### Nachrichten nach Thema

Der Nachrichtenstapel hat Profile: „Allgemein“ mit den Titelseiten, „Technik“
mit den Technikressorts (jede Zeitung hat einen RSS-Feed pro Ressort),
„Sport“… Jedes Profil fasst seine eigenen Meldungen zusammen, „von 4 Medien
gebracht“ zählt also innerhalb des Profils, und ein Feed, der in zwei Profilen
steht, wird nur einmal heruntergeladen.

Auch ohne Profile kann ein Nachrichten-Widget mit **Themen** nur einen Teil der
Meldungen zeigen: Wörter, die in Schlagzeile und Vorspann gesucht werden, durch
Kommas getrennt, mit `!` davor zum Ausschließen (`fußball, bundesliga, !wetten`).
Groß-/Kleinschreibung und Akzente sind egal, und ein Wort passt am Wortanfang
(`ki` findet „KI“, nicht „Wiki“).

## In der Konfigurationsdatei

```json
{
  "sources": { "news/deck": { "feeds": [ { "name": "tagesschau", "url": "https://www.tagesschau.de/index~rss2.xml" } ] } },
  "sourceProfiles": {
    "news/deck": {
      "technik": { "name": "Technik", "options": { "feeds": [ { "name": "heise", "url": "https://www.heise.de/rss/heise-atom.xml" } ] } }
    }
  }
}
```

und im Widget `"profile": "technik"`. `sources["plugin/quelle"]` ist immer
das Standardprofil: Eine Konfiguration ohne `sourceProfiles` funktioniert genau
wie bisher. Ein Widget, dessen Profil es nicht mehr gibt, liest das
Standardprofil, und `kiosko config check` weist darauf hin.

Für Plugin-Autoren: Deklariere `profiles: true` in der Datenquelle (siehe
[Plugins schreiben](../plugins.md#shared-sources)); Widgets brauchen keine
Änderung, sie finden die Daten des Profils in `ctx.sources["plugin/quelle"]`,
und `ctx.profile` sagt der Quelle, welches sie liest.
