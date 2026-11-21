# Tienda de plugins: diseño y plan de implementación

Estado: **propuesta** (2026-11-21). No hay código: este documento es el plan
del punto 8 de [plan.md](plan.md). Sustituye a lo que allí se había pensado y
lo concreta lo bastante para implementarlo fase a fase. Las afirmaciones
sobre otras tiendas, npm, pagos e impuestos llevan su fuente entre corchetes
([n]); la lista está al final.

## 0. Resumen

- **Qué**: una tienda de plugins «tipo app store» con dos caras, la web
  (`kioskolcd.dev/store/`) y la vista **Plugins** del editor, que leen el
  **mismo catálogo**. Hoy todo es gratis; el modelo de datos ya tiene sitio
  para precios, pero no se construye nada de cobro hasta la fase 5.
- **El catálogo es un índice estático** (JSON) que construye una GitHub Action
  y se publica con el resto del sitio en GitHub Pages. Se alimenta de **npm**
  (búsqueda por la palabra clave `kiosko-plugin` [11]), del
  `kiosko-manifest.json` que va dentro de cada paquete (se lee del tarball,
  **sin ejecutar el código**), de la API de descargas de npm [12] y de GitHub
  (estrellas, CI, issues, releases). Nada de servidor propio ni base de datos.
- **Lo curado vive en un repo de datos**, `kiosko-lcd/plugin-index`:
  qué plugins están *listados* (por PR, como HACS [1]), quién está
  *verificado* y qué versiones se revisaron (por su hash `integrity`), y la
  **lista de versiones retiradas**, que el editor consulta a diario. Un plugin
  publicado con la palabra clave aparece también sin PR, marcado «Sin
  revisar».
- **Niveles de confianza**: *Oficial* (kiosko-lcd), *Verificado* (autor
  identificado + código revisado en una versión concreta, ligado a su
  `integrity`; se pierde en la siguiente versión sin revisar), *Listado* (pasa
  las comprobaciones automáticas), *Sin revisar* (solo encontrado en npm).
- **El editor funciona sin red**: trae una copia del índice dentro del
  paquete de Kiosko, guarda la última descargada en `cacheDir` con ETag y la
  refresca al arrancar y una vez al día, junto a la comprobación de
  actualizaciones que ya existe.
- **Compatibilidad con *tus* pantallas**: el índice dice, por widget, sus
  tamaños `min`/`preferred` y en qué clases de panel cabe (barra, apaisado,
  cuadrado, redondo, vertical, sacadas de `PANEL_PRESETS`); el editor lo cruza
  con las pantallas reales del usuario, su sistema operativo, su versión de
  la API de plugins y su idioma.
- **Permisos antes de instalar y antes de actualizar** (hoy se avisa después
  de actualizar): como Chrome, que desactiva una extensión hasta que el
  usuario acepta los permisos nuevos [8].
- **Popularidad sin telemetría**: mediana de 4 semanas de descargas de npm, en
  escala logarítmica, más estrellas de GitHub con poco peso y la fecha de la
  última versión; se muestra como etiquetas (*Popular*, *En alza*, *Nuevo*) y
  cifras redondeadas, no como un número que invite a inflarlo. **No se añade
  telemetría** (se deja diseñada una opción voluntaria por si un día hiciera
  falta, y se recomienda no hacerla).
- **Valoraciones**: primero, GitHub Discussions en un repo central (una
  discusión por plugin; 👍/👎 y comentarios), de las que la tienda solo copia
  recuentos. Cuentas propias, solo si llega el pago y hacen falta.
- **Pago (futuro)**: para los plugins oficiales, un *merchant of record*
  (Stripe Managed Payments [17], disponible para negocios en España; Lemon
  Squeezy queda descartado porque cierra en marzo de 2027 [16]) y una
  **licencia firmada que se comprueba sin red**. Para terceros, cada autor trae
  su propio cobro (su MoR) y Kiosko solo enlaza: no hacemos de marketplace
  (Managed Payments no lo permite [17] y nos obligaría a DAC7 [25]). Nunca DRM
  que llame a casa en cada arranque.
- **Fase 1 (MVP, ~8–9 días)**: índice estático con los oficiales y los
  encontrados por palabra clave, la tienda en la web (lista, filtros, ficha) y
  el catálogo en el editor con instalación de un clic y revisión de permisos.
  Sin insignias salvo «Oficial», sin valoraciones, sin pago.

---

## 1. Lo que ya existe y de lo que se parte

Leído en `origin/main` (eb0e67d):

| Pieza | Qué hace hoy | Qué aporta a la tienda |
|---|---|---|
| `packages/core/src/plugin-meta.ts` | `pluginManifest()` → `kiosko-manifest.json`: id, paquete, nombre y descripción por idioma, versión, autor, licencia, repo, icono, rango `sdk`, `platforms`, `languages`, `categories`, `tags`, `permissions`, `riskyOptions`, `requires`/`optional`, widgets (tamaños, opciones como JSON Schema, captura, `animated`, `urgent`), fuentes, interludios, plantillas. `incompatibility()` (API y SO). | Es la ficha de la tienda casi entera, legible sin ejecutar código. Ya va en el tarball de todos los oficiales (`files: dist, docs, kiosko-manifest.json…`). |
| `packages/core/src/plugin-updates.ts` | Comprobación diaria en npm con metadatos abreviados y peticiones condicionales; elige la versión más nueva compatible (`kiosko.sdk`, `os`). | La misma lógica de «qué versión me sirve» se reutiliza con los datos del índice. |
| `packages/server/src/plugins-manage.ts` | Instala con `npm install --ignore-scripts`, recarga en caliente, vuelve atrás si la nueva no carga, calcula `addedPermissions` (después de instalar). | Es el camino de instalación de la tienda. Falta: fijar versión exacta, comprobar `integrity`, y avisar de permisos **antes**. |
| `packages/server/src/official.ts` | `BUNDLED_PLUGIN_IDS` (16) y `OPTIONAL_PLUGIN_IDS` (`doom`, `video`, `fractals`). | Fuente de verdad del nivel «Oficial» en la fase 1. |
| `packages/web/src/views/Others.tsx` | Vista Plugins: actualizaciones, oficiales opcionales con «Instalar», instalados con permisos, requisitos que faltan, «no está en tu idioma», «Instalar de npm» a mano. | Se convierte en «Instalados · Tienda · Actualizaciones». |
| `packages/core/src/config/model.ts` `PANEL_PRESETS` | 12 modelos con resolución y diagonal (Trofeo 1920×462, 1920×400, 1280×480, 854×480, 320×960, 640×172, 1920×480, 1600×720, 480×480, 320×320, 320×240, redondo 480×480). | Clases de panel para filtrar y para «cabe en…». |
| `packages/sdk/src/languages.ts` | Por idioma, `plugins.without/first/instead` (p. ej. sin `agents`, `cats`, `usage` en `zh-Hans`). | Base del «mercado»: la tienda respeta lo mismo que la portada. |
| `packages/server/src/gallery.ts`, `packages/web/landing/build.mjs`, `.github/workflows/pages.yml` | La Action de Pages clona los oficiales, pinta la galería en cada idioma (`gallery.json`) y construye portada, demo y esquema. | El índice se construye en ese mismo flujo; las capturas de los oficiales ya salen de ahí. |
| `server.ts` | Escucha en 127.0.0.1; toda petición que cambia algo lleva `X-Kiosko: 1` y se comprueba `Host`. | Un enlace profundo desde la web **no puede** instalar nada: solo abrir la ficha en el editor. Bien. |

Hechos comprobados el 2026-11-21:

- `npm search keywords:kiosko-plugin` devuelve 19 paquetes, todos oficiales y
  publicados por `loksly`. Ninguno tiene atestación de procedencia
  (`dist.attestations` vacío): se publican a mano con 2FA.
- `kiosko plugins new` ya pone `keywords: ['kiosko', 'kiosko-plugin', 'lcd',
  'widgets']`: cualquier plugin de terceros hecho con la plantilla aparecerá.
- Las categorías son una taxonomía fija en el SDK (`CATEGORIES`: `agents`,
  `system`, `time`, `productivity`, `dev`, `info`, `media`, `scene`, `fun`),
  ya traducida a 5 idiomas.

## 2. Cómo lo hacen otros (resumen de la investigación)

| Tienda | Alta | Revisión | Instalar/actualizar | Popularidad, capturas | Lo que copiamos / evitamos |
|---|---|---|---|---|---|
| **HACS** (Home Assistant) | PR al repo `hacs/default`, una entrada por repo en un fichero por categoría [1]. | Acción de validación obligatoria y revisión humana; puede tardar **meses** [1]. Release de GitHub obligatorio. Clave `country` para repos de un país [1]. | Desde GitHub releases. | — | Copiamos: PR a un repo de datos + validación automática + `country`. Evitamos: depender de revisión humana para *aparecer*. |
| **Obsidian** | Antes, PR a `obsidian-releases` con `community-plugins.json`; hoy la documentación describe un directorio en community.obsidian.md enlazado a GitHub que lee `manifest.json` de la rama principal [2]. | Automática; si falla, nueva versión [2]. | Ficheros del release de GitHub (`main.js`, `manifest.json`). | Descargas. | Copiamos: el manifiesto en el repo/paquete como fuente de la ficha, revisión automática. |
| **VS Code Marketplace** | `vsce publish`. | Escaneo de malware en cada publicación y reescaneos periódicos; 110 extensiones retiradas en un año [5][6]. **Editor verificado** por dominio, con 6 meses de antigüedad y revisión manual [3]. | Actualiza sola a la versión más alta; prerelease solo con números distintos [3]. | Instalaciones, estrellas. | Copiamos: verificación de editor separada de la del código; retirar versiones. Evitamos: actualización automática silenciosa. |
| **Open VSX** | `ovsx publish` con token. | La propiedad de un *namespace* se reclama en público (issue) y entonces queda «verificado» [4]. | — | — | Copiamos: verificación pública y trazable (un PR/issue). |
| **Raycast Store** | PR al monorepo `raycast/extensions` (lo abre `npm run publish`) [7]. | Revisión humana del PR; al fusionar se publica [7]. | Automático. | — | Evitamos: monorepo con el código de todos (no escala para nosotros; los plugins viven en npm). |
| **Elgato Stream Deck** | Maker Console, contrato de Maker [9]. | Revisión de producto [9]. | Desde la tienda. | — | Pago: 70/30, cobro con Stripe Connect; productos gratis también; desde 2026 exige plugins «compatibles con DRM» [9]. Evitamos el DRM. |
| **Grafana** | Envío al catálogo. | **Firma** por niveles: *private* (te la firmas tú, sin revisión, para URLs concretas), *community* (revisada, gratis, OSS), *commercial* (suscripción) [10]. | Grafana se niega a cargar sin firma salvo configuración. | — | Copiamos: niveles de confianza explícitos y que un nivel se ate a un artefacto concreto. |
| **Chrome Web Store** | Consola de desarrollador. | Revisión. | Si una actualización pide permisos con avisos nuevos, la extensión **se desactiva hasta que el usuario los acepta** [8]. | Valoraciones 1–5, usuarios. | Copiamos: permisos nuevos = confirmación antes de aplicar. |
| **Steam Workshop** | `ISteamUGC` desde el juego [26]. | — | Suscripción; Steam mantiene el contenido al día [26]. | Votos 👍/👎 en la web. | Copiamos: 👍/👎 mejor que estrellas para pocos votos. |
| **npm** | `npm publish`; **trusted publishing** por OIDC desde GitHub Actions/GitLab, con procedencia automática para repos y paquetes públicos [13]. | Ninguna. | `integrity` (SHA-512) en cada versión; `npm audit signatures` comprueba firmas del registro y atestaciones [14]. | API de descargas: diaria, con retraso de un día, *bulk* de hasta 128 paquetes **sin scope** [12]; búsqueda con `keywords:` y hasta 250 resultados por página [11]. `npm deprecate` por versión; despublicar solo en 72 h [15]. | La base técnica de todo. |

