# Avisos oficiales (CAP), terremotos y tsunamis en Kiosko: estudio y diseño

Fecha: 2026-11-21. Amplía el punto 27 del [plan](plan.md#pendiente)
(alertas a pantalla completa, ya hecho en el núcleo) y la tarea Z20 del
[estudio de chino](estudio-chino.md) (CWA con alertas a pantalla completa).
Es un estudio: no hay código ni repositorio de plugin todavía.

**Objetivo:** que un aviso oficial de terremoto o de tsunami, y de paso los
avisos meteorológicos, salga a toda pantalla en todos los paneles con el
mecanismo de alertas que ya existe, y que, si el usuario quiere, suene por
los altavoces del ordenador. Sin prometer lo que estos datos no pueden dar.

**Cómo se hizo:** lectura de `docs/plugins.md`, `packages/sdk/src/plugin.ts`
y `packages/core/src/alerts.ts` en `main`; lectura de la norma CAP 1.2 y de
la documentación de cada proveedor; y peticiones reales a cada feed el
2026-11-21 para comprobar que existe, qué formato tiene y qué cabeceras
devuelve. Cada dato lleva su fuente en §11; lo que no se pudo comprobar está
en §10.

---

## 0. Resumen

1. **Ningún feed abierto da la alerta temprana de verdad.** El aviso que
   llega segundos antes de la sacudida (ShakeAlert en EE. UU., 強震即時警報
   en Taiwán, 緊急地震速報 en Japón, ES-Alert en España) va al móvil por
   difusión celular o a socios con contrato. Lo abierto son **informes**
   (1,5–20 min después) y **avisos de tsunami** (2–20 min), que sí llegan
   antes que la ola en costas lejanas. La única excepción abierta es SASMEX
   (México), y aun así por sondeo llega tarde respecto a sus sirenas y su
   radio (§2, §7).
2. **CAP es el idioma común, pero no el único.** Hablan CAP 1.2 el NWS y
   los centros de tsunami de EE. UU., AEMET, Meteoalarm, la CWA a través
   del NCDR y GDACS. SASMEX usa CAP 1.1. Los terremotos de USGS (GeoJSON),
   EMSC (GeoJSON y WebSocket), IGN (GeoRSS) y JMA (su propio XML) no son
   CAP. El diseño convierte todo a un modelo interno con la forma de CAP.
3. **Qué feed para quién:**
   - **España:** IGN para terremotos y AEMET para avisos meteorológicos
     (por RSS, sin clave). EMSC como apoyo rápido. No hay feed abierto de
     tsunamis.
   - **Taiwán:** el NCDR (民生示警), que reparte los CAP de la CWA sin
     clave.
   - **Japón:** el XML de JMA (`eqvol.xml` y `extra.xml`), sin clave.
   - **EE. UU.:** el NWS por punto, tsunami.gov y USGS.
   - **Resto del mundo:** GDACS y EMSC.
4. **Un plugin, `kiosko-plugin-hazards`,** con una sola fuente
   `hazards/alerts` basada en `watch`:
   - Dentro lleva un planificador por feed, con el intervalo que pide cada
     proveedor, y WebSocket donde lo hay (EMSC).
   - Los feeds se eligen de una lista de *presets* propuesta según el sitio
     y el idioma del usuario.
   - Incluye un parser XML pequeño y propio, que rechaza DOCTYPE y entidades
     (sin XXE ni *billion laughs*).
   - Filtra por zona (polígono, círculo, geocódigo o radio) y por tipo de
     suceso.
   - Gestiona el ciclo de vida Update/Cancel con `references`.
   - Trae un widget de «últimos avisos» que dice también cuándo se supo
     algo de cada feed por última vez.
5. **Paso a nivel de Kiosko:**
   - `critical` solo para avisos de tsunami y para avisos CAP
     `Extreme`/`Severe` inmediatos y seguros.
   - Los informes de terremoto, como mucho `warn` por defecto. Ya ha
     temblado: avisar a las 3:00 de algo que ya ha pasado no debe saltarse
     las horas de silencio.
   - Pruebas y simulacros (`status` Test/Exercise) nunca como reales.
6. **El sonido va en el núcleo, no en el plugin:**
   - Un ajuste por instalación, apagado por defecto: desde qué nivel
     (`critical`), volumen, repeticiones y horas de silencio. Se aplica
     igual a una alerta de Home Assistant que a una de CAP.
   - Reproducción sin dependencias nativas: `pw-play`/`paplay`/`aplay` y
     `spd-say`/`espeak-ng` en Linux, `afplay`/`say` en macOS, y PowerShell
     con `SoundPlayer`/`SpeechSynthesizer` en Windows.
   - Tonos generados por el propio Kiosko (sin licencias) y que no imitan
     los oficiales.
   - Las alertas solo **piden** sonido o voz; el usuario manda.
7. **Antes del plugin, dos cambios pequeños en el núcleo:**
   - Hoy una fuente solo corre si algún widget la usa. Un aviso de tsunami
     no debería depender de haber puesto una tesela.
   - La alerta necesita una línea para la fuente y otra para la
     instrucción («Aléjese de la costa»).
8. **Esfuerzo:** núcleo S–M, plugin con feeds CAP M, feeds no CAP M,
   sonido M. En total unas **2–3 semanas** de trabajo, más la revisión de
   los textos por hablantes nativos (§9).

---

## 1. Qué hay ya en Kiosko

- **Alertas** (`Alert` en el SDK, Kiosko 0.2.7):
  - Campos: `id`, `level` (`info|warn|critical`), `title` y `text`
    (`Localized`), `icon`, `expiresAt`/`ttlMs` y `dismissible`.
  - Las devuelve un widget o una fuente (`alerts(ctx)`) a partir de sus
    datos, o llegan desde fuera por `POST /api/alerts`.
  - El núcleo pinta la de más nivel por encima de todo, en todas las
    pantallas. Cada pantalla tiene su nivel mínimo (`alerts.minLevel`) y sus
    horas de silencio (`alerts.quiet`), que solo cruza `critical`.
  - El marco parpadea a 1 Hz como mucho (WCAG 2.3.1).
  - Se descartan con «Visto», «Posponer» o al caducar. «Visto» se recuerda
    por `id`: si el plugin sigue devolviendo el mismo, no vuelve a salir.
  - `title` admite hasta 120 caracteres y `text` 240 (`alerts.ts`).
- **Fuentes** (`defineSource`): hay dos formas.
  - Con `read`, el núcleo la sondea cada `intervalMs`, con un suelo de
    `minIntervalMs` y un `timeoutMs`; el usuario cambia ambos en Ajustes →
    Fuentes de datos.
  - Con `watch`, la fuente es de empuje: llama a `emit` cuando tiene datos
    nuevos.
  - En los dos casos la fuente **solo corre mientras algún widget activo la
    declara**, y su `alerts` solo se pregunta mientras corre.
- **Sitio e idioma:** `ctx.location` (`latitude`, `longitude`, `name`) y
  `ctx.locale`. Las opciones con `risk` (`network`, `path`, `exec`) se
  señalan al importar una configuración ajena. Las `permissions` del
  plugin declaran los hosts.
- **Cliente HTTP** (`createHttp`):
  - Hace GET condicional con ETag y Last-Modified.
  - Respeta `Retry-After` en las respuestas 429 y 503.
  - Envía un User-Agent con el nombre del plugin y de Kiosko, nunca el de la
    persona.
- **Terremotos hoy:** `mirror/earthquakes` pinta los de EMSC en un mapa
  polar, pero no emite alertas.
- **XML sin dependencias:** `kiosko-plugin-news` analiza RSS y Atom con
  expresiones regulares, sin parser XML.

---

## 2. CAP en breve

CAP (Common Alerting Protocol) es la norma de OASIS para avisos públicos.
La versión vigente es la 1.2 (2010), con el espacio de nombres
`urn:oasis:names:tc:emergency:cap:1.2` [1]. La UIT la adoptó como X.1303 y
la OMM la recomienda a sus miembros [3]. Un mensaje tiene tres niveles.

**`<alert>`, el sobre:**
- `identifier`, `sender` y `sent` identifican el mensaje.
- `status`: `Actual`, `Exercise`, `System`, `Test` o `Draft`. Solo
  `Actual` es real.
- `msgType`: `Alert`, `Update`, `Cancel`, `Ack` o `Error`.
- `scope`: `Public`, `Restricted` o `Private`.
- `references`: lista separada por espacios de `sender,identifier,sent` de
  los mensajes anteriores a los que actualiza o cancela.
- `incidents`: agrupa mensajes del mismo suceso.
- Las fechas van con desfase horario. La UTC se escribe `-00:00`, nunca `Z`;
  tsunami.gov manda `2026-11-21T04:32:57-00:00`.

**`<info>`, uno o varios, uno por idioma:**
- `language` (por defecto `en-US`).
- `category`: `Geo` es la de terremotos y tsunamis; `Met` la de los avisos
  meteorológicos.
- `event`: texto libre («Tsunami Warning»). `eventCode` y `parameter` son
  pares nombre/valor que define cada perfil (SAME `EQW`, `CAP-TWP:Event`,
  la magnitud en tsunami.gov).
- `responseType`: `Shelter`, `Evacuate`, `Prepare`, `Execute`, `Avoid`,
  `Monitor`, `Assess`, `AllClear` o `None`.
- Tres ejes de gravedad:

  | Eje | Valores |
  |---|---|
  | `urgency` | `Immediate`, `Expected`, `Future`, `Past`, `Unknown` |
  | `severity` | `Extreme`, `Severe`, `Moderate`, `Minor`, `Unknown` |
  | `certainty` | `Observed`, `Likely`, `Possible`, `Unlikely`, `Unknown` |

- Tiempos: `effective` (por defecto `sent`), `onset` y `expires`. Si falta
  `expires`, decide quien recibe el mensaje.
- Textos: `senderName`, `headline` (unos 160 caracteres), `description`,
  `instruction` y `web`.

**`<area>`, dentro de cada `<info>`:**
- `areaDesc`, obligatorio.
- `polygon`: pares `lat,lon` WGS84 separados por espacios, con al menos 4
  pares y el primero igual al último.
- `circle`: `lat,lon radio` con el radio en km.
- `geocode`: nombre/valor. Por ejemplo UGC o SAME en EE. UU., `EMMA_ID` en
  Meteoalarm o los códigos de condado en Taiwán.
- `altitude` y `ceiling`.
- Varios polígonos, círculos y áreas suman (unión).

**`<resource>`:** adjuntos (mapas, JSON del suceso) con `mimeType`, `uri` y
`digest` opcional.

**Cómo se reparten** [2]:
- La práctica recomendada por OASIS es un índice **Atom** (o RSS 2.0) con
  una entrada por aviso, enlazada al CAP completo con
  `type="application/cap+xml"`.
- Los feeds públicos solo deberían llevar `scope` `Public` y `status`
  `Actual`.
- Cada cambio es un mensaje nuevo, y las entradas caducadas o canceladas
  desaparecen a las 24–48 h.
- El servidor debe admitir GET condicional, y el cliente debe filtrar por
  el CAP en sí, no por la entrada del índice.

**El empuje casi no existe para un programa de escritorio:**
- Meteoalarm anuncia un hub WebSub [12], y GDACS y JMA anuncian otro
  [15][9], pero WebSub necesita una URL pública a la que llamar, y un PC
  detrás de un router no la tiene. El hub que anuncia JMA, además, devuelve
  404 [9].
- El NCDR de Taiwán empuja por correo, HTTPS o MQTT solo con alta y clave
  [7].
- IPAWS-OPEN, el agregador de EE. UU., exige un convenio (MOA) con FEMA [4].
- Hay WebSocket abiertos fuera de CAP: el de EMSC y el no oficial de
  P2PQuake (§3).
- En la práctica, **sondeo** con GET condicional.

Hay un índice de fuentes oficiales: el **Registro de Autoridades de Alerta
de la OMM** (RAA) publica en RSS o Atom 303 autoridades con su país, sus
categorías CAP, su OID, el polígono que cubren y la URL de su feed CAP [3].
No contiene avisos, solo dónde están. Sirve para descubrir feeds, pero cubre
poco lo geológico: de España solo está AEMET, y de México solo CONAGUA-SMN.

---

## 3. Los feeds reales

Comprobados el 2026-11-21 (HTTP 200 salvo donde se dice). **Oficial** quiere
decir que lo publica la autoridad que emite el aviso. **Temprana** quiere
decir que llega antes de la sacudida o la ola.

### 3.1 Tabla

| Feed | URL | Formato | Qué trae | Latencia típica | Cobertura | Licencia | ¿Temprana? |
|---|---|---|---|---|---|---|---|
| **NWS** api.weather.gov [5] | `https://api.weather.gov/alerts/active?point=LAT,LON` | GeoJSON por defecto; Atom con `Accept`; CAP XML solo por aviso (`/alerts/{id}`) | Todos los avisos del NWS, también *Tsunami Warning/Advisory/Watch* | Sin cifra publicada | EE. UU. y territorios | Dominio público [6] | No para terremotos; para tsunamis es el aviso oficial |
| **NTWC** (Alaska) [4b] | `https://www.tsunami.gov/events/xml/PAAQCAP.xml` (y `PAAQAtom.xml`) | CAP 1.2 firmado (XML-DSig), perfil IPAWS | Avisos, alertas, vigilancias y boletines de información de tsunami para EE. UU. y Canadá | Minutos tras el sismo | Costa oeste, Alaska, Atlántico, Golfo, Caribe EE. UU. | NOAA, dominio público | Para tsunami lejano, sí |
| **PTWC** (Hawái) [4b] | `https://www.tsunami.gov/events/xml/PHEBCAP.xml` (y `PHEBAtom.xml`) | Igual | Pacífico, Hawái, internacional | Minutos | Pacífico y Caribe internacional | NOAA | Para tsunami lejano, sí |
| **USGS** [8] | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_hour.geojson` (y `significant_`, `4.5_`, `all_` × `hour/day/week/month`) | GeoJSON, actualizado cada minuto | Terremotos: `mag`, `place`, `time`, `updated`, `alert` (PAGER), `tsunami`, `status`, `ids` | California ≈ 2,5 min; EE. UU. ≈ 8 min; fuera ≈ 20 min [8b] | Mundial (mejor en EE. UU.) | Dominio público [8c] | No (informe) |
| **CWA vía NCDR** (Taiwán) [7] | `https://alerts.ncdr.nat.gov.tw/RssAtomFeeds.ashx` → ficheros `.cap` | Índice Atom + CAP 1.2 (`sender weather@cwa.gov.tw`) | 17 tipos de aviso de muchas agencias: tifón, lluvias, terremoto, tsunami, frío, viento… | Informe de sismo ≈ 5–10 min; tsunami ≈ 20 min [7b] | Taiwán | Atribución (Licencia de Datos Abiertos del Gobierno 1.0, compatible con CC BY 4.0) [7c] | No: la alerta temprana exige convenio con la CWA [7d] |
| **CWA opendata** [7e] | `https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001` (sismo), `E-A0014-001` (tsunami), `W-C0033-*`, `W-C0034-001` | JSON/XML propios, **con clave gratuita** | Lo mismo, más detalle | Igual | Taiwán | Igual | No |
| **JMA** (Japón) [9] | `https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml` (sismos y volcanes) y `extra.xml` (avisos meteorológicos); `_l` = largo | Atom + XML propio de JMA (防災情報XML), no CAP | 震度速報 VXSE51, 震源・震度 VXSE53, 津波警報 VTSE41, 津波情報 VTSE51… | 震度速報 ≈ 1,5 min; 津波警報 ≈ 3 min [9b] | Japón | PDL 1.0 con atribución (compatible con CC BY 4.0) [9c] | No: los 緊急地震速報 no están en el feed público [9d] |
| **P2PQuake** (no oficial) [10] | `https://api.p2pquake.net/v2/history?codes=551&codes=552` y WebSocket | JSON | Reenvía JMA, incluidos 緊急地震速報 | WebSocket en tiempo casi real | Japón | Libre, sin garantía | Lleva EEW, pero su propia especificación desaconseja usarlo como tal [10] |
| **IGN** (España) [11] | `https://www.ign.es/ign/RssTools/sismologia.xml` | GeoRSS (RSS 2.0 + `geo:lat/long`) | Terremotos de los últimos 10 días en España y alrededores | Detección y comunicación ≈ 2 min [11b] | Península, Canarias, Baleares, norte de África | CC BY 4.0 [11c] | No (informe) |
| **AEMET** [12a] | `https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/rss/CAP_AFAE_wah_RSS.xml` (sin clave), o la API OpenData `avisos_cap/ultimoelaborado/area/{area}` con clave gratuita | RSS → ficheros CAP 1.2 | Avisos Meteoalerta (lluvia, viento, costeros, calor…) | Horas de antelación (son previsiones) | España por zonas | Reutilización libre citando «© AEMET» [12b] | Para el tiempo, sí |
| **Meteoalarm** [12] | `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain` (`-portugal`, `-italy`…) | Atom con `cap:` + CAP de cada servicio nacional | Avisos meteorológicos e hidrológicos de 38 servicios europeos; **sin terremotos ni tsunamis** | Igual que el servicio nacional | Europa | «Equivalente a CC BY 4.0» con condiciones adicionales para redistribuir [12] | Para el tiempo, sí |
| **EMSC** [13] | `https://www.seismicportal.eu/fdsnws/event/1/query?format=json&…` y `wss://www.seismicportal.eu/standing_order/websocket` | GeoJSON y WebSocket JSON | Terremotos de todo el mundo, cada alta o revisión | Minutos; LastQuake detecta sismos sentidos en 15–120 s por señales de la gente [13b] | Mundial (fuerte en Europa y el Mediterráneo) | CC BY 4.0, citando EMSC [13c] | No |
| **GDACS** [15] | `https://www.gdacs.org/xml/gdacs_cap.xml` (≈ 5,8 MB) y `rss.xml` | RSS con CAP 1.2 en línea, más un CAP por suceso | Terremotos, ciclones, inundaciones, incendios y sequías, con nivel verde, naranja o rojo según la población expuesta [15b] | Decenas de minutos (sin cifra oficial; espera al ShakeMap) | Mundial | CC BY 4.0; «indicativo, no para tomar decisiones» [15c] | No |
| **SASMEX** (México) [14] | `https://rss.sasmex.net/api/v1/alerts/latest/cap/` | Atom con **CAP 1.1** en línea; solo el último aviso; `expires` = `sent` + 60 s | Alerta sísmica de CIRES (`SAME=EQW`, `urgency Immediate`) | Es alerta temprana, pero por sondeo llega tarde | Centro y sur de México | Sin licencia publicada | Sí en origen; no a través de este feed (§7) |
| **SSN** (México) [14b] | `http://www.ssn.unam.mx/rss/ultimos-sismos.xml` (solo http) | GeoRSS | Últimos sismos | Minutos | México | Sin licencia publicada | No |
| **Chile** [14c] | El CSN y el SHOA no tienen feed abierto encontrado; el SHOA está en el RAA sin URL de CAP | — | — | — | — | — | El SAE es por difusión celular |

### 3.2 Qué feed para quién

| Usuario | Terremotos | Tsunami | Tiempo |
|---|---|---|---|
| **España** | IGN (GeoRSS); EMSC como refuerzo y para lo que pasa fuera | **No hay feed abierto.** El IGN es el Centro Nacional de Alerta de Tsunamis y avisa a Protección Civil [11d], que avisa por ES-Alert (móvil) [11e]. Para tsunamis lejanos, GDACS. | AEMET (RSS CAP sin clave) o Meteoalarm |
| **Taiwán** | NCDR → CAP de la CWA (o CWA opendata con clave) | NCDR → CAP de la CWA (o `E-A0014-001`) | NCDR → CAP de la CWA (tifón 颱風警報, lluvias 豪雨特報) |
| **Japón** | JMA `eqvol.xml` (VXSE51/53) | JMA `eqvol.xml` (VTSE41/51) | JMA `extra.xml` (VPWW54…) |
| **EE. UU.** | USGS | NWS (`point=`) y tsunami.gov | NWS (`point=`) |
| **México** | SSN; SASMEX solo como dato | — (GDACS) | CONAGUA-SMN (en el RAA; no comprobado) |
| **Resto** | EMSC y GDACS | GDACS | Meteoalarm (Europa) o el feed del RAA de su país |

### 3.3 Detalles que condicionan el diseño

- **NWS:**
  - Exige un User-Agent que identifique la aplicación; sin él responde 403.
    No publica límites de peticiones: si se pasa uno, reintentar a los
    pocos segundos [5].
  - El filtro por `point=lat,lon` lo hace el servidor, así que no hace
    falta descargar el país entero.
  - Pedir CAP XML para la colección devuelve GeoJSON. El CAP se pide aviso
    a aviso, pero el GeoJSON ya trae los mismos campos (`severity`,
    `urgency`, `certainty`, `messageType`, `references`), así que basta con
    él.
- **tsunami.gov:**
  - Cada fichero lleva **solo el último producto** del centro, así que el
    plugin tiene que recordar los anteriores.
  - Hoy trae «Tsunami Information» (`severity Minor`, `certainty
    Unlikely`), que son boletines de «no hay amenaza» y no deben salir a
    pantalla.
  - Manda `Last-Modified`.
- **NCDR:**
  - Responde 429 si dos peticiones llegan con menos de **3 s** entre sí
    («限制存取間隔時間為3秒»).
  - Las fechas del índice están en formato local («2026/11/21 下午
    04:30:00»): hay que tomarlas del `.cap`, que viene en CAP 1.2 limpio.
  - El índice usa el espacio de nombres de CAP 1.1 para sus extensiones.
- **JMA:**
  - El feed de alta frecuencia se actualiza cada minuto y guarda al menos
    10 min.
  - JMA bloquea las IP que descargan más de 10 GB al día.
  - No garantiza la entrega: para algo crítico remite a proveedores con
    licencia.
  - Por el 気象業務法, reenviar sus avisos está permitido; hacer avisos
    propios no [9c].
- **USGS:**
  - Las revisiones cambian `updated` (y a veces la magnitud). Un mismo
    sismo puede tener varios `ids` (`,nc75469822,us7000…,`).
  - El indicador `tsunami` no anuncia un tsunami: solo marca un sismo
    oceánico grande. No se usa como aviso.
- **GDACS:**
  - Pesa 5,8 MB, así que hay que sondearlo poco y con GET condicional.
  - Su `cap:sent` llevaba una hora de desfase respecto al suceso, así que
    no sirve para medir latencias.
- **SASMEX:**
  - CAP 1.1, solo el último aviso, caducidad de 60 s.
  - Su área es un círculo en el epicentro probable, no la zona donde se va
    a sentir.

---

## 4. Diseño del plugin

### 4.1 Nombre y forma

**`kiosko-plugin-hazards`** (id `hazards`; «Avisos y terremotos», «Hazard
alerts», «災害示警» / «灾害预警»). Por qué este nombre:

- No es `cap` porque la mitad de los feeds no son CAP (USGS, EMSC, IGN,
  JMA) y el usuario busca «terremotos» o «avisos», no un protocolo.
- No es `alerts` porque las alertas ya son del núcleo y llamarlo así
  confundiría.
- `hazards` es lo que usan GDACS y la OMM («multi-hazard»).

Su forma:

- Repositorio propio, licencia MIT.
- Sin dependencias de ejecución salvo `@kiosko/sdk`.
- `permissions.network` con la lista cerrada de hosts de los *presets*, más
  `user` para la URL propia.

`mirror/earthquakes` se queda como está, porque es un mapa bonito. Cuando
este plugin exista, su texto puede remitir a él para las alertas (pregunta
abierta en §9).

### 4.2 Una fuente, muchos feeds

```
hazards/alerts  (watch)
 ├─ planificador por feed ─ nws ─ tsunami-ntwc ─ tsunami-ptwc ─ usgs ─ ncdr ─ jma-eqvol ─ jma-extra
 │                          ign ─ aemet ─ meteoalarm-<país> ─ gdacs ─ sasmex ─ emsc (WebSocket) ─ cap:<URL propia>
 ├─ adaptadores ───────────── CAP 1.1/1.2 · Atom/RSS de CAP · GeoJSON (USGS, EMSC, NWS) · GeoRSS (IGN, SSN) · JMA XML
 ├─ modelo común (forma CAP) → filtro de zona y suceso → ciclo de vida (references) → estado en dataDir
 └─ emit({ events, feeds: { id: { lastOk, lastError, stale } } })
        └─ alerts(ctx) → Alert[] del núcleo          └─ widget hazards/latest
```

**Una fuente con `watch` y no una fuente por feed con `read`.** Ventajas:

- Cada proveedor tiene su ritmo: 3 s entre peticiones al NCDR, 1 min en
  JMA y USGS, 15 min en GDACS. EMSC es un WebSocket. Con `watch`, el plugin
  lleva un planificador por feed con su propio intervalo y sus esperas.
- Los widgets no tienen que declarar diez fuentes. Si las declarasen, las
  diez correrían a la vez, porque el núcleo arranca toda fuente que un
  widget declare.
- La deduplicación entre feeds es más fácil: el mismo sismo llega por IGN y
  por EMSC.

El coste es que se pierden los controles de intervalo y tiempo máximo de
Ajustes → Fuentes de datos, que solo existen para `read`. Para este plugin
es aceptable: los intervalos los marca el proveedor, no el gusto del
usuario.

**Elegir feeds:**
- Una opción `feeds` (`t.filter` de ids de *preset*). Su valor por defecto
  sale de `ctx.location`: el país se deduce del punto con unos rectángulos
  aproximados por país, sin geocodificador. También influye `ctx.locale`.
  - España: `ign`, `aemet`, `emsc`.
  - Taiwán: `ncdr`.
  - Japón: `jma-eqvol`, `jma-extra`.
  - EE. UU.: `nws`, `tsunami-ntwc`, `tsunami-ptwc`, `usgs`.
  - Resto: `emsc`, `gdacs`.
- Más `customFeeds`, una lista de URL de feeds CAP (Atom, RSS o un CAP
  suelto) con `risk: 'network'`. Para cualquier autoridad del RAA.
- Una ayuda en el formulario enlaza al RAA para encontrar la del país.

### 4.3 Intervalos

| Feed | Intervalo | Notas |
|---|---|---|
| NWS | 60 s | User-Agent con la URL del proyecto, no con datos de la persona; 403/429 → espera |
| tsunami.gov (×2) | 60 s | `If-Modified-Since`; un solo fichero |
| USGS `2.5_hour` o `significant_hour` | 60 s | Se actualiza cada minuto; `max-age=60` |
| NCDR | 60 s el índice; los `.cap` nuevos, de uno en uno, a ≥ 3,5 s | Una cola por host |
| JMA `eqvol.xml` / `extra.xml` | 60 s / 5 min | Solo se bajan los documentos nuevos (VXSE51/53, VTSE41/51, VPWW…) |
| IGN | 2 min | RSS ligero |
| AEMET | 10 min | Avisos con horas de antelación |
| Meteoalarm | 10 min | |
| EMSC | WebSocket con ping cada 15 s; si cae, FDSN cada 2 min y reconexión con espera creciente | |
| GDACS | 15 min | 5,8 MB; GET condicional |
| SASMEX | 30 s | Ver §7: es dato, no alarma |
| CAP propio | 2 min (mínimo 30 s) | |

Todas las peticiones pasan por `createHttp`, que ya hace GET condicional,
respeta `Retry-After` y deja en paz al host. Hay una cola por host para que
dos feeds del mismo proveedor no se pisen. El tiempo máximo por petición es
de 20 s.

### 4.4 XML seguro y sin dependencias pesadas

CAP, Atom, GeoRSS y el XML de JMA son XML. Los riesgos son XXE (entidades
externas que leen ficheros o llaman a la red) y la expansión de entidades
(*billion laughs*) [16]. La propuesta:

- **Un tokenizador propio y pequeño** (≈ 200 líneas, como el de `news`, pero
  de elementos y no de expresiones sueltas). Hace solo esto:
  - Elementos, atributos, texto y CDATA.
  - Las cinco entidades predefinidas y las referencias numéricas.
  - Prefijos de espacio de nombres.
  - Ni DTD, ni entidades declaradas, ni `xinclude`.
- **Rechazar** cualquier documento con `<!DOCTYPE` o `<!ENTITY`. Ni CAP ni
  Atom los necesitan.
- **Límites:**
  - Tamaño: 10 MB, por GDACS; 1 MB por cada CAP.
  - Profundidad: 64 niveles.
  - Elementos: 200 000.
  - Tiempo: lo que dé `timeoutMs`.
- **Sin evaluar nada:**
  - La firma XML-DSig de tsunami.gov se ignora. Verificarla exigiría
    canonicalización XML y sería mucho código para poco; queda como mejora.
  - Los `resource` no se descargan.
- Las alternativas, `fast-xml-parser` o `saxes`, también sirven sin DTD.
  Pero un parser propio con pruebas de ataque es menos superficie y encaja
  con lo que ya hace `news`.

### 4.5 Modelo común

Cada adaptador produce `HazardEvent`, que es CAP aplanado:

```ts
interface HazardEvent {
  key: string;            // sender|identifier
  feed: string;           // id del preset
  sender: string; senderName?: string;
  sent: number; status: 'Actual' | 'Exercise' | 'System' | 'Test' | 'Draft';
  msgType: 'Alert' | 'Update' | 'Cancel';
  references: string[];   // keys
  incident?: string;      // CAP incidents, o el id del sismo (USGS/EMSC/IGN/JMA EventID)
  kind: 'earthquake' | 'tsunami' | 'weather' | 'other';
  event: Localized;       // «Tsunami Warning», «津波警報»…
  headline?: Localized; description?: Localized; instruction?: Localized;
  urgency: string; severity: string; certainty: string;
  onset?: number; expires?: number;
  magnitude?: number; depthKm?: number; epicenter?: [lat: number, lon: number];
  intensity?: { scale: 'JMA' | 'CWA' | 'MMI'; value: string };  // 震度 5弱, 5級, MMI VI
  areas: { desc: Localized; polygons: [number, number][][]; circles: { c: [number, number]; km: number }[]; geocodes: Record<string, string[]> }[];
  web?: string;
}
```

- **Fuera de CAP** se rellenan los mismos campos:
  - USGS, EMSC e IGN dan `kind: 'earthquake'`, `msgType` `Alert` o
    `Update` (según cambie `updated`), `urgency: 'Past'`,
    `certainty: 'Observed'` y una `severity` derivada de la magnitud y la
    distancia (§4.7).
  - El `area` es un círculo alrededor del epicentro. Su radio crece con la
    magnitud, con una regla sencilla documentada: unos 30 km para M3,
    100 km para M5 y 300 km para M7.
- **JMA:**
  - VXSE53 trae el epicentro, la magnitud y el 震度 por zona (`Area/Code`),
    y la zona del usuario se busca en su tabla de códigos.
  - VTSE41 trae el tipo de aviso por tramo de costa: `大津波警報`,
    `津波警報`, `津波注意報` o `津波予報`.

### 4.6 Filtro por zona y por suceso

- **Sitio:** `ctx.location` por defecto, o un sitio propio con
  `locationOptions()` y `placeOf`.
- **Zona:** un aviso CAP afecta al usuario si su punto cae:
  - dentro de un `polygon` (ray casting en lat/lon, suficiente a escala de
    provincia);
  - o dentro de un `circle` (haversine);
  - o en un `geocode` que el usuario eligió.
- **Margen:** la opción `marginKm` amplía la búsqueda unos km alrededor del
  punto, para quien vive en el borde de una zona. Por defecto 0 en avisos
  meteorológicos.
- **Geocódigos** (UGC/SAME en EE. UU., `EMMA_ID`, códigos de condado del
  NCDR):
  - No se pueden resolver sin tablas, así que la opción `zones` es una
    lista con `choices` sacada de los geocódigos vistos en los datos (la
    fuente ya expone listas para el editor).
  - El polígono, cuando viene, manda.
  - El NWS se filtra en el servidor (`point=`).
- **Terremotos:** `radiusKm` (por defecto 300) y `minMagnitude` (por
  defecto 4).
  - Fuera del radio, un sismo solo cuenta si GDACS o PAGER lo marcan
    naranja o rojo, y entonces es `info` (§4.7).
  - En Japón y Taiwán, si hay intensidad en la zona del usuario, manda la
    intensidad, no la distancia.
- **Tsunami:** cuenta el área del aviso (el tramo de costa). Sin
  polígono (tsunami.gov, que trae un círculo de radio 0 en el epicentro),
  se usan sus geocódigos o, si no los hay, cualquier aviso de nivel Warning
  de un centro que cubra el país del usuario.
- **Suceso:** `kinds` es un `t.filter` con terremoto, tsunami, tiempo y
  otros. Por defecto los tres primeros. Una opción `events` permite afinar
  por texto de `event` («Wind», «Heat»…).
- **Estado:**
  - `status` distinto de `Actual` no sale salvo `includeTests: true`, y
    entonces sale como `info` y con «PRUEBA» delante (§7.4).
  - `scope` distinto de `Public` se ignora.
  - `System` nunca sale.

### 4.7 Del aviso al nivel de Kiosko

Reglas en orden; la primera que se cumple decide.

| # | Condición | Nivel |
|---|---|---|
| 1 | `status` ≠ `Actual` | `info` con «PRUEBA», o nada (por defecto, nada) |
| 2 | `msgType` `Cancel`, o `responseType` `AllClear` | Se quita el aviso al que se refiere; un `info` breve «Fin del aviso» durante 2 min |
| 3 | Tsunami: Warning del NWS o tsunami.gov, 大津波警報 / 津波警報 de JMA, 海嘯警報 de la CWA | **`critical`** |
| 4 | Tsunami: Advisory o Watch, 津波注意報 | `warn` |
| 5 | Tsunami: Information Statement, 津波予報, «sin amenaza» (`severity Minor`, `certainty Unlikely`) | Solo en la tesela |
| 6 | `severity` `Extreme`, `urgency` `Immediate` o `Expected`, `certainty` `Observed` o `Likely` | **`critical`** |
| 7 | `severity` `Severe` con la misma urgencia y certeza | `critical` si el usuario sube `maxWeatherLevel`; si no, `warn` |
| 8 | `severity` `Extreme` o `Severe` con otra urgencia o certeza (Future, Possible) | `warn` |
| 9 | `severity` `Moderate` | `info` |
| 10 | `Minor`, `Unknown`, `urgency` `Past` | Solo en la tesela |
| 11 | Informe de terremoto dentro del radio y ≥ `minMagnitude`; o con intensidad en tu zona: JMA 震度 ≥ 4, CWA ≥ 4 級 o MMI ≥ V | `warn` (tope configurable: `maxQuakeLevel`, por defecto `warn`) |
| 12 | Informe de terremoto lejano con PAGER o GDACS naranja o rojo | `info` |

- **Meteoalarm y AEMET** traen además su color (`awareness_level`:
  amarillo, naranja o rojo) en `parameter`. Cuando viene, manda el color:
  rojo es `critical`, naranja `warn` y amarillo `info`, con el tope de
  `maxWeatherLevel` (por defecto `warn`).
- **Por qué los informes de terremoto se quedan en `warn`:** el usuario ya
  lo ha sentido o no le afecta. A las 3:00, con horas de silencio, un
  `critical` despertaría el panel para contar algo que ya ha pasado. El
  aviso de tsunami sí es `critical`, porque es lo único de esta lista que
  llega antes que el peligro.
- El usuario ajusta los dos topes (`maxQuakeLevel` y `maxWeatherLevel`).
  Lo que no puede hacer es subir una prueba a real.

### 4.8 Duplicados, actualizaciones y cancelaciones

- **Clave de un mensaje:** `sender|identifier`. Los `references` dan las
  claves anteriores.
- **Cadenas:** el plugin agrupa los mensajes en cadenas. Una cadena es un
  aviso raíz más sus Update.
  - Un Update sustituye al mensaje al que se refiere, con su nuevo texto,
    nivel y caducidad.
  - Un Cancel cierra la cadena.
  - Si falta el mensaje referido (el plugin arrancó después), el Update se
    toma como raíz.
- **El `id` de la alerta de Kiosko es `raíz:nivel`:**
  - Si un Update solo cambia el texto, el `id` es el mismo y «Visto» se
    respeta.
  - Si **sube** de nivel (de Watch a Warning), el `id` es nuevo y vuelve a
    salir aunque el usuario ya lo hubiera visto.
  - Si baja de nivel, se conserva el «Visto» del nivel mayor: el `id` nuevo
    nace visto.
- **Terremotos:**
  - La raíz es el id del sismo: `ids` de USGS, `unid` de EMSC, `evid` de
    IGN y `EventID` de JMA.
  - Entre fuentes, dos informes son el mismo sismo si coinciden en menos de
    60 s, menos de 50 km y menos de 0,5 de magnitud. Gana el oficial del
    país del usuario (IGN en España, JMA en Japón, CWA en Taiwán) y si no,
    el primero en llegar.
- **Feeds que solo traen el último mensaje** (tsunami.gov, SASMEX): que el
  mensaje desaparezca del feed no cierra el aviso. Solo lo cierran
  `expires`, un Cancel o un mensaje nuevo que lo sustituya.
- **Feeds de activos** (NWS `/alerts/active`, NCDR, Meteoalarm): según
  OASIS, lo que desaparece ha caducado o se ha cancelado. Se cierra tras
  dos lecturas seguidas sin él, para no cerrar avisos por un fallo pasajero
  del feed.
- **Estado persistente** en `dataDir/state.json`: las cadenas abiertas y las
  claves vistas de las últimas 48 h. Al reiniciar Kiosko no vuelven a salir
  avisos viejos y siguen saliendo los que siguen vigentes.

### 4.9 Caducidad

- `expiresAt` = `expires` del CAP.
- Si falta `expires`, se aplica una política por tipo, documentada en el
  README:

  | Tipo | Caduca a las |
  |---|---|
  | Informe de terremoto | 30 min (el tope lo pone `quakeTtlMs`) |
  | Tsunami | 6 h, o hasta el Cancel |
  | Tiempo | 12 h |

- SASMEX caduca a los 60 s.
- En la tesela, lo caducado se queda 24 h en gris como historial.

### 4.10 Idiomas

- **CAP:** de los varios `<info>` (uno por `language`) se construye un
  `Localized` con todos:

  | CAP | Kiosko |
  |---|---|
  | `en-US` | `en` |
  | `es-ES` | `es` |
  | `zh-TW` | `zh-Hant` |
  | `zh-CN` | `zh-Hans` |
  | `ja-JP` | `ja` |

  El núcleo ya escoge el idioma del usuario. Si no hay `<info>` en ese
  idioma, se usa inglés y después el primero que haya.
- **Lo que pone el plugin:** etiquetas («Aviso de tsunami», «Terremoto»,
  «Fuente: IGN», «hace 4 min») en los idiomas del plugin: `en`, `es`,
  `zh-Hant`, `zh-Hans`, `ja` y `de`.
  - El texto del aviso **no se traduce**: va tal cual lo emitió la
    autoridad. Traducir con máquina un aviso oficial puede cambiar lo que
    dice (AEMET y JMA piden no alterar el sentido) [12b][9c].
  - `event` se traduce solo cuando es un valor conocido de una lista
    cerrada: los *event types* del NWS, los nombres de producto de JMA y
    los de Meteoalarm.

### 4.11 Lo que enseña la alerta a pantalla completa

El panel es una barra de 1920×462: caben un título enorme y una línea.

| Tipo | `title` | `text` | `icon` |
|---|---|---|---|
| Tsunami | `headline`, o «Aviso de tsunami · Costa de Cádiz» | `instruction` si cabe («Aléjese de la costa y suba a zonas altas»); si no, «NTWC · 14:05 · M7,8 frente a Portugal» | `waves` |
| Terremoto | «Terremoto M5,2 · 35 km al SO» | «Alborán Sur · 14:05 (hace 3 min) · IGN» | `activity`, o `震` si el idioma es CJK |
| Tiempo | `headline`, o el `event` con la zona | «Hasta 22:00 · AEMET» | `wind`, `cloud-lightning`, `droplet`, `thermometer`, `waves` (costeros) |

La fuente va **siempre**: lo pide la licencia de AEMET, IGN, CWA, JMA, EMSC y
GDACS, y además dice al usuario de dónde viene. En los informes, la hora del
suceso va con su antigüedad («hace 3 min»).

Hoy la alerta solo tiene `title` y `text`, y en un aviso de tsunami
caben a la vez la fuente y la instrucción. Hay dos caminos:

1. Que el plugin elija una de las dos. Para tsunami gana la instrucción, y
   la fuente se queda en la tesela.
2. **(Propuesto)** Dos campos opcionales más en `Alert`, que el núcleo pinta
   en pequeño cuando cabe y que también usan la API y Home Assistant:
   - `source` (`Localized`): «AEMET», «气象署», «NWS».
   - `detail` (`Localized`): una segunda línea, como la instrucción.

La nota «no es un sistema de avisos oficial» no va en la alerta, porque
quitaría sitio a lo importante. Va en la tesela, en la ficha del plugin,
en el formulario y en el README (§7.2).

### 4.12 Opciones

En las opciones de la fuente (Ajustes → Fuentes de datos):

| Opción | Tipo | Defecto | `risk` |
|---|---|---|---|
| `feeds` | `t.filter` de *presets* | según sitio e idioma | — (hosts fijos, en `permissions`) |
| `customFeeds` | lista de `t.string({ format: 'url' })` | vacío | `network` |
| `kinds` | `t.filter` (terremoto, tsunami, tiempo, otros) | los tres primeros | — |
| `events` | `t.filter` de textos de `event` | todos | — |
| `zones` | `t.filter` con `choices` de los geocódigos vistos | — (manda el punto) | — |
| `marginKm` | entero km | 0 | — |
| `radiusKm` | entero km | 300 | — |
| `minMagnitude` | número | 4,0 | — |
| `maxQuakeLevel` | `info`/`warn`/`critical` | `warn` | — |
| `maxWeatherLevel` | `info`/`warn`/`critical` | `warn` | — |
| `includeTests` | booleano | `false` | — |
| `staleMs` | duración | 15 min | — |
| `cwaKey` (avanzada) | `secret` | vacío; solo si se quiere CWA opendata en vez de NCDR | — |
| `aemetKey` (avanzada) | `secret` | vacío; el RSS no la necesita | — |
| `latitude`, `longitude`, `placeName` (avanzadas) | `locationOptions()` | 0,0 = Ajustes | — |

En el manifiesto:

```js
permissions: {
  network: [
    'api.weather.gov', 'www.tsunami.gov', 'earthquake.usgs.gov',
    'alerts.ncdr.nat.gov.tw', 'opendata.cwa.gov.tw', 'www.data.jma.go.jp',
    'www.ign.es', 'www.aemet.es', 'opendata.aemet.es', 'feeds.meteoalarm.org',
    'www.seismicportal.eu', 'www.gdacs.org', 'rss.sasmex.net', 'www.ssn.unam.mx',
    'user',
  ],
},
```

No necesita `exec` ni `devices`: el sonido es del núcleo (§5).

### 4.13 Widget `hazards/latest`

- **Qué pinta:** una lista (`listOptions`) de los avisos activos y los
  sismos de las últimas 24 h, el más grave arriba. Cada fila lleva un
  icono, el título, la zona, la hora o antigüedad (`ctx.fmt.ago`) y la
  fuente.
- **Sin avisos:** «Sin avisos para Madrid» y debajo «Datos: IGN, AEMET ·
  hace 1 min». Nunca un «Todo en calma» a secas.
- **Si un feed lleva más de `staleMs` sin responder:** «IGN sin datos desde
  14:05» en `warn`, y el widget pasa a `urgent` para que se vea (§7.3).
- **Pie fijo y pequeño:** «Informativo · no sustituye a los avisos
  oficiales».
- Un `t.filter` `kinds` propio de la tesela, por si se quiere una tesela
  solo de sismos.
- `empty` y `hideWhenEmpty` como en todos.
- Tamaños: preferido 640×462, mínimo 320×154.
- Las alertas a pantalla completa las da la **fuente**, no el widget: así
  dos teselas no duplican y la alerta no depende de en qué página está la
  tesela.

### 4.14 Datos de ejemplo, pruebas y simulacro

- **`demo`:** un aviso de tiempo naranja, un sismo M4,3 de hace 12 min y un
  feed caído, en el idioma de la vista previa. En modo demo el núcleo no
  pide alertas, como ya hace con todas.
- **Fixtures reales** en `test/fixtures/`, guardados de los feeds (con sus
  fechas y la fuente en un README):
  - NWS: un GeoJSON con *Tsunami Warning* (del archivo de `/alerts` o de
    la documentación del NWS) y uno de viento.
  - tsunami.gov: `PAAQCAP.xml` de «Tsunami Information» y uno de Warning
    sacado de los ejemplos de su página de CAP.
  - NCDR: un `.cap` de la CWA de frío, uno de tifón y, en cuanto lo haya,
    uno de sismo y uno de tsunami (§10).
  - JMA: VXSE51, VXSE53 y VTSE41. JMA publica mensajes de ejemplo de cada
    tipo.
  - USGS (`all_hour`), EMSC (FDSN y un mensaje de WebSocket), IGN RSS.
  - AEMET: un CAP de Meteoalerta.
  - Meteoalarm: una entrada.
  - GDACS: un ítem recortado.
  - SASMEX: CAP 1.1.
- **Pruebas:**
  - Cada adaptador frente a su fixture.
  - Punto en polígono, círculo y bordes. El antimeridiano en el Pacífico,
    para PTWC.
  - Elección de idioma.
  - Cadena Alert → Update (mismo nivel: mismo `id`; sube: `id` nuevo) →
    Cancel.
  - Un feed «solo el último» que deja de traer el aviso y uno de «activos»
    que lo deja de traer.
  - Duplicados IGN/EMSC.
  - Caducidad sin `expires`.
  - `status` Test.
  - Tabla de niveles de §4.7 completa.
  - **Ataques:** *billion laughs*, XXE con `file:///etc/passwd`, un
    documento de 50 MB y otro con 10 000 niveles de anidamiento. Todos se
    rechazan sin colgarse.
  - `widgetAlerts` de `@kiosko/sdk/testing` para la fuente, o su
    equivalente de fuentes, si no existe (§8, F0).
- **Simulacro, «Probar un aviso»:**
  1. Para ver cómo se pinta en cada pantalla basta con
     `POST /api/screens/<id>/test-alert`, que ya existe.
  2. **Para probar la cadena entera** (parser, zona, nivel, sonido), un
     feed `test` en los *presets* que lee un CAP de ejemplo empaquetado
     con el plugin. El ejemplo es un tsunami en la zona del usuario, con
     `status` `Test`, y lo trae `includeTests` solo durante 60 s.
     - Sale como `critical` con «PRUEBA ·» delante del título, y caduca
       solo.
     - Se dispara desde la línea de órdenes: `kiosko hazards test`, si los
       plugins pueden añadir órdenes, o con una petición a la API.
       Pregunta abierta.
  3. Para quien quiera probar su propio CAP: `customFeeds` acepta
     `file://` (con `risk: ['network', 'path']`) y se le pasa un fichero
     del simulacro.

---

## 5. Sonido por los altavoces (opcional)

### 5.1 ¿Plugin o núcleo? Núcleo

- **Es de la instalación, no del aviso.** El ordenador suena una vez, no
  una por plugin. El ajuste («desde qué nivel suena», volumen, horas de
  silencio) debe valer igual para una alerta de humo de Home Assistant, una
  de `POST /api/alerts` o un tsunami.
- **Se apaga desde el mismo sitio:** «Visto» y «Posponer» de la banda del
  editor, Home Assistant y la API ya existen en el núcleo. Si el sonido
  fuera del plugin, el plugin no sabría cuándo callarse.
- **Permisos:** reproducir sonido es lanzar un programa (`exec`). Mejor un
  sitio revisado que cada plugin con sus `spawn`.

**Propuesta para el SDK.** `Alert` gana un campo opcional `sound`, una
petición que el núcleo atiende según los ajustes del usuario:

```ts
sound?: 'chime' | 'alarm' | { speak: Localized } | { tone: 'chime' | 'alarm'; speak: Localized };
```

**Ajustes → Alertas → Sonido**, por instalación:

| Ajuste | Defecto |
|---|---|
| Activado | **No** |
| Desde nivel | `critical` |
| Volumen | 70 %, aplicado al generar el WAV (igual en todos los sistemas) |
| Voz | Sí, si la alerta lo pide y hay voz para el idioma; si no, solo tono |
| Repetir | Cada 2 min mientras siga activa y sin «Visto», como mucho 3 veces |
| Horas de silencio | Las suyas, y por defecto solo `critical` las cruza; un interruptor «ni siquiera `critical`» |
| Probar | Un botón «Probar sonido» y la casilla «con sonido» en «Probar alerta» |

- Una alerta sin `sound` suena con el tono de su nivel si el usuario
  activó «sonar todas desde el nivel X». Así las de Home Assistant suenan
  sin cambiar nada.
- `POST /api/alerts` acepta `sound` igual.

### 5.2 Cómo suena en cada sistema, sin dependencias nativas

El núcleo escribe un WAV (PCM 16 bits, mono, 22 050 Hz) en su `cacheDir` y
lanza el primer reproductor que encuentra con `child_process.spawn`. Lo
lanza sin shell, con argumentos en lista y un límite de 30 s. Las pruebas
con `kiosko doctor` dicen cuál ha encontrado.

| Sistema | Tono (WAV) | Voz | Notas |
|---|---|---|---|
| Linux | `pw-play` (PipeWire) [17] → `paplay` (PulseAudio) [18] → `aplay` (ALSA) [19] | `spd-say -l es -w` (speech-dispatcher) [20] → `espeak-ng -v es` [21] | El servicio es de usuario (`systemd --user`), así que tiene la sesión de sonido. Sin sesión abierta (linger) puede no haber servidor de audio, y `doctor` lo dice. |
| macOS | `afplay` [22] | `say -v <voz>` [23], con la voz elegida por idioma (`say -v '?'` las lista) | El LaunchAgent corre en la sesión del usuario |
| Windows | `powershell -NoProfile -NonInteractive -Command` con `(New-Object System.Media.SoundPlayer $f).PlaySync()` [24] | `Add-Type -AssemblyName System.Speech` y `SpeechSynthesizer` (`SelectVoiceByHints` con la cultura, `.Speak`) [25] | La tarea programada arranca al iniciar sesión, así que hay audio. Sin ventana (`windowsHide`). PowerShell 5.1 viene en todos los Windows; en PowerShell 7, `System.Speech` también sirve en Windows. |

- **Texto que se lee:** el título y la `detail`, si la hay, en el idioma de
  la alerta. Va como argumento, nunca dentro de una cadena de shell. En
  PowerShell se pasa por una variable de entorno, para no tener que
  escapar comillas.
- **Si no hay voz para el idioma:** solo tono. No se lee chino con una voz
  inglesa.
- **Si falla un reproductor,** se prueba el siguiente. Si fallan todos, el
  editor lo avisa una vez («No se ha podido reproducir sonido: instala
  pipewire-utils o alsa-utils»).

### 5.3 Sonidos limpios de licencia

- **Generados por el código,** sin ficheros de terceros: dos o tres tonos
  sinusoidales con envolvente, «chime» (dos notas que bajan) y «alarm»
  (tres pulsos). Se escriben en unas decenas de líneas y no hay licencia
  que vigilar.
- **No imitar señales oficiales:**
  - La señal de atención del EAS de EE. UU. (853 + 960 Hz): la FCC prohíbe
    transmitirla fuera de una alerta real o de una prueba autorizada [26].
    Un PC no es una emisora, pero imitarla confunde.
  - La sintonía de los 緊急地震速報 de NHK.
  - El tono de ES-Alert o de los WEA del móvil.
- Que nadie confunda el PC con su móvil oficial.

### 5.4 Accesibilidad y molestia

- **Para quién es:** quien no mira el panel, o no puede verlo. Por eso
  existe la voz. La voz repite el título, que ya está en pantalla.
- **WCAG 1.4.2 (Control del audio):** el sonido de más de 3 s debe poder
  pararse [27]. Aquí «Visto» y «Posponer» lo paran en el momento, y cada
  reproducción dura menos de 10 s.
- **Molestia:**
  - Solo `critical` por defecto.
  - Tres repeticiones como mucho.
  - Nunca en las pruebas salvo que se pida.
  - Una alerta que sube de nivel suena una vez más.
  - Los informes de terremoto (`warn`) no suenan con los ajustes por
    defecto.

---

## 6. Por qué no esperar a la alerta temprana

| Sistema | Qué es | ¿Abierto? |
|---|---|---|
| ShakeAlert (USGS, costa oeste) | Alerta temprana de sismo | No: la reparten WEA (FEMA), apps y socios con licencia [8d] |
| 強震即時警報 (CWA) | Alerta temprana, 10–15 s tras el sismo [7b] | No: gratis, pero con convenio firmado; usarlo sin él no está autorizado [7d] |
| 緊急地震速報 (JMA) | Alerta temprana | No está en el feed XML público [9d]; solo por proveedores con licencia |
| ES-Alert (España) | Difusión celular desde 2023 (todos los avisos) | No: solo al móvil [11e] |
| SAE (Chile) | Difusión celular | No [14c] |
| SASMEX (México) | Alerta sísmica | Sí hay feed CAP, pero con solo el último aviso y caducidad de 60 s. Por sondeo llega tarde respecto a sus sirenas y su radio [14] |

Pedir un convenio a la CWA o a un proveedor japonés queda fuera de un
proyecto personal de código abierto, que además tendría que dar
garantías que no puede dar (§7.1). Lo honesto es **no intentarlo** y
decirlo.

---

## 7. Honestidad y seguridad

### 7.1 Lo que los datos pueden y no pueden

- **Informes de terremoto (IGN, USGS, EMSC, CWA, JMA 震源・震度):** «qué ha
  pasado y dónde», minutos después. Útiles para saber si lo que ha
  temblado era cerca o lejos y cuánto ha sido. No sirven para protegerse
  del sismo.
- **Avisos de tsunami (NWS, tsunami.gov, JMA, CWA):** llegan en 2–20 min.
  Para un tsunami de origen lejano (Chile → Japón, Portugal → Canarias),
  eso es antes de la ola. Para uno de origen cercano puede no serlo. La
  instrucción oficial es la misma en todas partes: si tiembla fuerte en la
  costa, vete a un sitio alto sin esperar al aviso.
- **Avisos meteorológicos:** horas de antelación. Es donde más luce el
  plugin.
- **Kiosko añade su propia demora:**
  - El intervalo de sondeo (hasta 1–2 min).
  - Lo que tarde el PC en despertar, si estaba suspendido.
  - Que el PC esté encendido y Kiosko funcionando.

### 7.2 Cómo hablar de ello

| Decir | No decir |
|---|---|
| «Avisos oficiales publicados por AEMET / NWS / CWA, en tu panel» | «Alerta temprana», «te avisa antes del terremoto» |
| «Informe de terremoto: ha ocurrido hace 3 min» | «Alerta de terremoto» (para un informe) |
| «Informativo. No sustituye a los avisos oficiales (ES-Alert, el móvil, radio y TV)» | «Sistema de alertas», «para tu seguridad», «salva vidas» |
| «Puede llegar minutos después» | «En tiempo real» (salvo EMSC por WebSocket, y aun así matizado) |
| «Fuente: IGN · datos de hace 1 min» | Un «Todo tranquilo» sin fuente ni hora |

- El README y la ficha del plugin llevan un párrafo fijo con esto, y la
  ficha además la tabla de latencias de §3.1.
- La web de Kiosko no lo anuncia como «alertas de terremoto». Lo anuncia
  como «avisos oficiales y terremotos recientes».

### 7.3 Si el feed cae

- **Por cada feed** se guardan `lastOk`, `lastError` y la hora del último
  mensaje.
- **Pasado `staleMs`:**
  - La tesela lo dice en `warn` («IGN sin datos desde 14:05») y se queda
    la tesela (`urgent`).
  - No sale a pantalla completa, porque un feed caído no es una emergencia.
    Una opción del núcleo podría permitirlo: pregunta abierta.
- **Que el feed no responda no es «sin avisos».** Sin datos recientes no
  se pinta «Sin avisos para Madrid», sino «Sin datos de avisos».
- Los avisos abiertos siguen hasta su `expires`, aunque el feed esté
  caído.
- Si cae el WebSocket de EMSC, se pasa a sondeo y se dice («EMSC: sondeo
  cada 2 min»).

### 7.4 Falsas alarmas

- **Pruebas y simulacros:**
  - `status` `Test`, `Exercise`, `Draft` y `System` nunca se pintan como
    reales.
  - Con `includeTests`, salen como `info` y con «PRUEBA» o «SIMULACRO»
    delante.
  - Los simulacros nacionales (ShakeOut, 防災の日, el ES-Alert de prueba)
    se publican a veces como `Exercise`. A veces ni se publican.
- **Errores del emisor:** si una autoridad manda un `Actual` por error
  (Hawái, 2018 [28]), Kiosko lo pinta, como el móvil. El plugin no puede
  saberlo; la corrección llega como Update o Cancel y el plugin la sigue
  (§4.8).
- **Revisiones:** un informe automático que se corrige (de M5,1 a M4,6, o
  borrado en USGS) se actualiza y, si queda por debajo de los umbrales, se
  retira.
- **Fallos propios:** un parser que lee mal una zona y avisa a medio país.
  Lo cubren las pruebas con fixtures reales, y además un aviso sin zona
  legible nunca sale a pantalla completa; solo a la tesela.

### 7.5 Responsabilidad

- Kiosko es MIT, sin garantía.
- GDACS y EMSC lo dicen de sus datos: «indicativo», «puede estar
  incompleto o retrasado» [15c][13c].
- AEMET no responde del uso de sus datos [12b], y JMA no garantiza la
  entrega [9].
- El plugin lo repite en su README y en la ficha. No toma decisiones por
  el usuario ni da instrucciones propias: solo las de la autoridad, tal
  cual.
- Mostrar las marcas (NWS, NOAA) no debe sugerir respaldo oficial [6]. Se
  nombra la fuente sin logotipos.

---

## 8. Plan

| Fase | Qué | Esfuerzo |
|---|---|---|
| **F0. Núcleo** | (a) Fuentes que corren sin widget: una fuente declara `alerts` y `background: true`, y corre si el plugin está activo y el usuario la activó en Ajustes → Fuentes de datos, aunque ninguna tesela la use. (b) `source` y `detail` opcionales en `Alert`, también en la API y en Home Assistant. (c) Una ayuda de pruebas para el `alerts` de una fuente, si `testing` no la tiene. | S–M (2–3 días) |
| **F1. Plugin base** | Parser XML seguro con pruebas de ataque; modelo común; adaptador CAP (1.1 y 1.2, Atom, RSS y CAP suelto); filtro de zona; ciclo de vida; estado en `dataDir`; niveles (§4.7). Feeds: NWS, tsunami.gov ×2, NCDR, AEMET (RSS), Meteoalarm, GDACS y CAP propio. | M (4–5 días) |
| **F2. Feeds no CAP** | USGS, EMSC (FDSN + WebSocket), IGN (GeoRSS), JMA (VXSE51/53, VTSE41/51, VPWW con su tabla de zonas), SASMEX y SSN; duplicados entre fuentes. | M (3–4 días) |
| **F3. Widget e idiomas** | `hazards/latest`, *presets* por sitio, textos en `en`, `es`, `zh-Hant`, `zh-Hans`, `ja` y `de`; README con §7.2; simulacro. | M (2–3 días) |
| **F4. Sonido en el núcleo** | Tonos generados, reproductores por sistema, voz, ajustes, repetición, «Probar sonido», `doctor`. | M (3 días) |
| **F5. Pulido** | Firma XML-DSig de tsunami.gov (opcional); `choices` de geocódigos; revisión nativa de textos (zh-Hant, ja). | S |

Total: unas **2–3 semanas** de código. Orden: F0 → F1 → F3 (ya útil en
EE. UU., Taiwán y España para el tiempo) → F2 → F4 → F5. Z20 del estudio de
chino queda cubierta por F1 + F3 con el *preset* `ncdr`.

**Riesgos:**
- **Formatos que cambian sin aviso.** El NCDR es una SPA con su JS; JMA
  cambia códigos. Lo cubren las pruebas con fixtures y los avisos de feed
  caído.
- **Ejemplos reales de lo más importante.** Sin un tsunami real no hay CAP
  real de tsunami de la CWA; no se ha visto ninguno (§10). Hay que
  construir el fixture desde el perfil CAP-TWP y pedir ejemplos al NCDR.
- **Falsa sensación de seguridad.** El mayor riesgo no es técnico. Se
  mitiga con §7.2 y con no anunciarlo como alerta.
- **Carga a terceros.** Mil instalaciones sondeando el NCDR cada minuto
  son 17 peticiones por segundo. Sigue siendo poco, pero hay que respetar
  los 3 s del NCDR y los 10 GB/día de JMA por IP, y repartir el momento de
  arranque al azar (*jitter*).
- **El sonido en Linux sin sesión de audio** (linger, servidores): `doctor`
  lo detecta y el editor lo explica.
- **Licencias:** Meteoalarm pone condiciones extra para redistribuir que no
  se han podido leer (§10). Hasta leerlas, AEMET directo para España.

---

## 9. Preguntas para ti

1. **Nombre:** ¿`kiosko-plugin-hazards` («Avisos y terremotos») o prefieres
   `kiosko-plugin-cap`, o meterlo dentro de `weather`?
2. **Fuentes sin widget (F0a):** ¿aceptas que una fuente de alertas corra
   sin tesela si el usuario la activa en Ajustes? La otra opción es
   documentar que hay que poner la tesela en alguna página.
3. **`source` y `detail` en `Alert` (F0b):** ¿se añaden al SDK, o el plugin
   se apaña con `title` y `text`?
4. **Topes por defecto:** informes de terremoto `warn` y tiempo `warn`
   (rojo de AEMET incluido). ¿O el rojo de AEMET y Meteoalarm debería ser
   `critical` por defecto?
5. **Sonido:** ¿en el núcleo como se propone, apagado por defecto y solo
   `critical`? ¿Voz sí o solo tono?
6. **`mirror/earthquakes`:** ¿se queda como mapa sin alertas, o se le
   quitan los datos y se hace un widget de mapa de `hazards`?
7. **SASMEX y P2PQuake:** ¿entran como *presets* con su aviso, o se dejan
   fuera para no dar a entender que hay alerta temprana?
8. **¿Feed caído a pantalla completa?** ¿Una alerta `info` «sin datos de
   avisos desde hace 1 h», o basta con la tesela?
9. **¿Orden de los países?** Se propone empezar por EE. UU., Taiwán y
   España (tiempo), porque son CAP; Japón después.

---

## 10. Lo que no se ha podido comprobar

- **Ejemplos reales:** no se ha visto un CAP real de sismo ni de tsunami de
  la CWA en el NCDR (no hubo ninguno el día de la prueba), así que se
  desconocen sus `eventCode` y rutas. Tampoco se ha visto un Warning de
  tsunami real de tsunami.gov, solo boletines de información.
- **NWS:** ni cifras de latencia ni el contenido del perfil CAP-TSU, en
  concreto cómo usan `references` los avisos de tsunami.
- **USGS:** las definiciones oficiales de `alert`, `status` y `tsunami` (la
  página de términos de ComCat redirige a otra sin ellas).
- **AEMET:** que la respuesta de la API OpenData sea un tar de CAP no está
  en una página oficial. Lo dicen los clientes. Por eso se propone el RSS.
- **Meteoalarm:** sus condiciones de redistribución (página en JavaScript).
- **IGN:**
  - La fecha de acreditación como proveedor de NEAMTWS, que solo se vio en
    fragmentos de documentos de la COI.
  - Ningún feed de tsunamis del IGN: parece que no existe.
- **Latencias de GDACS** y la de EMSC como «primero en el mundo».
- **Push:** cómo funciona de verdad el envío por MQTT del NCDR; la URL del
  WebSocket de producción de P2PQuake (se ha deducido, no se ha probado).
- **México y Chile:**
  - Las condiciones de SASMEX y del SSN.
  - Un feed público del SHOA (no resolvía desde aquí).
  - Las condiciones del CSN.
- **Sonido:** no se ha probado en las tres plataformas. Los comandos salen
  de su documentación.

---

## 11. Fuentes

1. OASIS, *Common Alerting Protocol Version 1.2* (2010). https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html
2. OASIS, *Example Practices: CAP Feeds v1.0* (Committee Note 02, 2014). https://docs.oasis-open.org/emergency-adopt/cap-feeds/v1.0/cap-feeds-v1.0.html
3. OMM, Registro de Autoridades de Alerta: https://alertingauthority.wmo.int/ · índice https://alertingauthority.wmo.int/rss.xml · centro de avisos https://severeweather.wmo.int/ · GMAS https://wmo.int/node/25777 · Alert-Hub.Org https://www.alert-hub.org/
4. FEMA, IPAWS All-Hazards Information Feed (requiere MOA): https://fema.gov/emergency-managers/practitioners/integrated-public-alert-warning-system/technology-developers/all-hazards-information-feed
   - 4b. NOAA tsunami.gov, productos y CAP: https://www.tsunami.gov/?page=productRetrieval · https://www.tsunami.gov/?page=cap
5. NWS, API: https://www.weather.gov/documentation/services-web-api · https://api.weather.gov/openapi.json · tipos de suceso https://api.weather.gov/alerts/types
6. NWS, aviso legal (dominio público, sin sugerir respaldo): https://www.weather.gov/disclaimer
7. NCDR, 民生示警公開資料平台: https://alerts.ncdr.nat.gov.tw/web · índice Atom https://alerts.ncdr.nat.gov.tw/RssAtomFeeds.ashx · taller CAP 2016 https://preparecenter.org/resources/cap-workshop-2016-taiwan · estado de fuentes de KDE https://alerts.kde.org/sources/status
   - 7b. CWA, latencias (alerta temprana 10–15 s, informe 5–10 min, tsunami ≈ 20 min): https://www.cwa.gov.tw/V8/E/S/eservice/app/app_e.html
   - 7c. Licencia de Datos Abiertos del Gobierno 1.0: https://data.gov.tw/license · https://www.cwa.gov.tw/V8/C/information.html
   - 7d. CNA, la alerta temprana de la CWA para terceros exige convenio: https://www.cna.com.tw/news/ahel/202404265004.aspx
   - 7e. CWA opendata: https://opendata.cwa.gov.tw/apidoc/v1 · https://opendata.cwa.gov.tw/dist/opendata-swagger.html
8. USGS, feeds GeoJSON: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php · servicio FDSN https://earthquake.usgs.gov/fdsnws/event/1/ · PAGER https://earthquake.usgs.gov/data/products/pager/faq.php
   - 8b. USGS, rapidez de publicación: https://www.usgs.gov/faqs/how-quickly-earthquake-information-posted-usgs-website-and-sent-out-earthquake-notification
   - 8c. USGS, derechos: https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits
   - 8d. ShakeAlert: https://www.usgs.gov/programs/earthquake-hazards/science/earthquake-early-warning-overview · https://www.shakealert.org/?p=6123
9. JMA, feeds XML: https://xml.kishou.go.jp/xmlpull.html · lista de productos https://xml.kishou.go.jp/xmllist.pdf · CAP de tifones RSMC https://www.data.jma.go.jp/cap-rsmctk/atom.xml
   - 9b. JMA, 震度速報 ≈ 1,5 min: https://www.jma.go.jp/jma/kishou/know/jishin/joho/seisinfo.html · 津波警報 ≈ 3 min: https://www.jma.go.jp/jma/kishou/know/jishin/tsunami/issuance.html
   - 9c. JMA, condiciones de uso (PDL 1.0, 気象業務法): https://www.jma.go.jp/jma/kishou/info/coment.html · PDL 1.0 https://www.digital.go.jp/resources/open_data/public_data_license_v1.0
   - 9d. «緊急地震速報等、公開されない電文もあります»: https://xml.kishou.go.jp/xmllist.pdf
10. P2PQuake (no oficial): https://www.p2pquake.net/develop/json_api_v2/ · https://www.p2pquake.net/swagger-ui/specification.yaml · https://www.p2pquake.net/secondary_use/
11. IGN, GeoRSS de terremotos: https://www.ign.es/ign/RssTools/sismologia.xml · https://www.ign.es/web/ign/portal/social-rss
    - 11b. IGN, folleto de avisos (≈ 2 min sismo, ≈ 6 min tsunami): https://www.ign.es/web/resources/docs/IGNCnig/folletos/AvisoTerremotos_AlertaTsunamis2019.pdf
    - 11c. Licencia CC BY 4.0: https://www.idee.es/csw-inspire-idee/home/api/records/spaignCatalogoSismicoNacional · https://www.ign.es/web/en/politica-datos
    - 11d. Plan Estatal ante Maremotos: https://www.ign.es/web/resources/acercaDe/libDigPub/Plan-Estatal-Maremotos.pdf · RD 1053/2015 https://www.boe.es/eli/es/rd/2015/11/20/1053 · https://boe.es/boe/dias/2025/07/24/pdfs/BOE-A-2025-15400.pdf
    - 11e. ES-Alert: https://www.interior.gob.es/opencms/es/detalle/articulo/El-sistema-de-avisos-a-la-poblacion-ante-emergencias-estara-operativo-desde-manana-en-toda-Espana/
12. Meteoalarm, feed Atom: https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain · condiciones https://www.meteoalarm.org/en/live/page/terms-and-conditions
    - 12a. AEMET, especificación OpenData: https://opendata.aemet.es/AEMET_OpenData_specification.json · alta de clave https://opendata.aemet.es/centrodedescargas/altaUsuario · RSS CAP https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/rss/CAP_AFAE_wah_RSS.xml · perfil CAP de Meteoalerta https://www.aemet.es/documentos/es/eltiempo/prediccion/avisos/plan_meteoalerta/METEOALERTA_ANX3_CAP.pdf
    - 12b. AEMET, nota legal: https://www.aemet.es/en/nota_legal
13. EMSC, FDSN: https://seismicportal.eu/fdsn-wsevent.html · tiempo real https://www.seismicportal.eu/realtime.html · ejemplo https://github.com/EMSC-CSEM/webservices101
    - 13b. LastQuake: https://emsc-csem.org/faq/lastquake.php · https://emsc-csem.org/lastquake/how_it_works/
    - 13c. EMSC, condiciones: https://seismicportal.eu/terms.html
14. SASMEX (CIRES), CAP: https://rss.sasmex.net/api/v1/alerts/latest/cap/
    - 14b. SSN: http://www.ssn.unam.mx/rss/ultimos-sismos.xml
    - 14c. Chile: CSN https://www.sismologia.cl/accesos/uso-de-datos.html · SHOA, guía SNAM https://esmeralda.cl/armada/site/docs/20230309/20230309122928/guia_referencia_snam.pdf · SAE (GSMA) https://www.gsma.com/solutions-and-impact/connectivity-for-good/mobile-for-development/gsma_resources/chiles-emergency-alert-system-the-role-of-mobile-network-operators-in-early-warning-systems/
15. GDACS, CAP: https://www.gdacs.org/xml/gdacs_cap.xml · RSS https://www.gdacs.org/xml/rss.xml
    - 15b. Modelo de terremotos: https://www.gdacs.org/Knowledge/models_EQ.aspx · tsunamis https://gdacs.org/Knowledge/models_ts.aspx
    - 15c. Condiciones: https://gdacs.org/About/termofuse.aspx · https://www.gdacs.org/documents/2025/GDACS_Terms_of_use_Mar_25.pdf
16. OWASP, *XML External Entity Prevention Cheat Sheet*: https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html
17. PipeWire, `pw-cat`/`pw-play`: https://docs.pipewire.org/page_man_pw-cat_1.html
18. `paplay(1)`: https://manpages.debian.org/paplay
19. `aplay(1)`: https://manpages.debian.org/aplay
20. `spd-say(1)`: https://manpages.debian.org/spd-say
21. eSpeak NG: https://github.com/espeak-ng/espeak-ng
22. `afplay`: https://ss64.com/mac/afplay.html
23. `say`: https://ss64.com/mac/say.html
24. Microsoft, `System.Media.SoundPlayer`: https://learn.microsoft.com/dotnet/api/system.media.soundplayer
25. Microsoft, `System.Speech.Synthesis.SpeechSynthesizer`: https://learn.microsoft.com/dotnet/api/system.speech.synthesis.speechsynthesizer
26. FCC, 47 CFR parte 11 (EAS), §11.45 (prohibición de usar la señal de atención en falso): https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-11
27. W3C, *Understanding SC 1.4.2 Audio Control*: https://www.w3.org/WAI/WCAG21/Understanding/audio-control.html
28. FCC, informe sobre la falsa alerta de misil de Hawái (2018): https://www.fcc.gov/document/report-and-recommendations-hawaii-false-ballistic-missile-alert
