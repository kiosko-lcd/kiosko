/**
 * One LCD panel of the 3D page: a white slab with a wide screen, modelled on
 * the 9.16″ bar panels Kiosko drives (1920×462). Its screen is a canvas the
 * frames from the in-browser runtime are drawn on; a light in front of it
 * takes the colour of what is showing, so the picture spills on the desk.
 *
 * One unit is 10 cm.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { StageFrame } from '../demo/protocol.ts';

/** Pixels of the screen. */
const PX = { w: 1920, h: 462 };

const SCREEN_W = 2.21;
/** The body and where the screen sits in it: thin bezels, a wider one below for the name. */
export const PANEL = {
  w: 2.36,
  h: 0.68,
  d: 0.14,
  screenW: SCREEN_W,
  screenH: (SCREEN_W * PX.h) / PX.w,
  top: 0.055,
} as const;
const BOTTOM = PANEL.h - PANEL.top - PANEL.screenH;
/** The magnetic pad on the back, and the pocket beside it where the cable plugs in (to the left, seen from the front). */
const PAD = { w: 0.62 };
const POCKET_X = -(PAD.w / 2 + 0.025 + 0.15);
const PLUG_Y = 0.06;

/** How long a change of page takes on the screen. */
const FADE_MS = 650;
/** From black to the picture, once the first frame arrives. */
const POWER_ON_MS = 1100;
/** Light the screen throws when it is all white. */
const GLOW = 9;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export interface PanelLook {
  /** Print the maker's name on the lower bezel, as on the real thing. */
  brand: boolean;
  anisotropy: number;
}

/** What a panel is showing, for the captions. */
export interface NowShowing {
  page: string;
  kind: StageFrame['kind'];
  what: string | null;
}

export class Panel {
  readonly group = new THREE.Group();
  /** In front of the screen, lighting what the picture would light. */
  readonly glow: THREE.RectAreaLight;
  showing: NowShowing | null = null;

  private readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly sampler = document.createElement('canvas');
  private readonly sg: CanvasRenderingContext2D;
  private readonly disposables: { dispose(): void }[] = [];

  private current: ImageBitmap | null = null;
  private previous: ImageBitmap | null = null;
  private fade: { start: number } | null = null;
  private poweredAt: number | null = null;
  private power = 0;
  private dirty = true;
  private sampledAt = 0;
  private readonly glowTarget = new THREE.Color(0, 0, 0);
  private glowLevel = 0;

  constructor(look: PanelLook) {
    this.canvas.width = PX.w;
    this.canvas.height = PX.h;
    this.g = this.canvas.getContext('2d', { alpha: false })!;
    this.g.fillStyle = '#000';
    this.g.fillRect(0, 0, PX.w, PX.h);
    this.sampler.width = 16;
    this.sampler.height = 4;
    this.sg = this.sampler.getContext('2d', { willReadFrequently: true })!;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = look.anisotropy;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.keep(this.texture);

    const { w, h, d, screenW, screenH, top } = PANEL;
    const front = d / 2;
    const screenY = h / 2 - top - screenH / 2;

    // The body: painted white, a little sheen.
    const white = this.keep(new THREE.MeshStandardMaterial({ color: 0xe9ebef, roughness: 0.6, metalness: 0 }));
    const body = new THREE.Mesh(this.keep(new RoundedBoxGeometry(w, h, d, 6, 0.017)), white);
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);