Conclusión: **nadie con nuestro tamaño mantiene un registro de código
propio**. Lo que funciona es un índice (JSON en un repo) sobre un registro
que ya existe (GitHub releases, npm), validación automática para aparecer y
una revisión humana, más rara, para un sello. Es lo que proponemos.

## 3. Modelo de datos del catálogo

### 3.1 Capas y de dónde sale cada dato

| Dato | Fuente | Quién lo escribe |
|---|---|---|
| Identidad, textos por idioma, licencia SPDX, repo, plataformas, idiomas, categorías, tags, permisos, opciones con riesgo y secretas, requisitos, widgets/interludios/plantillas | `kiosko-manifest.json` del tarball de cada versión | El autor (`kiosko plugins manifest`) |
| Versiones, fechas, `integrity`, `deprecated`, rango `sdk`, `os`, procedencia, mantenedores | Packument de npm (`time`, `versions[v].dist`, `dist.attestations`) | npm |
| Descargas | `api.npmjs.org/downloads/range/…` [12] | npm |
| Estrellas, issues abiertas, archivado, estado de CI, releases (novedades), Discussions | API de GitHub | GitHub |
| Listado, editor verificado, versiones revisadas, retiradas, insignias manuales, overrides (p. ej. ocultar un plugin), informes de compatibilidad | `kiosko-lcd/plugin-index` | Mantenedores de Kiosko (por PR) |
| Capturas | Oficiales: las pinta la Action (galería). Terceros: `docs/*.png` del tarball (fase 1); render propio en la Action (fase 3) | Compositor |
| Popularidad, salud, «cabe en», insignias derivadas | Calculado al construir el índice | Constructor del índice |

Regla: **lo que dice el autor va en el manifiesto; lo que dice la tienda va
en el índice.** Valoraciones, insignias y popularidad nunca están en el
manifiesto (ya lo dice `plugin-meta.ts`).

### 3.2 Campos nuevos del manifiesto (aditivos, `manifest: 1` sigue valiendo)

Todos opcionales; `pluginManifest()` los copia de la definición o del
package.json, y `kiosko plugins check` los valida.

```ts
// En PluginDefinition (packages/sdk/src/plugin.ts) y PluginManifest (core/plugin-meta.ts)
markets?: {
  /** Solo útil aquí (ISO 3166-1 alfa-2, o 'EU'): el PVPC de España, el metro de Taipéi. */
  only?: string[];
  /** Su servicio no se ofrece aquí: se oculta al navegar desde esas regiones. */
  without?: string[];
  note?: Localized;                    // «Necesita una cuenta de Red Eléctrica»
};
support?: { issues?: string; discussions?: string; docs?: string };  // por defecto, `bugs` y `homepage` de package.json
pricing?: { model: 'free' };           // único valor aceptado hasta la fase 5 (ver §8)
funding?: string;                      // del `funding` de package.json: «Apoyar al autor»
resources?: { memoryMb?: number; cpu?: 'low' | 'medium' | 'high'; note?: Localized };  // punto 26 de plan.md
// Por widget:
screenshots?: { file: string; theme: string; lang: string; w: number; h: number }[];   // además de `screenshot`
round?: 'ok' | 'cut';                  // lo calcula `check` (§3.4), no el autor
// Por interludio:
preview?: { video?: string; poster: string };  // docs/<id>.webm + docs/<id>.jpg, 6–10 s
```

Por qué no `price` en el manifiesto: el precio cambia sin publicar versión
y depende del vendedor; irá en el índice (§8.4). `pricing.model` sí va en el
manifiesto porque el código cambia (un plugin de pago comprueba su licencia).

### 3.3 Mercado y región

- **Por idioma** (ya existe): `languages.ts` → `plugins.without`. La tienda
  web en `/zh-Hans/store/` no lista `agents`, `cats` ni `usage`, como la
  portada (`offered()` en `build.mjs`).
- **Por país** (nuevo): `markets.only`/`markets.without`. En la web, la región
  sale del idioma de la página (`es` → sin región; `zh-Hant` → TW/HK) y un
  selector «Región: todas / España / …». En el editor, de un ajuste nuevo
  `region` en Ajustes (por defecto, el país de la localidad configurada si es
  inequívoco, si no, ninguno). **Nunca se oculta del buscador**: se marca
  («Solo útil en España») y el filtro «Disponible en mi región» viene
  activado.
- Es el mismo concepto que la clave `country` de HACS [1].

### 3.4 Tamaños, orientaciones y modelos de panel

Clases de panel, función pura nueva `panelClass(width, height, shape)` en
`packages/core/src/config/model.ts`:

| Clase | Regla (ancho/alto del dibujo) | Presets que caen ahí |
|---|---|---|
| `bar` (barra) | ≥ 2,5 | 1920×462, 1920×400, 1920×480, 1280×480, 640×172 |
| `landscape` (apaisado) | 1,15–2,5 | 854×480, 1600×720, 320×240 |
| `square` (cuadrado) | 0,87–1,15 | 480×480, 320×320 |
| `round` (redondo) | cuadrado + `shape: 'round'` | round-480 (AIO) |
| `portrait` (vertical) | < 0,87 | 320×960, y cualquier barra montada a 90°/270° |

`PanelPreset` gana `shape?: 'rect' | 'round'` (solo `round-480` lo pone), y
la pantalla (`Screen`) también, para que el editor sepa que la del usuario es
redonda.

Por widget, el constructor del índice calcula `fits: PanelClassId[]` y
`presets: string[]` con `fitsScreen(size, w, h)`: cabe si `size.min` cabe en
el panel (menos márgenes del lienzo), es *ideal* si cabe `preferred`. Debe ser
**la misma función** que usa el editor para dejar soltar un widget; si no
existe como función pura hoy, se extrae de `layout/`. Interludios: caben en
todo (se pintan a pantalla completa), pero se marcan los que piden un aspecto
(`aspect` opcional). Plantillas: `layouts: ['wide', 'square', 'tall']` según
traigan `wide`/`square`/`tall`.

Redondo: `kiosko plugins check` pinta cada widget a 480×480 y mide los
píxeles de texto fuera del círculo inscrito (el `renderWidget` de pruebas ya
devuelve `outside` y los textos); más de un umbral → `round: 'cut'`. Así el
dato es medido, no declarado.

### 3.5 Formato del índice

Tres ficheros públicos, versionados en la ruta (`/store/v1/`) igual que el
esquema de configuración (`/schema/v1/config.json`):

```
https://kioskolcd.dev/store/v1/index.json           todo el catálogo, compacto (lo baja el editor)
https://kioskolcd.dev/store/v1/plugins/<id>.json    ficha completa (bajo demanda)
https://kioskolcd.dev/store/v1/withdrawn.json       versiones retiradas (pequeño; lo mira el editor a diario)
https://kioskolcd.dev/store/v1/*.sig                firmas Ed25519 (fase 2)
https://kioskolcd.dev/store/v1/img/<id>/<version>/<widget>--<theme>--<lang>--<w>x<h>.webp
https://kioskolcd.dev/store/v1/schema/index.json    el JSON Schema de abajo
```

