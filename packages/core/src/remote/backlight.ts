/**
 * Night mode for remote screens: the backlight Kiosko asks for now, on top
 * of the screen's own brightness (docs/remote-screen.md, "Brightness").
 *
 * - While Kiosko shows the screen black (switched off from Home Assistant or
 *   the API, asleep with `sleepWhenIdle`, or the screen disabled), the
 *   backlight goes off: a black LCD still glows, and costs power.
 * - In the device's `night` window (`HH:MM` local time, like an alert's quiet
 *   hours: start after end goes across midnight) it takes the night's
 *   brightness (0 = off).
 * - An alert taking the panel over always shows at the screen's own
 *   brightness, night or not.
 *
 * Firmware 0.1.4 on applies this as a temporary dimming that is never saved
 * and ends with the session; older firmware ignores it (the black picture is
 * all a paused screen gets there).
 */
import { inQuietHours, type DeviceConfig, type Screen } from '../config/model.ts';

/** The night window of a remote screen: from `start` to `end` (local `HH:MM`) at `brightness` (0-100, 0 = off). */
export interface NightBacklight {
  start: string;
  end: string;
  brightness: number;
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** The night window, when the config has a usable one (a hand-edited file may not). */
export function nightOf(d: DeviceConfig): NightBacklight | null {
  if (d.driver !== 'remote' || !d.night || typeof d.night !== 'object') return null;
  const { start, end, brightness } = d.night;
  if (!HHMM.test(String(start)) || !HHMM.test(String(end)) || start === end) return null;
  if (typeof brightness !== 'number' || !Number.isFinite(brightness)) return null;
  return { start, end, brightness: Math.min(100, Math.max(0, Math.round(brightness))) };
}

/**
 * The backlight Kiosko asks a screen for now, 0-100; null: none (the screen
 * shows its own brightness). `sleeping`: Kiosko paints it black now;
 * `alert`: an alert has the panel.
 */
export function dimFor(screen: Pick<Screen, 'enabled' | 'device'>, state: { sleeping: boolean; alert: boolean }, now: number): number | null {
  if (screen.device.driver !== 'remote') return null;
  if (state.alert) return null;
  if (!screen.enabled || state.sleeping) return 0;
  const night = nightOf(screen.device);
  return night && inQuietHours(night, now) ? night.brightness : null;
}
