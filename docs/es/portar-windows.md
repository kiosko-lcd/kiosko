# Portar Kiosko a Windows: estudio

Fecha: 2026-11-11. Estado: estudio, nada implementado. No se ha probado nada en
Windows; lo que sigue sale de leer el código y de la documentación de las
dependencias, y está marcado donde es una suposición.

## 1. Resumen

Hay **dos mitades** y están en puntos muy distintos:

| Mitad | Estado en Windows | Esfuerzo |
|---|---|---|
| Editor, servidor, compositor, plugins sin hardware | **Casi hecho.** El código ya contempla `win32` (rutas, `npm.cmd`, junctions, `schtasks`, `cmd /c start`). El CI ya corre en `windows-latest` × Node 22/24, incluido el empaquetado y `kiosko render`. | Pequeño: pulir y verificar |
| Enviar fotogramas al panel USB | **No existe.** Hoy depende de `trcc serve` (Python, Linux) o de `contrib/usb-sender/kiosko-sender.py` (Python + módulos privados de `trcc` + sysfs). | Grande: es el trabajo real |

Camino recomendado: (1) validar la mitad fácil en un Windows de pruebas en
Docker; (2) escribir un **driver USB propio en Node** (`@kiosko/usb-ly`),
que es además el punto del roadmap («talk to the panel over USB from Node
itself»), y que sirve igual en Linux y macOS; (3) instalador.

## 2. Lo que ya funciona (por lectura del código)

- `packages/core/src/paths.ts`: `%APPDATA%\Kiosko`, `KIOSKO_HOME`.
- `packages/server/src/service.ts`: tarea programada `Kiosko` al iniciar sesión
  (`schtasks`). Ojo: ejecuta `node.exe`, así que sale una **ventana de consola**
  (el comentario dice «hidden window» pero el plan no lo consigue; ver §4).
- `server.ts` / `plugins-cli.ts`: `npm.cmd` con `shell: true`, junction en vez
  de symlink.
- `cli.ts`: abre el navegador con `cmd /c start`.
- `@napi-rs/canvas` publica binarios `win32-x64-msvc` y `win32-arm64-msvc`
  (están en `package-lock.json`); las fuentes van empaquetadas, así que el
  fotograma debería ser idéntico píxel a píxel.
