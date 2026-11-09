#!/usr/bin/env python3
# Kiosko USB frame sender (from aimonitor's scripts/news-sender.py). It
# keeps ONE panel, chosen by USB serial number, showing the `frame.jpg` that
# Kiosko's "file" connection writes. See README.md next to this file.
"""Mantiene el panel de noticias encendido con el último fotograma compuesto.

Por qué existe este proceso, y por qué es de Python
---------------------------------------------------
Las dos pantallas son el mismo modelo y comparten identificador USB
(``0416:5408``). ``trcc serve`` indexa sus dispositivos por ``vid:pid``, así que
su diccionario interno sólo tiene sitio para una de las dos: la segunda pantalla
es sencillamente inalcanzable a través de su API REST. Su capa de transporte,
en cambio, sí sabe abrir por número de serie.

Así que este emisor se salta la API y usa los módulos de ``trcc`` directamente,
abriendo **por número de serie** el panel que la otra no tiene cogido. No se
reimplementa el protocolo LY: se reutiliza el suyo, que ya tiene resueltos el
saludo inicial, el troceado en bloques de 512 bytes y el relleno a múltiplo de
cuatro. Por eso hay que arrancarlo con el intérprete del entorno de ``trcc``::

    ~/.local/pipx/venvs/trcc-linux/bin/python scripts/news-sender.py

Y por qué reenvía en bucle
--------------------------
El firmware LY descarta la imagen a los 2-3 s de no recibir nada y vuelve al
logo de fábrica. El bucle de aquí abajo manda cada fotograma **nada más
aparecer** (mira el fichero cada pocos milisegundos) y, mientras no cambie, lo
reenvía cada `keepalive` segundos para que no se apague. **Duerme de verdad
entre vueltas**: la versión REST de esto acabó siendo un bucle vivo de ~400
peticiones por segundo que llenó el syslog con 17,8 GB.

Medido en este panel (2026-11-07, trcc 9.12): un envío tarda ~42 ms sea cual
sea el tamaño del JPEG (de 73 a 146 KB, lo mismo), así que el panel da ~24 fps
y lo que manda es la espera del ACK, no el bus. Antes se dormían 0,15 s tras
cada envío *aunque hubiera fotograma nuevo*: las animaciones no pasaban de
~5 fps, y los tres paneles reenviaban siete veces por segundo una imagen que no
había cambiado.

La regla que no se negocia
--------------------------
Si no encuentra exactamente el número de serie configurado, **termina**. Nunca
coge "la que haya": el panel de noticias apagado es un fallo menor, pero
quedarse con el del cuadro de mando lo dejaría sin su daemon y sin su imagen.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
from pathlib import Path

KEEPALIVE_S = 1.0
"""Cada cuánto se reenvía un fotograma que no ha cambiado ("keepalive" en
config.json, en segundos; "interval", el nombre viejo, vale igual). El firmware
vuelve al logo a los ~2-3 s sin fotograma: uno por segundo deja margen."""

POLL_S = 0.005
"""Cada cuánto se mira si el daemon ha dejado fotograma nuevo: un `stat`, nada
más. Es lo que se retrasa, como mucho, un fotograma de una animación."""

RECONNECT_WAIT_S = 3.0
MAX_CONSECUTIVE_FAILURES = 40

log = logging.getLogger("kiosko.sender")


def state_dir() -> Path:
    # Kiosko: one folder per panel, ~/.config/kiosko/senders/<name>.
    if os.environ.get("KIOSKO_SENDER_DIR"):
        return Path(os.environ["KIOSKO_SENDER_DIR"])
    base = os.environ.get("AIMONITOR_DIR") or str(Path.home() / ".aimonitor")
    return Path(os.environ.get("AIMONITOR_NEWS_DIR") or str(Path(base) / "news"))


def load_config() -> dict:
    path = state_dir() / "config.json"
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        log.error("no existe %s — créalo con al menos {\"serial\": \"...\"}", path)
        sys.exit(2)
    except (OSError, ValueError) as exc:
        log.error("no se pudo leer %s: %s", path, exc)
        sys.exit(2)


class CheckedLyLcd:
    """Marcador: se sustituye en tiempo de ejecución por la subclase real.

    No se puede declarar arriba porque hereda de `LyLcd`, que vive en el entorno
    de trcc y sólo se importa dentro de `import_trcc`.
    """


def make_checked_lcd(LyLcd):
    """Subclase de LyLcd que **mira el ACK** en vez de tirarlo.

    El firmware contesta a cada envío con 512 bytes cuyo **byte 8** dice si se
    ha quedado con el fotograma:

        03 ff 00 00 00 00 00 00 01 ...   aceptado
        03 ff 00 00 00 00 00 00 02 ...   descartado

    `trcc` lee esos bytes y los descarta, y por eso el descarte por tamaño tiene
    fama de mudo: el envío responde `ok`, el ACK se lee, y la pantalla se queda
    con la imagen anterior sin una sola línea en ningún log. Medido en este
    mismo panel, el corte está en 511.871 bytes —1032 bloques de 496— y la
    constante de trcc (512 KiB) se pasa en 12.417 bytes.

    Mirando el byte, un fallo invisible se convierte en un aviso en el journal.
    Ver docs/upstream/ly-frame-limit.md.
    """

    class Checked(LyLcd):
        last_accepted = True

        def _write_frame(self, frame: bytes) -> bool:
            total = len(frame)
            pos = 0
            while pos < total:
                remaining = total - pos
                size = 4096 if remaining >= 4096 else min(2048, remaining)
                self._transport.write(self._EP_WRITE, frame[pos:pos + size], 5000)
                pos += 4096
            ack = bytes(self._transport.read(self._EP_READ, 512, 1000))
            # Un ACK corto o raro no se interpreta: se da por bueno para no
            # inventarse un fallo donde a lo mejor sólo hay otro firmware.
            self.last_accepted = len(ack) < 9 or ack[8] == 1
            return True

    return Checked


def import_trcc():
    """Importa los módulos internos de ``trcc``.

    Es API privada y ya cambió de contrato una vez, así que el fallo se cuenta
    entero en vez de dejar un ``ImportError`` pelado.
    """
    try:
        from trcc.adapters.device.ly_lcd import LyLcd
        from trcc.adapters.device.transport import PyUsbBulkTransport
        from trcc.core.protocol import wire_angle
        from trcc.core.registry import find_product
        return make_checked_lcd(LyLcd), PyUsbBulkTransport, wire_angle, find_product
    except ImportError as exc:
        log.error(
            "no se pudieron importar los módulos de trcc (%s).\n"
            "Hay que arrancar este emisor con el intérprete de su entorno:\n"
            "  ~/.local/pipx/venvs/trcc-linux/bin/python %s",
            exc, sys.argv[0],
        )
        sys.exit(2)


def connect(serial: str, expected_rotate: int):
    """Abre el panel por número de serie y comprueba el giro que pide el firmware."""
    LyLcd, PyUsbBulkTransport, wire_angle, find_product = import_trcc()

    vid, pid = 0x0416, 0x5408
    info = find_product(vid, pid)
    if info is None:
        log.error("el registro de trcc no conoce %04x:%04x", vid, pid)
        sys.exit(2)

    device = LyLcd(info, PyUsbBulkTransport(vid, pid, serial))
    result = device.connect()

    angle = wire_angle(device.profile, 0, False)
    log.info(
        "panel %s conectado: %dx%d PM=%d SUB=%d giro=%d°",
        serial, result.resolution[0], result.resolution[1],
        result.pm_byte, result.sub_byte, angle,
    )
    if angle != expected_rotate:
        # El giro lo aplica el compositor de Node antes de codificar, así que si
        # el firmware pide otro la imagen sale torcida y no hay forma de verlo
        # desde aquí. Se avisa en vez de callar.
        log.warning(
            "el firmware pide %d° pero la configuración dice rotate=%d. "
            "Ajusta \"rotate\" en config.json o la imagen saldrá girada.",
            angle, expected_rotate,
        )
    return device


def connect_with_retry(serial: str, expected_rotate: int, is_running):
    """Insiste hasta que aparezca **ese** panel, sin trazas ni bucle de systemd.

    Sin esto, un panel desenchufado hacía reventar el arranque con un traceback;
    systemd reintentaba a los 5 s y volvía a reventar, llenando el journal de
    trazas idénticas para siempre. Y al iniciar sesión hay una carrera real: la
    unidad arranca con `graphical-session.target` y el USB puede no estar
    enumerado todavía.

    Ojo con lo que **no** hace: no busca "otro panel". Sigue exigiendo el número
    de serie configurado, porque coger el del cuadro de mando sería peor que no
    pintar nada. Aquí sólo se espera a que el suyo aparezca.
    """
    delay = 5.0
    announced = False
    trcc_log = logging.getLogger("trcc")
    while is_running():
        try:
            device = connect(serial, expected_rotate)
            trcc_log.setLevel(logging.WARNING)  # se vuelve a querer oírlo
            return device
        except SystemExit:
            raise  # configuración o entorno mal: no se arregla esperando.
        except Exception as exc:  # noqa: BLE001
            if not announced:
                log.warning("no se encuentra el panel %s (%s); reintentando", serial, exc)
                announced = True
                # trcc grita dos ERROR por intento ("USB device not found",
                # "transport open failed"). Con el panel desenchufado un rato
                # largo eso son miles de líneas repetidas que no añaden nada al
                # aviso de arriba. Se callan hasta que vuelva a conectar.
                trcc_log.setLevel(logging.CRITICAL)
            # En trozos cortos para que un SIGTERM no espere el ciclo entero.
            waited = 0.0
            while waited < delay and is_running():
                time.sleep(0.5)
                waited += 0.5
            delay = min(delay * 1.5, 30.0)
    return None


def expand(p: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(p)))


def wheel_dir(cfg: dict, now: float) -> Path | None:
    """Qué contenido le toca a este panel ahora, si los paneles se turnan.

    Para alargar la vida de los paneles, cada ``hours`` horas el contenido
    rueda: el del primero pasa al segundo, el del segundo al tercero y el del
    último al primero. Así ninguna imagen fija (la columna de tarjetas, el
    marco de la escena) se queda horas en los mismos píxeles. Cada emisor lleva
    en su config la misma lista ``dirs`` (el contenido de cada panel, en el
    orden de la rueda) y su ``slot`` en ella::

        "wheel": {"dirs": ["$XDG_RUNTIME_DIR/aimonitor/panel1", "…/news", "…/panel3"],
                  "slot": 0, "hours": 2}

    Sin coordinación entre procesos: los tres miran el mismo reloj, así que
    cambian a la vez. Las vueltas se cuentan desde la medianoche local, así que
    los cambios caen a horas redondas (con ``hours`` 2: 0:00, 2:00, 4:00…).
    """
    w = cfg.get("wheel")
    if not w or not w.get("dirs"):
        return None
    dirs = w["dirs"]
    period = max(60.0, float(w.get("hours", 2)) * 3600)
    turn = int((now + time.localtime(now).tm_gmtoff) // period)
    return expand(dirs[(int(w.get("slot", 0)) - turn) % len(dirs)])


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="[emisor] %(levelname)s %(message)s", stream=sys.stdout,
    )
    # trcc es hablador y este proceso vive en el journal: sólo sus avisos.
    logging.getLogger("trcc").setLevel(logging.WARNING)

    cfg = load_config()
    serial = str(cfg.get("serial") or "").strip()
    if not serial:
        log.error(
            "falta \"serial\" en %s. Las dos pantallas comparten 0416:5408 y el "
            "número de serie es lo único que las distingue; sin él este emisor "
            "no puede saber cuál es la de noticias.",
            state_dir() / "config.json",
        )
        sys.exit(2)

    # El fotograma puede vivir aparte de la config ("frameDir", con ~ y
    # variables): en un tmpfs como $XDG_RUNTIME_DIR, para que las animaciones
    # no escriban en el SSD varias veces por segundo.
    frame_dir = cfg.get("frameDir")
    own_path = (expand(frame_dir) if frame_dir else state_dir()) / "frame.jpg"
    wheel = wheel_dir(cfg, time.time())
    frame_path = wheel / "frame.jpg" if wheel else own_path
    log.info("fotograma: %s%s", frame_path, " (los paneles se turnan)" if wheel else "")
    next_wheel_check = 0.0
    expected_rotate = int(cfg.get("rotate", 180))
    keepalive = min(2.0, max(0.1, float(cfg.get("keepalive", cfg.get("interval", KEEPALIVE_S)))))
    log.info("fotogramas nuevos al momento; el mismo, cada %.2f s", keepalive)

    running = True

    def stop(signum, _frame):
        nonlocal running
        log.info("recibida señal %s, saliendo", signal.Signals(signum).name)
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    device = connect_with_retry(serial, expected_rotate, lambda: running)
    if device is None:
        return  # nos pararon mientras esperábamos al panel

    payload: bytes | None = None
    stamp: tuple[float, int] | None = None
    fresh = False          # hay un fotograma que el panel aún no tiene
    last_send = 0.0
    failures = 0
    warned_missing = False
    rejected_warned = False

    try:
        while running:
            # ¿Le toca otro contenido a este panel? Se mira cada pocos segundos.
            if wheel and time.monotonic() >= next_wheel_check:
                next_wheel_check = time.monotonic() + 5
                turn_path = wheel_dir(cfg, time.time()) / "frame.jpg"
                if turn_path != frame_path:
                    log.info("cambio de turno: ahora enseña %s", turn_path)
                    frame_path, stamp = turn_path, None

            # Sólo se relee el fichero cuando cambia; el resto del tiempo esto
            # es un memcpy sobre el bus y poco más.
            try:
                st = os.stat(frame_path)
                current = (st.st_mtime, st.st_size)
                if current != stamp:
                    with open(frame_path, "rb") as fh:
                        data = fh.read()
                    if data:
                        if payload is None:
                            log.info("primer fotograma: %.0f KB", len(data) / 1024)
                        payload, stamp, fresh = data, current, True
                    warned_missing = False
            except FileNotFoundError:
                if not warned_missing:
                    log.info("aún no hay fotograma en %s; esperando al daemon", frame_path)
                    warned_missing = True
            except OSError as exc:
                log.warning("no se pudo leer el fotograma: %s", exc)

            if payload is None:
                time.sleep(0.5)
                continue
            if not fresh and time.monotonic() - last_send < keepalive:
                time.sleep(POLL_S)
                continue

            try:
                device.send(payload)
                fresh = False
                last_send = time.monotonic()
                failures = 0
                if not getattr(device, "last_accepted", True):
                    # El envío "funcionó" y el panel lo tiró. Sin esta
                    # comprobación, la pantalla se quedaría congelada en la
                    # noticia anterior y no habría forma de saberlo.
                    if not rejected_warned:
                        log.error(
                            "el panel DESCARTÓ el fotograma de %.0f KB (tope medido: 500 KB). "
                            "Baja maxBytes en la configuración del compositor.",
                            len(payload) / 1024,
                        )
                        rejected_warned = True
                elif rejected_warned:
                    log.info("el panel vuelve a aceptar los fotogramas")
                    rejected_warned = False
            except Exception as exc:  # noqa: BLE001 — cualquier fallo del bus vale
                failures += 1
                log.warning("envío fallido (%d): %s", failures, exc)
                if failures >= MAX_CONSECUTIVE_FAILURES:
                    # Que sea systemd quien reintente desde cero: aquí ya se ha
                    # probado a reconectar y el dispositivo no responde.
                    log.error("%d fallos seguidos; se sale para que systemd reinicie", failures)
                    sys.exit(1)
                try:
                    device.disconnect()
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(RECONNECT_WAIT_S)
                reconnected = connect_with_retry(serial, expected_rotate, lambda: running)
                if reconnected is None:
                    break  # parada solicitada
                device = reconnected
                fresh = True  # el panel recién conectado no tiene nada
                continue
    finally:
        try:
            device.disconnect()
            log.info("panel liberado")
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    main()