`index.json` (con 50 plugins debería quedarse en ~150–250 kB sin
comprimir; se sirve con gzip). Esquema (JSON Schema 2020-12; `Localized` =
objeto con `en` obligatorio y claves BCP 47):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://kioskolcd.dev/store/v1/schema/index.json",
  "title": "Kiosko plugin store index",
  "type": "object",
  "required": ["schema", "generatedAt", "plugins"],
  "properties": {
    "schema": { "const": 1 },
    "generatedAt": { "type": "string", "format": "date-time" },
    "kiosko": { "type": "object", "properties": { "latest": { "type": "string" }, "sdk": { "type": "string" } } },
    "categories": { "type": "array", "items": { "type": "object", "required": ["id", "label"], "properties": { "id": { "type": "string" }, "label": { "$ref": "#/$defs/localized" } } } },
    "plugins": { "type": "array", "items": { "$ref": "#/$defs/plugin" } }
  },
  "$defs": {
    "localized": { "type": "object", "required": ["en"], "additionalProperties": { "type": "string" } },
    "platform": { "enum": ["linux", "darwin", "win32"] },
    "panelClass": { "enum": ["bar", "landscape", "square", "round", "portrait"] },
    "permissions": {
      "type": "object",
      "properties": {
        "network": { "type": "array", "items": { "type": "string" } },
        "exec": { "type": "array", "items": { "type": "string" } },
        "files": { "type": "array", "items": { "type": "string" } },
        "devices": { "type": "array", "items": { "type": "string" } }
      },
      "additionalProperties": false
    },
    "size": { "type": "object", "required": ["w", "h"], "properties": { "w": { "type": "integer" }, "h": { "type": "integer" } } },
    "release": {
      "type": "object",
      "required": ["version", "date", "integrity"],
      "properties": {
        "version": { "type": "string" },
        "date": { "type": "string", "format": "date-time" },
        "integrity": { "type": "string", "pattern": "^sha512-" },
        "sdk": { "type": "string" },
        "platforms": { "type": "array", "items": { "$ref": "#/$defs/platform" } },
        "provenance": { "type": "object", "properties": { "repository": { "type": "string" }, "workflow": { "type": "string" } } },
        "reviewed": { "type": "boolean", "description": "Su integrity está en la lista de versiones revisadas" },
        "deprecated": { "type": "string", "description": "Mensaje de npm deprecate" },
        "withdrawn": { "type": "boolean" },
        "addedPermissions": { "$ref": "#/$defs/permissions", "description": "Respecto a la versión anterior" }
      }
    },
    "plugin": {
      "type": "object",
      "required": ["id", "package", "name", "tier", "license", "latest", "releases", "platforms", "languages", "categories", "permissions", "pricing"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9-]+$" },
        "package": { "type": "string" },
        "name": { "$ref": "#/$defs/localized" },
        "description": { "$ref": "#/$defs/localized" },
        "icon": { "type": "string" },
        "tier": { "enum": ["official", "verified", "listed", "found"] },
        "badges": { "type": "array", "items": { "enum": ["official", "verified", "popular", "rising", "new", "tested", "bundled", "provenance"] } },
        "publisher": {
          "type": "object",
          "properties": { "name": { "type": "string" }, "npm": { "type": "array", "items": { "type": "string" } }, "github": { "type": "string" }, "verified": { "type": "boolean" } }
        },
        "license": { "type": "string", "description": "Expresión SPDX, o UNLICENSED" },
        "links": { "type": "object", "properties": { "repository": { "type": "string" }, "homepage": { "type": "string" }, "issues": { "type": "string" }, "discussions": { "type": "string" }, "reviews": { "type": "string" }, "funding": { "type": "string" } } },
        "bundled": { "type": "boolean", "description": "Viene con Kiosko" },
        "latest": { "type": "string" },
        "releases": { "type": "array", "maxItems": 20, "items": { "$ref": "#/$defs/release" }, "description": "Estables, de la más nueva a la más vieja" },
        "platforms": { "type": "array", "items": { "$ref": "#/$defs/platform" } },
        "languages": { "type": "array", "items": { "type": "string" } },
        "categories": { "type": "array", "items": { "type": "string" } },
        "tags": { "type": "array", "items": { "type": "string" } },
        "markets": { "type": "object", "properties": { "only": { "type": "array", "items": { "type": "string" } }, "without": { "type": "array", "items": { "type": "string" } }, "note": { "$ref": "#/$defs/localized" } } },
        "pricing": {
          "type": "object", "required": ["model"],
          "properties": {
            "model": { "enum": ["free", "paid", "freemium"] },
            "price": { "type": "object", "properties": { "amount": { "type": "integer", "description": "En céntimos" }, "currency": { "type": "string" }, "taxIncluded": { "type": "boolean" } } },
            "checkout": { "type": "string", "format": "uri" },
            "seller": { "type": "string" },
            "licenseKey": { "type": "string", "description": "Clave pública Ed25519 con la que se comprueban sus licencias" }
          }
        },
        "permissions": { "$ref": "#/$defs/permissions" },
        "riskyOptions": { "type": "integer", "description": "Cuántas; el detalle, en la ficha" },
        "requires": { "type": "array", "items": { "type": "string" }, "description": "Ids de plugin" },
        "optional": { "type": "array", "items": { "type": "string" } },
        "resources": { "type": "object", "properties": { "memoryMb": { "type": "number" }, "cpu": { "enum": ["low", "medium", "high"] } } },
        "widgets": {
          "type": "array",
          "items": {
            "type": "object", "required": ["type", "name"],
            "properties": {
              "type": { "type": "string" },
              "name": { "$ref": "#/$defs/localized" },
              "category": { "type": "string" },
              "min": { "$ref": "#/$defs/size" },
              "preferred": { "$ref": "#/$defs/size" },
              "fits": { "type": "array", "items": { "$ref": "#/$defs/panelClass" } },
              "presets": { "type": "array", "items": { "type": "string" } },
              "animated": { "type": "boolean" },
              "shot": { "type": "string", "description": "Ruta relativa a /store/v1/img/" }
            }
          }
        },
        "interludes": { "type": "array", "items": { "type": "object", "properties": { "type": { "type": "string" }, "name": { "$ref": "#/$defs/localized" }, "poster": { "type": "string" }, "video": { "type": "string" } } } },
        "templates": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "name": { "$ref": "#/$defs/localized" }, "layouts": { "type": "array", "items": { "enum": ["wide", "square", "tall"] } } } } },
        "popularity": {
          "type": "object",
          "properties": {
            "weekly": { "type": "integer", "description": "Mediana de 4 semanas, redondeada al escalón (10, 50, 100, 500, 1000…)" },
            "stars": { "type": "integer" },
            "label": { "enum": ["popular", "rising", "new", null] },
            "score": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        },
        "health": {
          "type": "object",
          "properties": {
            "lastRelease": { "type": "string", "format": "date-time" },
            "ci": { "enum": ["passing", "failing", "unknown"] },
            "openIssues": { "type": "integer" },
            "archived": { "type": "boolean" },
            "manifest": { "enum": ["ok", "missing", "invalid"] },
            "problems": { "type": "array", "items": { "type": "string" } }
          }
        },
        "reviews": { "type": "object", "properties": { "up": { "type": "integer" }, "down": { "type": "integer" }, "comments": { "type": "integer" } } },
        "tested": { "type": "array", "items": { "type": "object", "properties": { "preset": { "type": "string" }, "os": { "$ref": "#/$defs/platform" }, "version": { "type": "string" }, "works": { "type": "boolean" }, "reports": { "type": "integer" } } } },
        "hidden": { "type": "boolean", "description": "Retirado de la tienda (se sigue listando en withdrawn.json)" }
      }
    }
  }
}
```

`plugins/<id>.json` añade: el manifiesto completo de la última versión
(opciones como JSON Schema, opciones con riesgo con su ruta, fuentes), las
`releases` completas con novedades (texto de los releases de GitHub, en
Markdown saneado, máximo 10) y la matriz de capturas.

`withdrawn.json`:

```json
{
  "schema": 1,
  "generatedAt": "2026-11-21T03:00:00Z",
  "entries": [
    {
      "package": "kiosko-plugin-ejemplo",
      "versions": ">=1.2.0 <1.2.3",
      "integrity": ["sha512-…"],
      "severity": "disable",
      "reason": { "en": "Sends your calendar to a third party.", "es": "Envía tu agenda a un tercero." },
      "advisory": "https://github.com/kiosko-lcd/plugin-index/security/advisories/…",
      "date": "2026-11-20"
    }
  ]
}
```

`severity`: `warn` (aviso en la tarjeta y al arrancar) o `disable` (no se
carga en el siguiente arranque ni al recargar; el editor dice por qué y
ofrece actualizar o quitar; anularlo exige escribir el id del plugin, porque
es la máquina del usuario y él manda).

### 3.6 Taxonomía

- **Categorías**: las 9 del SDK, fijas y traducidas. Una categoría nueva es
  un cambio del SDK, no del índice. Un plugin tiene las de sus widgets (ya lo
  hace `pluginManifest`); los que solo traen interludios caen en `fun` o
  `scene` (se añade `category` opcional al plugin para esos casos).
- **Tags**: libres, en minúsculas, máximo 10 por plugin en la tienda (el
  constructor recorta y avisa). Se normalizan con una tabla de sinónimos en
  `plugin-index/tags.json` (`gpu`/`nvidia`/`amd` → `gpu` + el suyo).
- **Filtros** de la tienda: categoría, tag, idioma, clase de panel (y modelo
  concreto), orientación, sistema operativo, licencia (OSI/copyleft/otras),
  gratis/de pago, nivel de confianza, «Disponible en mi región», «Cabe en
  mis pantallas» (solo editor), «Sin permisos de ejecutar».

## 4. El índice: dónde vive, cómo se construye, cómo entra un tercero

### 4.1 Dónde vive

Propuesta: **el índice se construye en el flujo de Pages del monorepo**
(`.github/workflows/pages.yml`) y se publica en `kioskolcd.dev/store/v1/`,
mientras que **los datos curados** viven en `kiosko-lcd/plugin-index` (solo
JSON y Markdown, sin código que se ejecute).

- Pros: un solo despliegue y un solo dominio; el sitio ya clona los oficiales
  y pinta la galería; GitHub Pages es gratis. Los PR de alta no ensucian el
  monorepo.
- Contras: el flujo de Pages pasa a correr también a diario (cron) y al
  fusionar en `plugin-index` (`repository_dispatch`); hoy tarda lo suyo por
  la comprobación de la demo con Chromium. Se mitiga con una caché de
  tarballs por `integrity` (`actions/cache`) y, si hace falta, separando el
  índice en un *job* propio que reutiliza el último artefacto del sitio.
- Límite a vigilar: un sitio de GitHub Pages no puede pasar de 1 GB [27].
  Capturas en WebP, solo la última versión de cada plugin, vídeos de
  interludio de ≤ 1 MB.

Alternativa descartada por ahora: un `store.kioskolcd.dev` desde el repo
`plugin-index` (dos despliegues, CORS para la web, más que mantener).

### 4.2 Contenido de `kiosko-lcd/plugin-index`

```
listed.json        [{ "package": "kiosko-plugin-x", "github": "autor/kiosko-plugin-x", "since": "2026-12-01" }]
publishers.json    [{ "github": "autor", "npm": ["autor"], "name": "…", "verified": "2026-12-03", "by": "loksly" }]
reviewed.json      [{ "package": "…", "version": "1.2.0", "integrity": "sha512-…", "by": "loksly", "date": "…", "notes": "…" }]
withdrawn.json     (formato de §3.5)
overrides.json     [{ "package": "…", "hidden": true, "reason": "…" }, { "package": "…", "popularityHold": true }]
tags.json          sinónimos
compat/            informes de compatibilidad agregados (fase 3)
.github/ISSUE_TEMPLATE/  alta.yml, compatibilidad.yml, denuncia.yml
.github/workflows/check.yml   valida los JSON contra su esquema y comprueba el paquete de un PR de alta
```

### 4.3 Construcción (GitHub Action)

Script nuevo `scripts/store/build-index.ts` (llamado desde
`packages/web/build.mjs --site`, después de la galería), con la lógica pura en
`packages/core/src/store/` para poder probarla:

1. **Candidatos**: `GET registry.npmjs.org/-/v1/search?text=keywords:kiosko-plugin&size=250`
   paginando con `from` [11], más `listed.json`, más `OFFICIAL_PLUGINS`. Se
   descartan los que no se llamen `kiosko-plugin-*` o `@scope/kiosko-plugin-*`.
2. **Metadatos**: el packument completo (`time`, `versions`, `deprecated`,
   `dist.integrity`, `dist.attestations`, `maintainers`), con ETag cacheado.
3. **Manifiesto**: se baja el tarball de la última versión estable (y de las
   anteriores que no estén en caché), **se comprueba su `integrity`** y se
   extrae **solo** `package/kiosko-manifest.json` y `package/docs/*` con un
   lector de tar en streaming (nada se escribe fuera de un directorio
   temporal; rutas con `..` o enlaces se rechazan; tope de 20 MB). No se
   ejecuta nada del paquete. Sin manifiesto: entrada mínima con lo que dice
   `package.json` (`kiosko.sdk`, `kiosko.languages`, `os`) y `health.manifest:
   'missing'`.
4. **Validación**: el manifiesto contra `schema/manifest.json` (nuevo, sale
   de los tipos de `plugin-meta.ts`); que `id` coincida con el paquete; que
   `version` coincida; licencia SPDX válida; imágenes PNG/WebP de verdad y de
   tamaño razonable. Un error no tumba el índice: el plugin entra con
   `health.problems` y, si es grave (id que pisa a otro, manifiesto que
   miente sobre la versión), con `hidden`.
5. **GitHub**: estrellas, `archived`, issues abiertas, estado del último
   workflow de la rama principal, releases (novedades). Con el `GITHUB_TOKEN`
   del flujo; tope de llamadas por ejecución.
6. **Descargas**: `downloads/range/last-month/<a>,<b>,…` en lotes de 128 para
   los que no tienen scope y una por una para los de scope [12].
7. **Derivados**: nivel, insignias, `fits`/`presets`, popularidad (§5),
   `addedPermissions` entre versiones consecutivas, `reviewed` por
   `integrity`, `withdrawn`.
8. **Capturas**: oficiales, las de la galería recién pintada (ya en todos los
   idiomas del sitio); terceros, las de `docs/` del tarball, convertidas a
   WebP. (Fase 3: render propio, §9.)
9. **Salida**: `site/store/v1/…`, validada contra su esquema antes de
   publicar; si falla la validación, falla el job y sigue en línea el índice
   anterior (igual que hoy con la demo).
10. **Instantánea**: el mismo `index.json` se copia al paquete de Kiosko al
    publicar una versión (`packages/server/assets/store-index.json`), para el
    primer arranque sin red y para la demo del navegador.

**Cadencia**: diaria (cron a las 03:17 UTC, después de que npm procese las
descargas del día [12]), en cada push a `main` del monorepo y en cada fusión
en `plugin-index`. Un autor que publica ve su versión en la tienda en <24 h;
para que sea inmediato, puede pedirlo con un `workflow_dispatch` (fase 2, un
botón «Actualizar ficha» en un issue).

### 4.4 Cómo entra un plugin de terceros

Las dos vías, porque cubren cosas distintas:

1. **Solo palabra clave** → nivel *found* («Sin revisar»). Aparece en el
   buscador de la web y del editor, **no** en la portada ni en «Destacados»,
   y para instalarlo hay un paso más (§6.3). Es lo que ya da npm, y lo que la
   fase 1 cubre.
2. **PR a `plugin-index`** (añadir una línea a `listed.json`) → nivel
   *listed*. La Action del repo comprueba: el paquete existe, el autor del PR
   es mantenedor en npm o dueño del repo (como HACS, que exige que lo envíe
   el dueño [1]); hay manifiesto válido; `kiosko plugins check` pasa (se
   ejecuta en un job aislado, sin secretos, `permissions: {}`); licencia
   SPDX; repo público; nombre no confundible con otro listado (distancia de
   edición ≤ 2 → revisión humana). Con todo en verde, se fusiona (puede ser
   automático tras 48 h sin objeciones).
3. **Verificación** (nivel *verified*): un issue «Verificar» en
   `plugin-index`; un mantenedor de Kiosko revisa (a) la identidad: cuenta de
   GitHub con historial, la misma persona en npm, publicación con **trusted
   publishing** desde el repo público, que da procedencia automática [13]; y
   (b) el código de una versión concreta, y añade su `integrity` a
   `reviewed.json`. La insignia aparece en esa versión y en las siguientes
   **solo** si también se revisan; una versión nueva sin revisar se muestra
   «Verificado hasta 1.2.0».

## 5. Popularidad

### 5.1 Señales

| Señal | Peso | Por qué |
|---|---|---|
| Descargas de npm, **mediana de las últimas 4 semanas** de sumas semanales | Principal | Disponible, gratis, la misma para todos. La mediana ignora un pico (un bot, un mirror que baja una versión nueva, un script de alguien). |
| Estrellas de GitHub | 0,2 del total, en log | Señal de interés, fácil de inflar: poco peso. |
| Recencia (última versión) | Solo para etiquetas | Un plugin vivo; no se premia publicar por publicar. |
| Valoraciones (fase 4) | Separadas | No se mezclan en la popularidad: se enseñan aparte. |
| Instalaciones contadas por Kiosko | **No** | Ver §5.3. |

Puntuación (0–1): `score = 0,8 · log10(1+D)/log10(1+Dmax) + 0,2 ·
log10(1+S)/log10(1+Smax)`, con `D` la mediana de descargas, `S` las estrellas
y los máximos tomados entre los plugins *listed*/*verified*/*official*.

### 5.2 Lo que se muestra

- **No una nota 1–5 de popularidad** (se confunde con valoraciones). En su
  lugar, una etiqueta como mucho:
  - **Popular**: en el quintil superior de los listados y `D ≥ 50`.
  - **En alza**: mediana de las 2 últimas semanas ≥ 2 × la de las semanas 3–8,
    `D ≥ 20` y más de 14 días de vida.
  - **Nuevo**: primera versión hace menos de 30 días.
- La cifra, redondeada a escalones: «10+», «50+», «100+», «500+», «1 000+
  descargas/semana». Inflar 37 → 49 no se ve.
- Ordenación por defecto: «Destacados» (oficiales y verificados primero, luego
  `score`, y en el editor, los que caben en tus pantallas antes). Otras:
  «Más populares», «Recientes», «Nombre».

### 5.3 Contra el amaño y por qué no hay telemetría

- Mediana, escalones, y `popularityHold` en `overrides.json` para congelar a
  mano un plugin con descargas infladas. Las descargas de nuestra propia
  Action no cuentan apenas: los tarballs se bajan **una vez por versión**
  (caché por `integrity`).
- Las descargas de npm incluyen CI, mirrors y bots: son una señal relativa,
  no «usuarios». Se dice así en la ficha («descargas en npm, no
  instalaciones»).
- **Telemetría de instalaciones: no, en ninguna de las fases 1–5.** Kiosko es
  local y no rastrea (ya se decidió así para los afiliados, punto 9). Una IP
  dinámica puede ser dato personal cuando quien la recibe tiene medios
  legales para identificar a la persona (TJUE, *Breyer*, C-582/14 [23]), así
  que hasta un «ping anónimo» pide base legal, encargado del tratamiento y
  política. Home Assistant lo hace con consentimiento expreso y por niveles,
  publicando solo agregados [20]; si un día hiciera falta, el diseño sería
  ese: interruptor **apagado por defecto**, envío semanal de `{ids de plugin
  + versión mayor, versión de Kiosko, SO, clase de panel}` sin identificador,
  a una función que no guarda la IP y suma contadores, publicando solo cifras
  ≥ 20. Recomendación: no hacerlo salvo que las descargas de npm dejen de
  servir.

## 6. La tienda, en la web y en el editor

### 6.1 Web: `kioskolcd.dev/store/`

Páginas estáticas por idioma (`/store/`, `/es/store/`, `/zh-Hant/store/`…,
con `hreflang` como el resto del sitio) y una por plugin (`/store/<id>/`),
para que los buscadores las indexen; un script pequeño filtra en el cliente
sobre `index.json`. Sin cookies ni analítica.

Lista:

```
┌─ kioskolcd.dev/es/store/ ───────────────────────────────────────────────────┐
│ KIOSKO  Tienda de plugins                     [ Buscar plugins…          ] │
│                                                                             │
│ Categoría  [Todas ▾]   Panel [Barra 1920×462 ▾]   Sistema [Todos ▾]          │
│ Idioma [Español ▾]  Licencia [Todas ▾]  Precio [Gratis ▾]  ☑ Mi región      │
│ ☐ Mostrar sin revisar                         Ordenar: [Destacados ▾]       │
│                                                                             │
│ ┌──────────────────────────────┐ ┌──────────────────────────────┐          │
│ │ [captura 1920×462 ........ ] │ │ [captura 1920×462 ........ ] │          │
│ │ ☁ El tiempo   ✔ Oficial      │ │ 🎮 Gaming     ✔ Oficial      │          │
│ │ Previsión, radar, alertas    │ │ FPS, ventiladores, líquida   │          │
│ │ ▭ ▢ ◯ ▯  · 5 idiomas · MIT   │ │ ▭ ▢  · Linux Windows · MIT   │          │
│ │ Popular · 500+/sem · v0.2.1  │ │ Nuevo · v0.1.0               │          │
│ └──────────────────────────────┘ └──────────────────────────────┘          │
│ ┌──────────────────────────────┐ ┌──────────────────────────────┐          │
│ │ [captura]                    │ │ [captura]                    │          │
│ │ ⚡ Precio de la luz  ✔ Verif. │ │ 🐟 Acuario   ⚠ Sin revisar   │          │
│ │ PVPC por horas · Solo España │ │ Peces que nadan              │          │
│ └──────────────────────────────┘ └──────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘
  ▭ barra  ▢ cuadrado  ◯ redondo  ▯ vertical   (en qué clases de panel cabe)
```

Ficha:

```
┌─ kioskolcd.dev/es/store/weather/ ───────────────────────────────────────────┐
│ ☁ El tiempo                         ✔ Oficial  ✔ Procedencia  Popular       │
│ kiosko-plugin-weather · v0.2.1 · 17 nov 2026 · MIT · Kiosko (kiosko-lcd)    │
│                                                                             │
│ [◀ captura grande: tema Oscuro · Español · 1920×462 ▶]                      │
│ Tema [Oscuro|Papel|…]  Idioma [es|en|de|zh-Hant|zh-Hans]  Tamaño [mín|pref.] │
│                                                                             │
│ [ Abrir en Kiosko ]   o en un terminal:  kiosko plugins install kiosko-…    │
│                                                                             │
│ Widgets (4)           mín.      preferido   cabe en                         │
│  Previsión            240×120   480×200     ▭ ▢ ◯ ▯  Trofeo 9.16″, 480×480… │
│  Radar                320×240   600×462     ▭ ▢      (en ◯ se corta texto)  │
│ Interludios (1)       [▶ vídeo 8 s]                                         │
│ Plantillas (1)        «Tiempo» · barra, cuadrado                            │
│                                                                             │
│ Lo que hace en tu equipo                                                    │
│  🌐 Internet: api.open-meteo.com, el host que tú escribas                   │
│  ⚠ 1 opción conecta con una dirección que pones tú (radar.url)              │
│ Necesita: —     Usa si están: Calendario                                    │
│ Funciona en: Linux · macOS · Windows    Kiosko ≥ 0.2 (API ^0.2.0)           │
│ Idiomas: English, Español, Deutsch, 繁體中文, 简体中文                       │
│ Consumo: ~40 MB, CPU baja                                                   │
│                                                                             │
│ Versiones      0.2.1 (17 nov) Novedades…   0.2.0 (2 nov)   0.1.4 ⛔ retirada │
│ Soporte        Issues · Discusiones · Documentación    ♥ Apoyar al autor    │
│ Probado en     Trofeo 9.16″ (Linux) ✔ · 480×480 (Windows) ✔ 3 informes      │
│ Valoraciones   👍 38 · 👎 2 · 12 comentarios → GitHub          (fase 4)     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**«Abrir en Kiosko»**: un enlace normal a
`http://127.0.0.1:7420/#/plugins/store/weather` (navegación de primer nivel,
no `fetch`: no necesita CORS y el `Host` es el correcto). El editor abre la
ficha y **no instala nada sin un clic** del usuario (el servidor exige
`X-Kiosko: 1`, que una web ajena no puede enviar). Si Kiosko no está en
marcha o usa otro puerto, la página lo dice debajo del botón y ofrece el
comando. Un esquema propio (`kiosko://`) solo cuando exista el envoltorio de
escritorio (punto 5 de plan.md).

### 6.2 Editor: vista Plugins

Pestañas: **Instalados** (lo de hoy) · **Tienda** · **Actualizaciones**
(con contador). La tienda usa el índice en caché; si es de hace más de 7
días, lo dice («Catálogo del 3 nov, sin conexión»).

```
┌ Plugins ─────────────────────────────────────────────────────────────────────┐
│ [Instalados 21]  [Tienda]  [Actualizaciones 2]                               │
│                                                                              │
│ [ Buscar…                ]  Categoría [Todas ▾]  ☑ Cabe en mis pantallas     │
│ Tus pantallas: Barra 1920×462 (Linux) · Redonda 480×480                      │
│                                                                              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ ☁ El tiempo  ✔ Oficial  v0.2.1                         ✓ Instalado       │ │
│ ├──────────────────────────────────────────────────────────────────────────┤ │
│ │ 🎮 Gaming  ✔ Oficial  v0.1.0                         [ Instalar ]        │ │
│ │ ✔ Cabe en tus 2 pantallas · ✔ Linux · 🌐 ninguna · ▶ ejecuta: mangohud   │ │
│ ├──────────────────────────────────────────────────────────────────────────┤ │
│ │ 📈 Bolsa  ✔ Verificado  v1.3.0                       [ Instalar ]        │ │
│ │ ◐ Cabe en 1 de tus 2 (en la redonda se corta) · 🌐 query1.finance…       │ │
│ ├──────────────────────────────────────────────────────────────────────────┤ │
│ │ 🖥 Cosa  ⚠ Sin revisar  v0.0.3                       [ Instalar… ]       │ │
│ │ ✖ No funciona en Linux                                                   │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

La ficha del editor es la misma que la web (mismo componente de datos) y
añade, por cada pantalla del usuario, qué widgets caben y a qué tamaño.

### 6.3 Revisión de permisos antes de instalar

```
┌ Instalar «Bolsa» 1.3.0 ───────────────────────────────────────────────┐
│ De: ana-dev (✔ verificada) · MIT · procedencia: github.com/ana-dev/…   │
│                                                                        │
│ Un plugin es código que corre con tus permisos. Este dice que:         │
│  🌐 se conecta a  query1.finance.yahoo.com, api.coingecko.com          │
│  ⚠ 1 opción guarda un secreto (apiKey)                                │
│  ▶ no ejecuta programas · 📁 no lee ficheros · 🔌 sin dispositivos     │
│ Lo dice el autor; Kiosko no lo impide (aún no hay aislamiento).        │
│                                                                        │
│ También se instalará:  —                                               │
│ Cabe en:  Barra 1920×462 ✔   Redonda 480×480 ◐ (texto cortado)         │
│                                                                        │
│                                   [ Cancelar ]  [ Instalar 1.3.0 ]     │
└────────────────────────────────────────────────────────────────────────┘
```

Para un plugin *Sin revisar* el diálogo añade «Nadie de Kiosko ha mirado
este código» y la casilla «Entiendo el riesgo» antes de habilitar el botón.
Si tiene `requires` que faltan, se instalan con él (y sus permisos se suman en
el mismo diálogo). Un plugin retirado (`disable`) no se ofrece; con `warn`, se
dice por qué.

### 6.4 Actualizar con permisos nuevos

Hoy `installPlugin` calcula `addedPermissions` **después** de instalar. Con
el índice, el editor lo sabe antes (`releases[].addedPermissions`), así que
«Actualizar» pasa a ser:

```
┌ Actualizar «Logs» 0.3.0 → 0.4.0 ─────────────────────────────────┐
│ Esta versión pide algo más:                                      │
│  ▶ ejecutar: journalctl            (nuevo)                       │
│  📁 leer: /var/log                 (nuevo)                       │
│ Novedades: «Logs del sistema además de Docker»…                   │
│                       [ Ahora no ]  [ Aceptar y actualizar ]     │
└──────────────────────────────────────────────────────────────────┘
```

«Actualizar todos» salta las que piden permisos nuevos y las deja con su
botón. Si el índice no conoce la versión (un plugin sin listar recién
publicado), se mantiene el aviso de después como hoy.

## 7. Publicar, instalar, actualizar, dar soporte

### 7.1 El camino del autor

1. `kiosko plugins new <nombre>`: ya deja `keywords`, `files`, `kiosko.sdk`,
   `kiosko.manifest`. Añadir a la plantilla: `.github/workflows/release.yml`
   con **trusted publishing** a npm (OIDC, sin tokens; procedencia
   automática [13]) y `bugs`, `funding`, `license` rellenados.
2. `npm run kiosko:check` (`kiosko plugins check`): convenciones, pintado en
   varios tamaños/temas/idiomas, `round`, y (fase 3) `--resources`.
3. `kiosko plugins manifest`: escribe el manifiesto y las capturas (con la
   matriz de temas, idiomas y tamaños `min`/`preferred` si se pide
   `--shots all`).
4. Etiqueta `vX.Y.Z` → la Action publica en npm con procedencia y crea el
   release de GitHub (las novedades que lee la tienda).
5. Aparece como *Sin revisar* en <24 h. Para *Listado*: PR a
   `plugin-index`. Para *Verificado*: issue «Verificar».

`docs/plugins.md` («Publishing») gana una sección «In the store» con esto.

### 7.2 Niveles y qué garantiza cada uno

| Nivel | Requisito | Qué garantiza | Qué NO garantiza |
|---|---|---|---|
| **Oficial** | En `OFFICIAL_PLUGINS`, repo en `github.com/kiosko-lcd`, (fase 2) procedencia desde ese repo | Lo mantiene Kiosko | — |
| **Verificado** | Identidad comprobada + procedencia + `integrity` en `reviewed.json` | Una persona de Kiosko leyó **esa** versión | Las versiones siguientes sin revisar |
| **Listado** | PR aceptado, comprobaciones automáticas | Manifiesto honesto en forma, pinta sin romper, nombre no engañoso | Que el código haga solo lo que dice |
| **Sin revisar** | Palabra clave en npm | Nada | Nada |

Insignias adicionales: **Viene con Kiosko** (`bundled`), **Procedencia**
(atestación válida de npm [14] desde el repo declarado), **Probado en
<panel>** (§7.5), **Popular / En alza / Nuevo** (§5).

Pérdida de confianza automática: si una versión nueva llega **sin
procedencia** cuando las anteriores la tenían, o desde otro repositorio, el
índice la marca `provenanceLost` y el editor no la ofrece en «Actualizar
todos» (posible robo de cuenta).

### 7.3 Retirar

- El autor: `npm deprecate pkg@versión "mensaje"` [15] (el índice lo copia y
  el editor lo enseña) o una versión nueva.
- Kiosko: entrada en `withdrawn.json` (por rango y por `integrity`), con
  aviso de seguridad en `plugin-index`. El editor la consulta junto a las
  actualizaciones (diaria y al arrancar), y también se comprueba al cargar
  plugins con la última copia en caché. `hidden` en `overrides.json` lo quita
  de la tienda sin tocar a quien ya lo tiene.
- npm solo deja despublicar en 72 h [15]: la lista propia es necesaria.

### 7.4 Versiones y compatibilidad

- semver para el plugin; rango `kiosko.sdk` para la API (ya existe). El
  índice guarda, por versión, `sdk` y `platforms`; el editor elige con la
  lógica de `pickUpdate()` (la más nueva que cabe, sin prereleases), ahora
  también saltando retiradas y marcando las que piden permisos nuevos.
- **Instalar fija versión exacta**: `npm install pkg@1.3.0 --save-exact
  --ignore-scripts`, y después se compara el `integrity` de
  `node_modules/.package-lock.json` con el del índice; si no coincide, se
  desinstala y se avisa (eso cubre un índice o un registro manipulados).
- La vuelta atrás que ya existe se mantiene.

### 7.5 Soporte e informes de compatibilidad

- Cada ficha enlaza `support.issues`/`discussions`/`docs` del autor; la
  tienda no es el canal de soporte.
- «¿Funciona en tu panel?» en el editor: abre un issue prellenado en
  `plugin-index` (formulario `compatibilidad.yml`: plugin@versión, modelo de
  panel o resolución, SO, versión de Kiosko, sí/no, nota) con los datos que el
  editor ya sabe, **sin enviarlos él**: el usuario ve y envía el formulario
  desde su cuenta de GitHub. El constructor agrega por (plugin, versión mayor,
  preset, SO) y da «Probado en Trofeo 9.16″ (Linux) ✔ · 3 informes». Un
  informe negativo con una versión antigua no tapa uno positivo con la nueva.

## 8. Plugins de pago (futuro)

### 8.1 Opciones

| Opción | Cómo | Pros | Contras |
|---|---|---|---|
| **A. Merchant of record (MoR)** (Stripe Managed Payments, Paddle, Polar) | El MoR vende al cliente, cobra y liquida IVA/impuestos de cada país; tú le facturas a él. | Sin IVA OSS ni impuestos extranjeros por tu cuenta; reembolsos, fraude y contracargos los lleva él. Managed Payments: negocios en España admitidos, software descargable como categoría admitida, cliente en 195+ países (no China ni Rusia) [17]. | Comisión mayor que una pasarela (Paddle 5 % + 0,50 $ [18]; Polar se anuncia a 4 % + 0,40 $ [19], con informes de subidas). Managed Payments **no** admite Connect ni vender a través de una plataforma de terceros [17]. |
| **B. Pasarela + Stripe Tax** | Tú eres el vendedor. | Comisión menor (~2,9 % + 0,30 $ según comparativas [18]). | Tú declaras IVA de destino (OSS) por encima de 10 000 € anuales B2C en la UE [21] y lo que pida cada país fuera; tú gestionas contracargos. |
| **C. Gumroad / similares con licencias** | Tienda alojada con claves de licencia y API de verificación [22]. | Rápido, sin código. | Licencias que se comprueban **en línea** contra su API; dependencia del servicio. |
| **D. Lemon Squeezy** | — | — | **Cierra el 31 de marzo de 2027 y no admite altas** [16]. Descartado. |
| **E. Patrocinio** (GitHub Sponsors, `funding`) | Donaciones. | Cero fricción, nada que proteger. | No es vender; ingreso incierto. |

### 8.2 Entregar el código de pago

| Forma | Cómo | Valoración |
|---|---|---|
| **Abierto con licencia** (*open core* / honor) | El paquete está en npm como todos; los widgets «pro» comprueban una licencia firmada. | **Recomendada.** Se revisa igual que los demás (puede ser *Verificado*), se instala por el mismo camino, funciona sin red. Se puede saltar parcheando: en JavaScript local siempre se puede. |
| Tarball con licencia | `npm install <url-firmada>` desde el servidor del vendedor; el índice lleva el `integrity`. | Posible más adelante para quien lo quiera; complica actualizaciones y revisión. |
| Registro privado (npm de pago, GitHub Packages) | Token por cliente. | Descartado: GitHub Packages exige token incluso para paquetes públicos [24]; repartir tokens de registro a usuarios finales no escala. |

### 8.3 Recomendación

1. **Primero, solo plugins oficiales de pago** (si los hay), vendidos por ti
   con **Stripe Managed Payments** como MoR [17] y **licencias firmadas
   Ed25519** que emite una función pequeña (webhook de pago → firma `{plugin,
   compra, emitida, versiones mayores cubiertas}`) y que Kiosko comprueba
   **sin red** con la clave pública que va en el índice y en el propio
   plugin. Alternativa si Stripe no te admite: Polar, que trae claves de
   licencia propias [19].
2. **Terceros**: cada autor trae su MoR y su emisor de licencias (se le da
   una plantilla); la tienda solo muestra precio, enlace de compra y clave
   pública. **Kiosko no cobra ni reparte dinero**: así no es un marketplace,
   no choca con las condiciones de Managed Payments [17] y no entra en DAC7,
   que obliga a las plataformas a identificar e informar de sus vendedores
   [25]. Comisión 0 % al principio.
3. **Antes de vender nada**, prueba gratuita o modo limitado sin caducidad,
   y precios en EUR con IVA incluido en la ficha.

### 8.4 Qué construir ya para no rehacer

Solo datos, nada de cobro:

- `pricing` en el manifiesto (solo `free` aceptado) y en el índice (ya en el
  esquema de §3.5: `model`, `price` en céntimos, `checkout`, `seller`,
  `licenseKey`).
- Filtro «Gratis / De pago» y la etiqueta «Gratis» en las tarjetas (hoy todas).
- `funding` → «Apoyar al autor» (ya es útil hoy).
- Publicador como entidad (`publisher` con `github`/`npm`/`verified`): es a
  quien se le paga mañana.
- En el SDK, **nada** todavía. Cuando toque: `ctx.license?.(pluginId)` que
  devuelve `{ valid, tier, until? }` comprobando la firma en local.

### 8.5 Notas legales y fiscales (persona física en España/UE; no es asesoría)

- **Alta**: vender de forma habitual es actividad económica: declaración
  censal (modelo 036) y, por lo general, alta en autónomos; consultar con un
  gestor el caso de ingresos pequeños. Con IVA: el 036 recoge también la
  opción de tributación en destino [21].
- **IVA de servicios electrónicos a consumidores de la UE**: hasta 10 000 €
  anuales de ventas B2C a otros Estados miembros, IVA español; por encima,
  IVA del país del cliente, declarado en la ventanilla única (régimen de la
  Unión; alta con el modelo 035, declaración trimestral en el 369) [21].
  Con un MoR esto lo hace él: tú le facturas a él (operación entre empresas).
- **Desistimiento**: el consumidor tiene 14 días, salvo contenido digital sin
  soporte material cuya ejecución empiece con su **consentimiento expreso y
  su reconocimiento** de que pierde ese derecho, confirmados en un soporte
  duradero (art. 16.m y 7 de la Directiva 2011/83/UE) [28]. Si el plugin se
  vende como servicio (suscripción), ese atajo puede no valer [28]. Managed
  Payments aplica los periodos de desistimiento y puede reembolsar en 60 días
  [17].
- **Conformidad y actualizaciones**: la Directiva (UE) 2019/770 obliga al
  vendedor a informar y suministrar las actualizaciones (también de
  seguridad) necesarias para mantener el contenido conforme durante el
  periodo debido [29]. Vender un plugin implica mantenerlo compatible con las
  versiones de Kiosko durante un tiempo razonable: decirlo en las condiciones.
- **Reseñas** (fase 4): si se alojan contenidos de usuarios, se es prestador
  de alojamiento: hace falta un mecanismo de notificación y acción (art. 16
  DSA), del que las micro y pequeñas empresas no están exentas, aunque sí de
  otras obligaciones de plataformas (art. 19) [30]. Con Discussions, la
  plataforma es GitHub y nosotros enlazamos.

### 8.6 Lo que Kiosko no hará nunca

- DRM que llame a casa en cada arranque o cada día; licencias que dejen de
  funcionar sin red o si el vendedor cierra (la licencia firmada vale para
  siempre en las versiones que cubre).
- Desactivar a distancia un plugin **por motivos de pago** (la lista de
  retiradas es solo para seguridad, y es pública).
- Código ofuscado que impida revisar qué hace: un plugin de pago se revisa
  como cualquiera, o no tiene insignia.
- Telemetría para licencias, anuncios en el panel, o vender datos.
- Cobrar por lo que hoy es gratis, o recortar un plugin oficial gratuito
  para empujar al de pago.

## 9. Seguridad y privacidad

### 9.1 Cadena de suministro

- **Lo que hay**: `--ignore-scripts`; un solo fichero empaquetado por plugin;
  permisos declarados y mostrados; vuelta atrás; `Host` + `X-Kiosko`.
- **Lo que se añade**:
  1. *Procedencia*: oficiales publicados con trusted publishing [13]; la
     tienda comprueba la atestación (lo mismo que `npm audit signatures`
     [14]) y que el repo de la atestación es el declarado.
  2. *Integridad fijada*: versión exacta + `integrity` del índice
     comprobado tras instalar (§7.4).
  3. *Índice y retiradas firmados* (Ed25519, `node:crypto` lo verifica sin
     dependencias): la clave privada en un secreto del entorno de Pages, la
     pública en Kiosko. Protege si se secuestra el dominio o la cuenta de
     Pages. Rotación: Kiosko lleva la clave actual y la siguiente.
  4. *Análisis estático* en el PR de alta (fase 2): `kiosko plugins audit`
     busca en el `dist` usos de `child_process`, `net`, `http(s)`, `fs`,
     `eval`/`Function`, `process.env` y los cruza con `permissions`; un uso no
     declarado no bloquea, pero lo manda a revisión humana y sale en la ficha
     («usa la red sin declararlo»).
  5. *Dependencias*: el índice cuenta las `dependencies` de cada versión; un
     plugin *Verificado* no puede tener dependencias sin revisar.
  6. *Nombres parecidos*: aviso en PR de alta y en el buscador («¿Querías
     kiosko-plugin-weather?»).
- **Honestidad sobre el aislamiento**: un plugin corre en el proceso de
  Kiosko (o en el hilo de una pantalla, que no es un aislamiento) con los
  permisos del usuario. Los permisos son **una declaración, no una valla**, y
  la tienda lo dice en cada diálogo de instalación. El modelo de permisos de
  Node (`--permission`) se aplica al proceso entero, no a un plugin [31]:
  aislar de verdad pediría un proceso por plugin con su propia política
  (como ya hace `doom` con su motor), y queda fuera de este plan.
- **Las capturas de terceros no se generan ejecutando su código en la fase
  1** (se usan las que trae el paquete); en la fase 3, el render propio va
  en un job aparte, sin secretos, `permissions: {}`, sin caché compartida, con
  tiempo límite y sin red salvo el registro.

### 9.2 Privacidad

- El editor baja `index.json` y `withdrawn.json` de GitHub Pages (que, como
  cualquier servidor, ve la IP; no tenemos acceso a esos registros y no
  añadimos nada). Respeta el proxy y la configuración de npm (registro
  espejo, p. ej. en China). `KIOSKO_NO_UPDATE_CHECK=1` también apaga la
  tienda en línea (queda la instantánea).
- La web de la tienda: sin cookies, sin analítica, sin recursos de
  terceros (las capturas se sirven desde el propio dominio).
- Reseñas en GitHub: los datos los trata GitHub; el índice copia solo
  recuentos, no nombres ni textos. Si un día hay cuentas propias: mínimo
  imprescindible (identificador de GitHub, sin email), base legal contrato o
  consentimiento, borrado a petición, política de privacidad y aviso de
  notificación y acción [30].

## 10. Plan por fases

Estimaciones en días de una persona que conoce el monorepo. Cada fase se
puede publicar sola.

### Fase 0: manifiesto preparado (1,5 días)

- `packages/sdk/src/plugin.ts`: `markets`, `support`, `pricing`,
  `resources`, `category` de plugin, `preview` de interludio (tipos + docs).
- `packages/core/src/plugin-meta.ts`: copiarlos al manifiesto (y `bugs`,
  `funding` de package.json); `screenshots[]`.
- `packages/core/src/plugin-lint.ts`: validar `markets` (ISO 3166), licencia
  SPDX (`spdx-expression-parse` ya viene con npm; si no, una lista corta),
  `pricing.model === 'free'`.
- `packages/core/schema/manifest.json` (nuevo): JSON Schema del manifiesto,
  generado desde los tipos o escrito a mano y probado contra los manifiestos de los oficiales.
- Plantilla de `kiosko plugins new`: `bugs`, `funding`, workflow de release
  con trusted publishing.
- Pruebas: `plugin-meta.test.ts` (campos nuevos), un test que valida los
  `kiosko-manifest.json` de los oficiales clonados contra el esquema.
- Riesgo: ninguno (aditivo). Volver a generar y publicar los manifiestos de
  los oficiales.

### Fase 1: MVP (≈ 8–9 días)

Alcance: índice estático con oficiales + encontrados por palabra clave;
tienda web (lista, filtros, ficha); catálogo en el editor con instalación de
un clic y revisión de permisos. Insignias: solo «Oficial» y «Viene con
Kiosko». Popularidad: solo la cifra de descargas en escalones. Sin
`plugin-index` todavía (los terceros son todos *Sin revisar*), sin firmas,
sin valoraciones.

**1a. Índice y web (≈ 4,5 días)**

| Fichero | Qué |
|---|---|
| `packages/core/src/store/types.ts` | Tipos `StoreIndex`, `StorePlugin`, `StoreRelease` (los del esquema). |
| `packages/core/src/store/build.ts` | Funciones puras: `entryFrom({ packument, manifest, pkg, downloads, github, official })`, `pickReleases`, `tierOf`, `downloadsBucket`, `addedPermissions` entre versiones (mover la de `plugins-manage.ts` a core). |
| `packages/core/src/store/fit.ts` | `panelClass()`, `fitsScreen()`, `fitsPresets()`. |
| `packages/core/src/config/model.ts` | `shape` en `PanelPreset` (`round-480`). |
| `packages/core/src/store/tar.ts` | Lector de tar.gz en streaming que extrae solo rutas permitidas (sin dependencias: `node:zlib` + parser de cabeceras ustar de ~80 líneas). |
| `packages/core/schema/store-index.json` | El esquema de §3.5. |
| `scripts/store/build-index.ts` | Orquesta: búsqueda npm, packuments, tarballs (caché por `integrity`), descargas, GitHub (estrellas, archivado), capturas de la galería, escribe `site/store/v1/`. Valida antes de escribir. |
| `packages/web/build.mjs` / `landing/build.mjs` | Llamar al constructor tras la galería; copiar esquema. |
| `packages/web/landing/store.mjs` + `store.ts` + `i18n/*` | Páginas `/store/` y `/store/<id>/` por idioma (con `offered()` de `languages.ts`), script de filtros, textos en en/es/de/zh-Hant/zh-Hans. |
| `.github/workflows/pages.yml` | `schedule` diario, caché de tarballs, clonar también los opcionales para pintarlos (hoy solo clona los 16 incluidos). |
| `scripts/demo-check.mjs` | Abrir `/store/` y una ficha en Chromium. |

Pruebas: `store/build.test.ts` (packuments y manifiestos de juguete: sin
manifiesto, manifiesto inválido, id que no coincide, prerelease ignorada,
deprecated copiado), `store/fit.test.ts` (cada preset en su clase; widgets
que caben y no), `store/tar.test.ts` (rechaza `..`, enlaces, tamaño), un test
que valida un índice generado contra el esquema, `landing/store.test.ts`
(páginas por idioma, `zh-Hans` sin `agents`, `hreflang`).

**1b. Editor (≈ 4 días)**

| Fichero | Qué |
|---|---|
| `packages/server/src/store.ts` | `loadStore()`: instantánea empaquetada → caché en `cacheDir` → red (ETag, tiempo límite, sin quejarse sin red); refresco al arrancar y diario (mismo temporizador que las actualizaciones); URL configurable (`store.url`). |
| `packages/server/src/server.ts` | `GET /api/store` (índice + `installed`, `platform`, `sdk`), `GET /api/store/:id` (ficha, bajo demanda y cacheada), `POST /api/store/refresh`. |
| `packages/server/src/plugins-manage.ts` | `installPlugin(spec, { expectIntegrity })`: `--save-exact`, comprobación de `integrity` en `node_modules/.package-lock.json`, desinstalar si no coincide. |
| `packages/server/assets/store-index.json` + script de release | Instantánea al publicar Kiosko. |
| `packages/web/src/views/Plugins/` (partir `Others.tsx`) | `Installed.tsx` (lo de hoy), `Store.tsx` (lista, filtros, «cabe en mis pantallas»), `StoreSheet.tsx` (ficha), `InstallDialog.tsx` (permisos, requisitos, casilla para *Sin revisar*). La sección «Oficiales opcionales» de hoy desaparece: son tarjetas de la tienda. |
| `packages/web/src/store.ts` | Ruta `#/plugins/store/<id>`. |
| `packages/web/src/i18n.ts` | Textos nuevos en los 5 idiomas. |
| Demo del navegador | Tienda navegable con la instantánea; instalar desactivado con `DemoNote`. |

Pruebas: `store.test.ts` del servidor (caché, ETag, sin red → instantánea,
índice corrupto → el anterior), `plugins-manage.test.ts` (integrity que no
coincide → desinstala y error), test del cálculo «cabe en tus pantallas»
con una config de ejemplo (barra + redonda).

Riesgos de la fase 1: la Action de Pages se alarga (caché, y separar job si
pasa de ~15 min); plugins de terceros con manifiestos malos (se ven con
`problems`, no rompen); un tercero malicioso encontrado por palabra clave
(mitigación: «Sin revisar» + casilla + fuera de destacados; y retirarlo a
mano con un `hidden` provisional en el propio monorepo hasta que exista
`plugin-index`).

### Fase 2: confianza (≈ 8 días)

- Repo `kiosko-lcd/plugin-index` con `listed.json`, `publishers.json`,
  `reviewed.json`, `withdrawn.json`, `overrides.json`, `tags.json`, sus
  esquemas, plantillas de issue y `check.yml` (valida JSON; en PR de alta,
  baja el paquete, ejecuta `kiosko plugins check` y `audit` en un job
  aislado; comprueba que el autor del PR es mantenedor). `repository_dispatch`
  al monorepo al fusionar.
- Niveles *listed*/*verified*, insignias «Verificado» (por `integrity`) y
  «Procedencia»; `provenanceLost`.