- `plugin-system`: `SYSTEM_ROOT = C:\`, sin `loadavg` en Windows, `os.freemem()`
  como alternativa a `/proc/meminfo`.
- `plugin-gpu`: `nvidia-smi` con `windowsHide: true`.
- `config.json` con `chmod 0600`: en Windows `chmod` casi no hace nada (solo
  el bit de solo lectura) y no falla; **no protege los tokens**. Hay que decirlo
  en la documentación o proteger el fichero con ACL (`icacls`).

## 3. Problemas concretos detectados en el código

Ordenados por gravedad. Ninguno está verificado en Windows.

1. **Panel USB**: ver §5. Bloqueante para el uso real.
2. **`expandPath`** (`core/src/paths.ts`): solo expande `~/` y `$VAR`; `~\x` y
   `%VAR%` no. Barato de arreglar. Lo mismo en `plugins/core` y `plugins/legacy`,
   que reimplementan `~/` por su cuenta (debería usar una sola función).
3. **Ejecutar CLIs instaladas con npm** (`ccusage`, `glab`, `trcc`…):
   `execFile('ccusage')` en Windows **falla con ENOENT** si es un shim `.cmd`
   (así se instalan los paquetes npm globales). Hay que resolver con `where`/
   `PATHEXT` o usar `shell: true` (con cuidado de inyección; los argumentos son
   fijos pero `bin` es configurable, riesgo `exec`). Afecta a `usage`,
   `gitlab` y `timesheet`. `glab` y `docker` son `.exe`, esos sí funcionan.
4. **`paths.cache()`** devuelve `null` sin `/dev/shm` ni `XDG_RUNTIME_DIR`:
   en Windows no hay caché en RAM y los plugins que dependen de ella caen al
   disco o no cachean. Decidir: ¿`%LOCALAPPDATA%\Kiosko\cache` o desactivado?
   (El motivo de la RAM era no desgastar el SSD; en Windows sería asumir ese
   desgaste, o usar un RAMDisk, que no merece la pena.)
5. **Servicio sin ventana**: o se lanza con `wscript`/`powershell -WindowStyle
   Hidden`, o se publica un `kiosko-tray.exe`/`kiosko.cmd` que arranque con
   `windowsHide`. Además `schtasks /Create … /TR cmd` tiene un límite de 261
   caracteres y problemas de comillas con rutas con espacios (típico en
   `C:\Program Files\nodejs\`). Mejor un `.xml` de tarea o una clave
   `HKCU\...\Run`.
6. **Plugin `system`/`vitals`**: sin `/sys/class/hwmon` no hay temperaturas de
   CPU. En Windows no hay API nativa fiable sin driver (LibreHardwareMonitor,
   WMI `MSAcpi_ThermalZoneTemperature` suele dar datos inútiles). Aceptar que
   falte o consumir el servidor web de LibreHardwareMonitor. `systemctl
   --failed` ya está protegido por plataforma; verificar.
7. **`kiosko-plugin-calls`** es solo Linux (`pactl`): ya devuelve
   `available:false`. Sin trabajo.
8. **Escritura atómica del frame** (`renameSync` sobre un fichero existente):
   en Windows falla con `EPERM`/`EBUSY` si otro proceso lo tiene abierto. Con
   el driver USB en proceso deja de importar; con el modo `file` hay que
   reintentar.
9. **Nombres/longitud de rutas, `\r\n`, mayúsculas/minúsculas** en
   tests y configs: lo cubrirá el CI, pero algunos tests hoy pueden estar
   saltándose en Windows (mirar `skip` por plataforma).
10. **`agent-sessions`** lee `~/.aimonitor`, `~/.claude`…: las rutas de Claude
    Code en Windows son `%USERPROFILE%\.claude`, igual que en Linux, pero
    conviene probarlo. La detección de proceso/`cwd` por `/proc` no existirá.

## 4. El driver USB (el grueso del trabajo)

### Qué hay que implementar

El protocolo LY (Trofeo Vision, VID `0x0416` PID `0x5408`/`0x5409`) es
pequeño; está documentado en `trcc/adapters/device/ly_lcd.py` (355 líneas) y
ya replicado en `kiosko-sender.py`:

1. Abrir el dispositivo por **VID/PID + número de serie**, `set_configuration(1)`,
   reclamar la interfaz 0, endpoints bulk de salida `0x01` y de entrada.
2. *Handshake*: escribir 2048 bytes (cabecera `02 FF 00 00 00 00 00 00 01 …` +
   ceros), leer 512; validar `resp[0]=3`, `resp[1]=0xFF`, `resp[8]=1`. De ahí
   salen PM (`64+resp[20]`) y SUB (`resp[22]+1`), que fijan resolución y giro.
3. Fotograma: JPEG troceado en bloques de 512 bytes (16 de cabecera + 496 de
   datos), relleno a múltiplo de 4 bloques, escritos en bloques USB de 4096
   (el último de 2048), y lectura del ACK de 512 bytes cuyo **byte 8** dice si
   lo aceptó (`1`) o lo descartó (`2`).
4. Reenviar cada ~1 s lo que no cambia (el firmware vuelve al logo a los 2–3 s).

Es cálculo de bytes y no depende del SO. Hay que sacar los detalles de la
cabecera de cada bloque de `_prepare_frame` (no los he copiado aquí).

### Con qué librería

| Opción | Pros | Contras |
|---|---|---|
| **`usb`** (node-usb, libusb) | Binarios precompilados para win32/darwin/linux (prebuildify); API de transferencias bulk; permite `serial_number` | Módulo nativo: la ruta `external` de `build-dist.mjs` ya lo admite (como `@napi-rs/canvas`). En Windows **exige driver WinUSB** (ver abajo) |
| `node-hid` | Sin Zadig si el dispositivo es HID | El LY es bulk, no HID: no sirve para el Trofeo. Quizá sí para otros modelos |
| Seguir con `trcc` en Python | Cero código nuevo | Hay que instalar Python, `trcc`, `libusb-package`, y `trcc serve` es API privada que ya cambió; peor experiencia de instalación |

Recomendación: **`usb` como dependencia opcional** (`optionalDependencies`) y
el driver `usb-ly` cargado de forma perezosa, para que un fallo del módulo
nativo no rompa el editor.

### Ojo con Windows: el driver WinUSB

Esto es lo más molesto para el usuario final. libusb en Windows solo ve
dispositivos con driver **WinUSB** (o libusbK/UsbDk). El Trofeo Vision con el
software original de Thermalright usa su propio acceso; para libusb hay que
sustituir el driver con [Zadig](https://zadig.akeo.ie/) o instalar un INF
firmado. `trcc` ya trae `trcc setup-winusb` y un diagnóstico de Zadig
(releases 8.4.4 y 9.4.15 de thermalright-trcc-linux), y un INF que cubre los
dispositivos no SCSI, LY incluido. Se podría reutilizar la idea.

Consecuencias a decidir y a avisar al usuario:

- Con WinUSB instalado, **el software oficial TRCC deja de ver el panel**
  hasta que se restaure el driver (reversible desde el Administrador de
  dispositivos).
- Requiere privilegios de administrador una vez. El INF del propio Kiosko
  evitaría Zadig; firmarlo con certificado propio exige modo prueba, o un
  certificado EV de pago. Realista: guiar con Zadig y `kiosko doctor`.
- `usb.useUsbDkBackend()` es la alternativa sin cambiar el driver del
  dispositivo, pero exige instalar UsbDK (también con administrador).

### Varios paneles idénticos

En Linux el número de serie se resuelve con sysfs (`usbPathForSerial`). Con
libusb se lee el descriptor de serie directamente (`device.getStringDescriptor`),
sin sysfs; en Windows funciona igual una vez con WinUSB. Esto además permite
**abandonar `kiosko-sender.py` y los servicios `kiosko-sender@…`**:
un solo proceso Node con un hilo por panel (o un `Device` por pantalla).

### Encaje en el código

Nuevo driver en `packages/core/src/devices.ts`, junto a `trcc`/`file`/`virtual`:
`{ driver: 'usb', serial?: string }`, con la misma interfaz `Device`. Un
paquete aparte `@loksly/usb-ly` (como `trcc-client`), con una interfaz
`BulkTransport` inyectable para poder **probar el protocolo sin hardware**
con un transporte simulado (no hay panel en CI ni en Docker, ver §6). La
lógica de reenvío periódico, aquí en proceso, sustituye a `pinFrame`.

La detección para el diálogo «Add screen» pasa a enumerar dispositivos
`0416:5408` por USB en lugar de preguntar a `trcc serve`.

## 5. Probar con Docker (lo que preguntabas)

No se puede ejecutar Windows en un contenedor «normal» (comparte el núcleo
Linux), pero existe `dockur/windows`: un contenedor que arranca **una máquina
virtual QEMU/KVM con Windows dentro**. Condiciones en esta máquina:

- Docker Engine instalado y `/dev/kvm` presente: **cumple** (16 hilos, 61 GB).
- Hay que dejarle ~8 GB de RAM, 4 hilos y ~64 GB de disco.
- Descarga la ISO de Windows 11/10 (o la de evaluación) y la instala sola;
  se ve en el navegador (puerto 8006) y se puede entrar por RDP. La
  licencia sin activar o la edición de evaluación vale para probar; no es
  para producción.

Esquema orientativo (no ejecutado):

```yaml
services:
  windows:
    image: dockurr/windows
    environment:
      VERSION: "11"
      RAM_SIZE: "8G"
      CPU_CORES: "4"
      DISK_SIZE: "64G"
    devices: ["/dev/kvm", "/dev/net/tun"]
    cap_add: [NET_ADMIN]
    ports: ["8006:8006", "3389:3389/tcp", "7420:7420"]
    volumes:
      - ./windows:/storage
      - /datos/kiosko:/shared      # visible en Windows como \\host.lan\Data
    stop_grace_period: 2m