    // The glass: a hair bigger than the picture, black where the picture ends.
    const glass = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(screenW + 0.016, screenH + 0.016)), this.keep(new THREE.MeshStandardMaterial({ color: 0x030304, roughness: 0.34, metalness: 0 })));
    glass.position.set(0, screenY, front + 0.0008);
    this.group.add(glass);

    // The picture: it shines by itself. An anti-glare finish, as on the real panel: the room
    // shows on it as a soft sheen, never as a lamp's glare over what it says.
    const screen = new THREE.Mesh(
      this.keep(new THREE.PlaneGeometry(screenW, screenH)),
      this.keep(new THREE.MeshPhysicalMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: this.texture, emissiveIntensity: 1, roughness: 0.4, metalness: 0, specularIntensity: 0.55, envMapIntensity: 0.6 })),
    );
    screen.position.set(0, screenY, front + 0.0016);
    this.group.add(screen);

    if (look.brand) this.group.add(this.wordmark(-h / 2 + BOTTOM / 2, front + 0.0009));

    // Under it: three screws.
    const steel = this.keep(new THREE.MeshStandardMaterial({ color: 0x8d9299, roughness: 0.35, metalness: 0.9 }));
    const screw = this.keep(new THREE.CylinderGeometry(0.011, 0.011, 0.004, 20));
    for (const x of [-(w / 2 - 0.13), 0, w / 2 - 0.13]) {
      const s = new THREE.Mesh(screw, steel);
      s.position.set(x, -h / 2 - 0.0005, 0);
      this.group.add(s);
    }

    // Behind, as on the real thing: a magnetic pad in the middle (it sticks to a PC case), the
    // cable's pocket beside it with its angled plug, and a small foot in each corner.
    const rear = -front;
    const turned = (m: THREE.Mesh, x: number, y: number, z: number) => {
      m.rotation.y = Math.PI;
      m.position.set(x, y, z);
      this.group.add(m);
      return m;
    };
    const rim = new THREE.Mesh(this.keep(new RoundedBoxGeometry(PAD.w + 0.05, h * 0.94, 0.012, 2, 0.005)), white);
    rim.position.set(0, 0, rear - 0.005);
    rim.castShadow = true;
    this.group.add(rim);
    turned(new THREE.Mesh(this.keep(new THREE.PlaneGeometry(PAD.w, h * 0.86)), this.keep(new THREE.MeshStandardMaterial({ color: 0x131417, roughness: 0.94, metalness: 0 }))), 0, 0, rear - 0.0115);
    const shade = this.keep(new THREE.MeshStandardMaterial({ color: 0xcdd0d6, roughness: 0.75, metalness: 0 }));
    turned(new THREE.Mesh(this.keep(new THREE.PlaneGeometry(0.3, h * 0.9)), shade), POCKET_X, 0, rear - 0.0007);
    const foot = this.keep(new THREE.PlaneGeometry(0.034, 0.034));
    for (const x of [-(w / 2 - 0.12), w / 2 - 0.12]) for (const y of [-(h / 2 - 0.09), h / 2 - 0.09]) turned(new THREE.Mesh(foot, shade), x, y, rear - 0.0007);
    // The plug goes sideways into the middle block. It is USB-C, so its cable can leave upwards or,
    // as here, downwards: straight to the desk, out of sight from the front.
    const plug = new THREE.Mesh(this.keep(new RoundedBoxGeometry(0.16, 0.052, 0.03, 3, 0.012)), white);
    plug.position.set(POCKET_X + 0.075, PLUG_Y, rear - 0.016);
    this.group.add(plug);
    const relief = new THREE.Mesh(this.keep(new THREE.CylinderGeometry(0.019, 0.021, 0.13, 20)), white);
    relief.position.set(POCKET_X, PLUG_Y - 0.05, rear - 0.018);
    this.group.add(relief);

    this.glow = new THREE.RectAreaLight(0xffffff, 0, screenW, screenH);
    this.glow.position.set(0, screenY, front + 0.02);
    // Lights look down their -Z: turn it to shine out of the screen.
    this.glow.rotation.y = Math.PI;
    this.group.add(this.glow);
  }

  /** Where the cable leaves its plug, in the panel's own space: behind, going down. */
  get cable(): THREE.Vector3 {
    return new THREE.Vector3(POCKET_X, PLUG_Y - 0.115, -PANEL.d / 2 - 0.018);
  }

  /** A new frame from the runtime. A change of page fades in; the rest just replaces the picture. */
  show(frame: StageFrame, now: number): void {
    const was = this.showing;
    const switching = !!this.current && !!was && (frame.page !== was.page || (frame.kind === 'interlude') !== (was.kind === 'interlude'));
    if (switching) {
      this.previous?.close();
      this.previous = this.current;
      this.fade = { start: now };
    } else this.current?.close();
    this.current = frame.bitmap;
    this.showing = { page: frame.page, kind: frame.kind, what: frame.what };
    this.dirty = true;
    this.poweredAt ??= now;
    // The light follows the picture: every still page, and now and then while something moves.
    if (frame.kind === 'page' || now - this.sampledAt > 250) this.sample(frame.bitmap, now);
  }

  /** Once per rendered frame: repaint the screen if it changed, and let the light catch up. */
  update(now: number, dt: number): void {
    if (this.poweredAt !== null && this.power < 1) {
      this.power = ease(clamp01((now - this.poweredAt) / POWER_ON_MS));
      this.dirty = true;
    }
    if (this.dirty || this.fade) this.paint(now);
    const k = 1 - Math.exp(-dt * 5);
    this.glow.color.lerp(this.glowTarget, k);
    this.glow.intensity += (GLOW * this.glowLevel * this.power - this.glow.intensity) * k;
  }

  dispose(): void {
    this.current?.close();
    this.previous?.close();
    for (const d of this.disposables) d.dispose();
  }

  private keep<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private paint(now: number): void {
    const { g } = this;
    g.globalAlpha = 1;
    g.fillStyle = '#000';
    g.fillRect(0, 0, PX.w, PX.h);
    if (this.current) {
      const p = this.fade && this.previous ? ease(clamp01((now - this.fade.start) / FADE_MS)) : 1;
      if (p < 1) {
        // The old page leaves to the left as the new one comes in from the right.
        const slide = PX.w * 0.035;
        g.globalAlpha = 1 - p;
        this.draw(this.previous!, -p * slide);
        g.globalAlpha = p;
        this.draw(this.current, (1 - p) * slide);
        g.globalAlpha = 1;
      } else {
        this.draw(this.current, 0);
        this.previous?.close();
        this.previous = null;
        this.fade = null;
      }
    }
    if (this.power < 1) {
      g.fillStyle = `rgba(0,0,0,${1 - this.power})`;
      g.fillRect(0, 0, PX.w, PX.h);
    }
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  /** A frame on the screen, whole: one of another shape is centred with black around it. */
  private draw(b: ImageBitmap, dx: number): void {
    const s = Math.min(PX.w / b.width, PX.h / b.height);
    const w = b.width * s;
    const h = b.height * s;
    this.g.drawImage(b, (PX.w - w) / 2 + dx, (PX.h - h) / 2, w, h);
  }

  /** The picture's average colour and brightness, for the light in front of it. */
  private sample(b: ImageBitmap, now: number): void {
    this.sampledAt = now;
    const { width, height } = this.sampler;
    this.sg.drawImage(b, 0, 0, width, height);
    const px = this.sg.getImageData(0, 0, width, height).data;
    let r = 0;
    let gr = 0;
    let bl = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += toLinear(px[i]! / 255);
      gr += toLinear(px[i + 1]! / 255);
      bl += toLinear(px[i + 2]! / 255);
    }
    const n = px.length / 4;
    r /= n;
    gr /= n;
    bl /= n;
    const peak = Math.max(r, gr, bl, 1e-4);
    this.glowTarget.setRGB(r / peak, gr / peak, bl / peak, THREE.LinearSRGBColorSpace);
    // Dark pages still light a little; bright ones don't flood the desk.
    this.glowLevel = Math.min(1, 0.06 + (0.2126 * r + 0.7152 * gr + 0.0722 * bl) * 2.6);
  }

  /** The maker's name, printed on the lower bezel. */
  private wordmark(y: number, z: number): THREE.Mesh {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 96;
    const g = c.getContext('2d')!;
    const text = 'THERMALRIGHT';
    g.font = '600 58px "Helvetica Neue", "Segoe UI", Inter, Arial, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = '#2a2d32';
    // Wide tracking, letter by letter: `letterSpacing` is not everywhere yet.
    const track = 15;
    const widths = [...text].map((ch) => g.measureText(ch).width);
    let x = (c.width - (widths.reduce((a, b) => a + b, 0) + track * (text.length - 1))) / 2;
    [...text].forEach((ch, i) => {
      g.fillText(ch, x, c.height / 2 + 2);
      x += widths[i]! + track;
    });
    const map = this.keep(new THREE.CanvasTexture(c));
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    const width = 0.5;
    const mesh = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(width, (width * c.height) / c.width)), this.keep(new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.7, metalness: 0, depthWrite: false })));
    mesh.position.set(0, y, z);
    return mesh;
  }
}