- `withdrawn.json` + consulta diaria en el editor; no cargar versiones
  `disable` en `packages/core/src/registry.ts`, con anulación explícita.
- Firma Ed25519 de `index.json` y `withdrawn.json`; verificación en
  `server/src/store.ts`; clave pública en `packages/server/src/store-keys.ts`.
- Permisos nuevos **antes** de actualizar (§6.4) en `Others.tsx`/`Updates` y
  en el servidor (`/api/plugins/update` comprueba `addedPermissions` del
  índice y exige `acceptPermissions: true`).
- `kiosko plugins audit` (análisis estático del `dist`) en `plugins-cli.ts`.
- Oficiales a trusted publishing (workflow de release en cada repo
  `kiosko-plugin-*`; dejar de publicar a mano con 2FA).
- Pruebas: verificación de firma (buena, mala, clave rotada), retirada por
  rango y por `integrity`, `provenanceLost`, `audit` con fixtures.
- Riesgos: quién revisa y cuánto tarda (HACS tarda meses [1]); la clave de
  firma (secreto en un entorno protegido de GitHub, con revisores).

### Fase 3: popularidad, compatibilidad y capturas propias (≈ 7 días)

- Popularidad completa (§5): `downloads/range`, mediana, escalones,
  etiquetas, `score`, `popularityHold`; estrellas con peso 0,2.