```

### Qué se puede validar así

| Prueba | ¿Sirve Docker? |
|---|---|
| `npm install`, `npm test`, `npm run check`, `build-dist`, `kiosko render` en Windows real | **Sí** |
| Editor en Edge/Chrome de Windows contra el servidor de la VM | Sí (puerto 7420) |
| Rutas, `schtasks`, ventana oculta, `npm.cmd`, shims `.cmd` | Sí |
| Plugins `system`, `gpu` (sin GPU real no) | Parcial |
| **Panel USB real** | **Sí, con paso extra y a medias**: QEMU admite pasar un dispositivo USB del anfitrión (`-device usb-host,vendorid=0x416,productid=0x5408`, vía la variable `ARGUMENTS` de dockur y montando `/dev/bus/usb`). Hay que pasar un panel entero a la VM, y mientras tanto el anfitrión deja de tenerlo. Habría que **probarlo**: el LY es sensible a la temporización y la capa de USB virtual añade latencia. |
| Instalación con Zadig/WinUSB | Sí, dentro de la VM, si el panel está pasado |

**Con un panel de repuesto o apagando temporalmente el servicio** de uno de los
tres (`kiosko-sender@news`, el menos crítico) se puede probar el camino
completo sin tocar los otros dos. Sin ningún panel, la VM valida todo salvo el
último tramo, que se prueba con el transporte simulado.

### Alternativas

- **Wine**: sirve para los scripts de Node (`node.exe` corre), pero `schtasks`,
  WinUSB y WMI son flojos o inexistentes. No lo usaría para validar.
- **QEMU/libvirt a pelo** (`qemu-system-x86_64` y KVM están en esta máquina):
  lo mismo que dockur sin la comodidad. Útil si dockur estorba al pasar USB.
- **GitHub Actions `windows-latest`**: ya está en el CI; cubre todo lo que no
  es hardware, gratis. Es el primer sitio donde mirar si hay algo roto ya hoy.
- **Máquina de Azure/AWS con Windows** o un portátil prestado: para pruebas con
  panel y WinUSB reales a largo plazo.

## 6. Distribución

Hoy: `npm install -g kiosko` (exige Node ≥ 22.18). Para Windows:

1. **MVP**: igual, documentando instalar Node con `winget install OpenJS.NodeJS`
   y `kiosko doctor` que explique Zadig/WinUSB.
2. **Instalador**: ejecutable único con Node SEA (`node --experimental-sea-config`)
   o `pkg`; las dependencias nativas (`@napi-rs/canvas`, `usb`) se quedan fuera
   como ficheros `.node` junto al `.exe`. Empaquetar con Inno Setup o WiX
   (MSI); publicar en winget.
3. Firma de código: sin certificado, SmartScreen avisará. Aceptarlo al
   principio.

## 7. Plan por fases

| Fase | Contenido | Entrada para empezar | Tiempo (estimación) |
|---|---|---|---|
| 0 | Montar `dockur/windows`, ejecutar `npm test` y `kiosko render` en Windows; lista de fallos reales | Docker + KVM, ya los hay | 0,5 día (más una descarga larga) |
| 1 | Corregir §3 (`expandPath`, shims `.cmd`, caché, servicio oculto, `EPERM` en rename) con tests | Resultado de la fase 0 | 1–2 días |
| 2 | `@loksly/usb-ly`: protocolo + transporte simulado + tests; driver `usb` en `devices.ts` | Extraer de `ly_lcd.py` la cabecera de bloque | 2–3 días |
| 3 | Probar el panel real en Linux con el driver Node (comparar con `kiosko-sender.py`: ACK, fps) | Un panel libre | 1 día |
| 4 | Probar en la VM con USB pasado + WinUSB; documentar Zadig y `kiosko doctor` | Fase 3 | 1–2 días |
| 5 | Instalador y winget | Fases 1–4 | 2–3 días |

Estimaciones a ojo; el mayor riesgo es la fase 4 (USB virtualizado y drivers),
no el código.

## 8. Riesgos y preguntas abiertas

- ¿El panel que se tenga en Windows es solo el Trofeo Vision LY (`0416:5408`) o
  también los de otros protocolos (SCSI, HID, 320×240)? Cada protocolo es otro
  driver; el roadmap habla de «paneles Thermalright» en general. Se propone
  **empezar solo por LY**, que es el que ya hay medido y conocido.
- Hay discrepancias sobre qué PID corresponde a qué modelo en la documentación
  de `trcc` (las notas de versión mencionan `0416:5302` para otra variante de
  6,86"); verificar con el panel que haya.
- Licencia: el protocolo se ha leído de TRCC (software de Thermalright)
  mediante la ingeniería inversa del proyecto `thermalright-trcc-linux`.
  Reimplementarlo en Node es razonable (MIT, mismo enfoque que el sender), pero
  conviene citar la fuente y comprobar su licencia antes de copiar texto.
- `node-usb` y `@napi-rs/canvas` son nativos: Node SEA y el `external` de
  esbuild tienen que acompañarse de sus `.node` en el instalador.
- Windows ARM64: `@napi-rs/canvas` lo trae; `usb` también tiene prebuilds, pero
  no lo he comprobado.

## 9. Fase 1 hecha y probada en un Windows 10 real (VM, 2026-11-11)

Montado con `dockur/windows` (Docker rootless, KVM) en `~/vm-windows`:
Windows 10 Pro 19045, Node 24.22.3. Un agente en cola (`oem/runner.ps1`)
ejecuta en la VM los `.ps1` que se dejan en `shared/cola`. Sin panel USB.

**Primera pasada, antes de tocar código** (árbol limpio del último commit):
`npm install`, `npm run check` y `build-dist` bien; `npm test` con 216 tests,
208 pasan, 0 fallan, 8 saltados; `doctor`, `render` y `start --demo` bien.

**Cambios hechos** (sin commit en `/datos/kiosko` y en `kiosko-plugin-usage`):

| Problema (§3) | Cambio | Probado en Windows |
|---|---|---|
| `expandPath` sin `~\` ni `%VAR%` | `expandPath` pasa al SDK (`packages/sdk/src/system.ts`); `plugins/core` y `plugins/legacy` lo usan | sí: `%APPDATA%\Kiosko` y `~\notas.txt` |
| `.cmd` de npm no se pueden ejecutar con `execFile` | `commandFor` del SDK; el plugin `usage` lo usa | sí, con un `.cmd` propio y espacios en los argumentos; `execFile` directo da `ENOENT` |
| Caché sin tmpfs | en Windows va a `%LOCALAPPDATA%\Kiosko\cache` | solo en tests de Linux |
| Servicio con ventana de consola | tarea que lanza un `.vbs` oculto, con log en `kiosko.log`; `uninstall` también termina `node.exe` y `cmd.exe` | sí: sin ventana, responde en 7420, `uninstall` no deja procesos, tarea ni `.vbs` |
| `chmod 0600` sin efecto | `restrictToOwner`: ACL con `icacls` | sí: solo `usuario:(F)` |
| `rename` con `EPERM`/`EBUSY` | `renameReplacing`, hasta 8 intentos | solo con un transporte simulado |

Resultado con los cambios: **`npm test` 229 tests, 221 pasan, 0 fallan, 8
saltados** en Windows (en Linux, 229 pasan). 13 tests nuevos.

**Hallazgos:**

- `schtasks /End` **no mata** `node.exe`: había que terminar los procesos por su
  línea de comandos, **excluyendo el propio `uninstall`**, que ejecuta el mismo
  `cli.js` (la primera versión se mataba a sí misma y dejaba la tarea).
- La prueba de `service install` se hizo con un usuario administrador: **no
  está probado con un usuario sin privilegios**, donde `schtasks /SC ONLOGON`
  puede dar «acceso denegado». Si ocurre, la alternativa es la clave
  `HKCU\...\Run`.
- `ccusage` instalado con npm falló dentro de la VM con `0xC0000135` incluso
  ejecutando su `.cmd` a mano: es un problema de esa instalación, no del código.
  Falta probar `commandFor` con un `ccusage` que funcione.
- La consola de Windows (página 850) pinta mal `×`, `✔`, `—`: solo estética.
- Windows se reinició por su cuenta durante las pruebas; el runner se relanza
  solo por la clave `Run`.
- Los tests del plugin `usage` necesitan enlazar `@kiosko/sdk` y
  `@napi-rs/canvas` desde la carpeta del plugin (en la VM falta el segundo).

**Pendiente de la fase 1:** probar con un usuario sin privilegios, con los
plugins oficiales instalados desde npm (`kiosko plugins add …`) y con un
`ccusage` que funcione; los plugins `gitlab` y `timesheet` no usan todavía
`commandFor` (`glab` es un `.exe`, así que no lo necesitan, pero un `bin`
configurable que apunte a un `.cmd` fallaría).

El volumen de la VM ocupa ~15 GB de los 32 GB asignados, en `/` y no en
`/datos`. Para repetir: `cd ~/vm-windows && docker compose up -d`.

## 10. Fase 2: driver USB propio en Node (2026-11-12)

Hecho, sin commit:

- **`packages/usb-ly`** (`@loksly/usb-ly`): el protocolo LY (apretón de manos,
  troceado en bloques de 512, escrituras de 4096, lectura del ACK) y el acceso
  USB con `usb` (libusb, dependencia **opcional** con binarios para Linux, macOS
  y Windows). `protocol.ts` es puro: su salida es **byte a byte la de trcc 9.12**
  (22 vectores generados con el propio `trcc`, para LY y LY1, de 0 a 511 871
  bytes). Un serial que no aparece es un error, nunca «otro panel».
- **Driver `usb` en `core`** (`{ "driver": "usb", "serial": "…", "keepalive": 1 }`):
  el fotograma nuevo sale al momento, el igual se reenvía cada `keepalive`;
  si el bus falla se reabre con pausa creciente; si el panel descarta un
  fotograma (ACK byte 8 = 2) lo dice en el estado. Siempre JPEG.
- `kiosko usb [list|test]`, línea `usb` en `kiosko doctor`, detección en el
  editor (Añadir pantalla → Detectar paneles) y `docs/usb.md` (regla udev en
  Linux, WinUSB/Zadig en Windows).

Probado:

| | Linux | Windows 10 (VM) |
|---|---|---|
| tests (254 en total, 25 nuevos de USB) | 254 pasan | 246 pasan, 8 saltados, 0 fallan |
| `usb` (libusb) carga y enumera | sí: ve los 3 paneles reales con su serie | sí: carga y enumera (sin paneles) |
| `build-dist` con `usb` externo y opcional | sí | sí |
| `kiosko usb test` con un serial inexistente | sí | sí |
| **enviar a un panel real** | **sí (2026-11-12, 12 s, panel de noticias)**: handshake PM 65 SUB 5 = 1920×462, 11 fotogramas aceptados sin descartes, sin aviso de giro; confirmado a ojo por el usuario: la imagen salió bien | **no** |

**Pendiente:** confirmar a ojo la imagen y medir fps frente a `kiosko-sender`, después en la VM con el panel pasado por
USB y WinUSB. Hasta entonces el driver es experimental.

## 11. Fase 3: instalador de Windows (2026-11-12)

`scripts/build-windows-installer.mjs` monta una carpeta autónoma (el `node.exe`
que ejecuta el script, el paquete `kiosko` con sus dependencias de producción y
los binarios de Windows de `@napi-rs/canvas` y `usb`, y los 15 plugins
oficiales ya compilados) y la envuelve con Inno Setup (`installer/kiosko.iss`):
`Kiosko-Setup-<versión>-x64.exe`, ~38 MB, **por usuario y sin administrador**,
con tareas opcionales «arrancar al iniciar sesión» (`kiosko service install`) y
«añadir `kiosko` al PATH», acceso en el menú Inicio (`start-kiosko.vbs`: arranca
Kiosko sin ventana y abre el editor) y desinstalador que para el servicio y
conserva la configuración. El workflow `Windows installer` lo construye en
`windows-latest`, lo instala en silencio, lo comprueba, lo desinstala y, con
una etiqueta `v*`, lo adjunta a la release.

Probado en Windows 10 (VM): instalación silenciosa con servicio y PATH, tarea
programada, editor en 7420, acceso del menú, entrada de desinstalación, `render`
con los plugins oficiales, **actualización encima de una instalación en marcha**,
`start-kiosko.vbs` con el servicio parado y desinstalación (sin ficheros,
procesos, tarea ni entrada en el PATH; la configuración se conserva).

La prueba encontró dos errores que no eran de Windows y están corregidos:

- **Los plugins oficiales instalados con npm no cargaban en una instalación
  limpia**, en ningún sistema: el resolutor que les da el SDK solo se instalaba
  si existía la carpeta de plugins del usuario. (`kiosko@0.1.0` en npm lo tiene.)
- `kiosko render --out C:\x.png` fallaba con `EPERM` (`mkdir` de la raíz de una
  unidad).

Sin firmar: SmartScreen avisará («Más información → Ejecutar de todas formas»).
Pendiente: firma de código, paquete de winget, instalador para ARM64 y probar el
panel real bajo WinUSB.

## Fuentes

- thermalright-trcc-linux, notas de versión (soporte LY, WinUSB, libusb en
  Windows): <https://newreleases.io/project/github/Lexonight1/thermalright-trcc-linux/release/v9.7.3>,
  <https://newreleases.io/project/github/Lexonight1/thermalright-trcc-linux/release/v9.4.15>,
  <https://newreleases.io/project/github/Lexonight1/thermalright-trcc-linux/release/v8.4.4>
- node-usb (binarios, WinUSB/Zadig, UsbDK): <https://github.com/koush/node-usb>,
  <https://www.npmjs.com/package/usb>
- dockur/windows: <https://github.com/dockur/windows>
