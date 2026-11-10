# @loksly/weather-astro

Weather, moon phase and sunrise/sunset for small always-on displays. No
dependencies, no API keys, no drawing.

- **Weather** from [Open-Meteo](https://open-meteo.com/) (free, no key): current
  conditions, the next 48 hours and a seven-day forecast, in metric or imperial
  units, with WMO codes mapped to a
  small set of icons. A tiny file cache keeps the last good reading so a network
  outage does not blank your screen.
- **Moon phase**, computed locally (no network), with the eight usual phase names.
- **Sunrise and sunset**, computed locally with NOAA's equation.

Text descriptions are deliberately left out: the library returns codes and
icon kinds, and your app words them in its own language.

## Install

```sh
npm install @loksly/weather-astro
```

Node.js 20 or newer. ESM only.

## Usage

```ts
import { fetchWeather, iconFor, saveWeather, loadWeather, moonPhase, sunTimes } from '@loksly/weather-astro';

const place = { name: 'Madrid', latitude: 40.4168, longitude: -3.7038 };

const w = (await fetchWeather(place, 10_000)) ?? loadWeather('/tmp/weather.json');
if (w) {
  saveWeather('/tmp/weather.json', w);
  console.log(w.temp, iconFor(w.code, w.night)); // 21 'sun-cloud'
}

const moon = moonPhase();          // { phase, illumination, waxing, name: 'waxing-gibbous', daysToFull, daysToNew }
const sun = sunTimes(new Date(), place.latitude, place.longitude); // { rise: 7.9, set: 19.4 } in local decimal hours
```

### API

| Export | What it does |
|---|---|
| `fetchWeather(place, timeoutMs \| { timeoutMs, signal?, units? }, log?)` | Reads Open-Meteo: now, 48 hours (`HOURS_AHEAD`) and 7 days (`FORECAST_DAYS`). `units: 'imperial'` gives °F and mph. Never throws: `null` on failure. |
| `openMeteoUrl(place, units?)` | The address it reads. |
| `parseOpenMeteo(raw, place, now?)` | The parser behind it, for your own fetch. |
| `iconFor(code, night?)` | WMO code → `IconKind` (`sun`, `moon`, `sun-cloud`, `moon-cloud`, `cloud`, `fog`, `drizzle`, `rain`, `snow`, `storm`). |
| `saveWeather(path, w)` / `loadWeather(path, now?)` | Atomic file cache. `loadWeather` drops readings older than `MAX_AGE_MS` (6 h). |
| `moonPhase(at?)` | Phase 0..1, lit fraction, waxing, name and days to the next full and new moon. |
| `sunTimes(date, lat, lon)` | Sunrise and sunset in local decimal hours, or `null` near the poles. |

## Accuracy

The moon model ignores orbital perturbations and can be a few hours off real
ephemerides. Sunrise and sunset are within a couple of minutes at mid latitudes.

## Contributing

This package lives in the [aimonitor](https://github.com/Loksly/aimonitor)
repository under `packages/weather-astro`. Issues and pull requests are
welcome there. Run `npm test` from the package directory.

## License

MIT