- Salud: CI, issues, archivado, última versión; aviso «sin versiones desde
  hace más de un año».
- Informes de compatibilidad: formulario en `plugin-index`, botón «¿Funciona
  en tu panel?» en el editor (abre el formulario prellenado), agregación e
  insignia «Probado en».
- Render propio en job aislado: matriz por tema (3), idioma (los del plugin,
  máx. 5) y tamaño (`min`, `preferred`, y un preset de cada clase), en WebP;
  vídeos de interludio (ffmpeg, 8 s, ≤ 1 MB).
- Comprobación de corte en redondo en `kiosko plugins check` (`round`).
- `kiosko plugins check --resources` (punto 26) → `resources` medido.
- Riesgos: tiempo de la Action y tamaño del sitio (límite de 1 GB [27]);
  ejecutar código de terceros en CI (aislado, sin secretos).

### Fase 4: valoraciones (≈ 4 días)

- Repo `kiosko-lcd/plugin-reviews` con Discussions; categoría «Reseñas», una
  discusión por plugin listado, creada por la Action (título = paquete,
  cuerpo = enlace a la ficha). 👍/👎 en el cuerpo = recomendación;
  comentarios = reseñas.
- El constructor lee por GraphQL los recuentos y los pone en `reviews`; la
  ficha muestra «Recomendado por el 92 % (38)» a partir de 5 votos, y enlaza.
  En la web, opcionalmente giscus (comentarios de GitHub Discussions
  incrustados, sin rastreadores propios [32]); en el editor, solo el enlace.
- Normas de la comunidad, enlace «Denunciar» (notificación y acción, art. 16
  DSA [30]), moderación con las herramientas de GitHub.
- Riesgos: público no técnico sin cuenta de GitHub (asumido; cuentas propias
  solo si se demuestra necesario).

### Fase 5: pago (≈ 12–15 días + trámites)

- Requisitos previos: alta fiscal, cuenta de Stripe con Managed Payments
  aprobada (o Polar), condiciones de venta, política de reembolsos y de
  privacidad.
- `pricing` completo en manifiesto e índice; precio en la ficha; botón
  «Comprar» → checkout del vendedor.
- Formato de licencia (`kiosko-license-v1`: JSON firmado Ed25519 con
  plugin, versiones mayores, id de compra, fecha) y verificación en el SDK
  (`ctx.license`), en la vista Plugins (pegar o arrastrar la licencia, que se
  guarda en `dataDir`), y en `plugins check` (un plugin de pago debe
  funcionar en modo limitado sin licencia).
- `kiosko-license-issuer` (repo plantilla): función que recibe el webhook del
  MoR y devuelve la licencia por email/página de éxito. Una instancia para los
  oficiales.
- Pruebas: firma, licencia de otra versión mayor, sin red, reloj desajustado
  (no se usa el reloj para invalidar).
- Riesgos: legales y fiscales (§8.5), soporte a compradores, expectativas de
  actualización (Directiva 2019/770 [29]).

### Fase 6 (no recomendada): telemetría voluntaria

Solo si las descargas de npm dejan de servir. Diseño en §5.3.

### Resumen de esfuerzo

| Fase | Días | Se puede publicar sola |
|---|---|---|
| 0 Manifiesto | 1,5 | Sí |
| 1a Índice + web | 4,5 | Sí |
| 1b Editor | 4 | Sí (requiere 1a) |
| 2 Confianza | 8 | Sí |
| 3 Popularidad, compatibilidad, capturas | 7 | Sí |
| 4 Valoraciones | 4 | Sí |
| 5 Pago | 12–15 | Sí |

## 11. Preguntas abiertas

1. **Dónde vive el índice**: ¿en el flujo de Pages del monorepo más un repo
   de datos `plugin-index` (lo propuesto), o todo en `plugin-index` con su
   propio subdominio?
2. **Los «Sin revisar»**: ¿se ven en la tienda por defecto (marcados y fuera
   de destacados, lo propuesto), o solo tras activar «Mostrar sin revisar»,
   o no se ven hasta que estén listados (como HACS y Obsidian)?
3. **Revisión**: ¿quién revisa para «Verificado», con qué plazo y con qué
   lista de comprobación? ¿Solo tú al principio?
4. **Trusted publishing para los oficiales**: implica publicar desde GitHub
   Actions y no a mano con 2FA. ¿De acuerdo?
5. **Telemetría**: confirmar que no (ni voluntaria) en las fases 1–5.
6. **Reseñas**: ¿repo central `plugin-reviews` (propuesto) o las Discussions
   de cada repo de plugin? ¿Hacen falta en el editor o solo en la web?
7. **Pago**: ¿habrá plugins oficiales de pago, o el pago es solo para
   terceros? ¿Te darías de alta para vender con Stripe Managed Payments?
   ¿Comisión 0 % para terceros?
8. **Región**: ¿un ajuste `region` explícito en el editor, o deducirla del
   idioma y la localidad?
9. **China**: GitHub Pages y npm pueden ir mal desde China continental.
   ¿Espejo del índice (p. ej. en un CDN chino) y respetar `registry` de npm
   (npmmirror)? Ver [estudio-chino.md](estudio-chino.md).
10. **Instantánea en el instalador de Windows**: ¿se incluye el índice con
    capturas pequeñas (unos MB) o solo el JSON?
11. **Nombre y ruta**: `/store/` y «Tienda» (propuesto), o `/plugins/` y
    «Plugins», que no suena a pagar.
12. **Pantallas redondas**: ¿añadimos `shape: 'round'` a `Screen` y a los
    presets (propuesto), y un aviso al soltar un widget que se corta?
13. **Plugins personales** (gitlab con tus alias, horas): ¿se ocultan de la
    tienda con `hidden` o se publican sin palabra clave?

## Fuentes

1. HACS, «Include default repositories»: https://hacs.xyz/docs/publish/include/
2. Obsidian Developer Docs, «Submit your plugin»: https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin
3. VS Code, «Publishing Extensions» (editor verificado, prerelease): https://code.visualstudio.com/api/working-with-extensions/publishing-extension
4. Open VSX wiki, «Namespace Access»: https://github.com/eclipse/openvsx/wiki/Namespace-Access
5. Microsoft, «Security and Trust in Visual Studio Marketplace» (11 jun 2025): https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace/
6. VS Code, «Extension runtime security»: https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security
7. Raycast, «Publish an Extension»: https://developers.raycast.com/basics/publish-an-extension
8. Chrome for Developers, «Permission warnings» (actualizaciones con permisos nuevos): https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings
9. Elgato, «Revenue share» y «Become a Maker»: https://docs.elgato.com/monetization/revenue-share · https://docs.elgato.com/general/become-a-maker
10. Grafana, «Sign a plugin» (niveles de firma): https://grafana.com/docs/grafana/latest/administration/plugin-management/plugin-sign/ y política: https://grafana.com/legal/plugins/
11. npm registry API, `/-/v1/search`: https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md
12. npm, «Download counts»: https://github.com/npm/registry/blob/main/docs/download-counts.md
13. npm Docs, «Trusted publishing for npm packages»: https://docs.npmjs.com/trusted-publishers · «Generating provenance statements»: https://docs.npmjs.com/generating-provenance-statements
14. npm Docs, «Verifying registry signatures» (`npm audit signatures`): https://docs.npmjs.com/verifying-registry-signatures/ · «Viewing package provenance»: https://docs.npmjs.com/viewing-package-provenance/
15. npm Docs, «npm Unpublish Policy» (72 h, deprecate): https://docs.npmjs.com/policies/unpublish/
16. Lemon Squeezy, portada (cierre el 31 mar 2027, sin altas; migración a Managed Payments): https://www.lemonsqueezy.com/
17. Stripe, «Managed Payments» y «Eligibility» (países, productos, sin Connect, venta directa, reembolsos): https://docs.stripe.com/payments/managed-payments · https://docs.stripe.com/payments/managed-payments/eligibility
18. Paddle, precios: https://www.paddle.com/pricing · comparativa Stripe/Paddle: https://www.paddle.com/stripe-vs-paddle
19. Polar, «Announcing Polar v1.0 with Lower Fees» y documentación: https://polar.sh/blog/polar-v1-0-lower-fees · https://polar.sh/docs
20. Home Assistant, integración Analytics (voluntaria, por niveles, agregados públicos): https://www.home-assistant.io/integrations/analytics/ · https://analytics.home-assistant.io/
21. Agencia Tributaria, «Regímenes especiales de ventanilla única» y cuestiones generales de IVA en comercio electrónico (umbral de 10 000 €, modelos 035/369, 036): https://sede.agenciatributaria.gob.es/Sede/iva/iva-comercio-electronico/regimenes-especiales-ventanilla-unica.html · https://sede.agenciatributaria.gob.es/Sede/iva/iva-comercio-electronico/cuestiones-generales.html · Comisión Europea, OSS: https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en · Your Europe: https://europa.eu/youreurope/business/taxation/vat/vat-digital-services-moss-scheme/index_es.htm
22. Gumroad, «License keys»: https://gumroad.com/help/article/76-license-keys
23. TJUE, asunto C-582/14 *Breyer* (19 oct 2016), comunicado: https://curia.europa.eu/jcms/jcms/p1_236867/cs · resumen: https://www.insideprivacy.com/international/cjeu-confirms-dynamic-ip-addresses-to-be-personal-data/
24. GitHub Docs, «Working with the npm registry» (token también para paquetes públicos): https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry
25. DAC7, Directiva (UE) 2021/514 (obligaciones de los operadores de plataformas): https://www.belastingdienst.nl/wps/wcm/connect/en/business/content/information-for-platform-operators-dac7 · https://revenue.ie/en/companies-and-charities/international-tax/aeoi/dac7/reporting.aspx
26. Steamworks, «Workshop Implementation Guide»: https://partner.steamgames.com/doc/features/workshop/implementation
27. GitHub Docs, «GitHub Pages limits»: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
28. Directiva 2011/83/UE, art. 16: https://www.legislation.gov.uk/eudr/2011/83/article/16 · resumen en EUR-Lex: https://eur-lex.europa.eu/EN/legal-content/summary/consumer-information-right-of-withdrawal-and-other-consumer-rights.html · caso Sky Austria (servicios): https://www.williamfry.com/knowledge/world-consumer-rights-day-part-2-reshaping-online-subscription-rights-the-sky-austria-case/
29. Directiva (UE) 2019/770 (contenidos y servicios digitales): https://eur-lex.europa.eu/eli/dir/2019/770
30. Reglamento de Servicios Digitales (DSA), art. 16 y 19, y la excepción de micro y pequeñas empresas: https://commission.europa.eu/strategy-and-policy/priorities-2019-2024/europe-fit-digital-age/digital-services-act_en · https://www.akos-rs.si/en/digital-services/explore/for-service-providers/translate-to-english-izjeme-za-mikro-in-majhne-ponudnike
31. Node.js, «Permissions»: https://nodejs.org/api/permissions.html
32. giscus: https://giscus.app/ · https://github.com/giscus/giscus
