/**
 * The 3D page's scene: one panel, or a stack of three, floating over a dark
 * desk (the real ones have no stand: a magnet on the back holds them to a
 * PC case). The screens are the only bright thing in the room: each lights the
 * desk in front of it with the colour of its picture, the desk mirrors them
 * faintly and a little bloom makes them glow.
 *
 * It adapts to the machine: when frames take too long it gives up, in turn,
 * resolution, the mirror and the shadows (see `LEVELS`).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { PANEL, Panel } from './panel.ts';

export type Quality = 'high' | 'medium' | 'low';

/** What each quality level costs: pixels, anti-aliasing, the desk's mirror (scale of its picture; 0 = none) and the shadow map. */
const LEVELS: Record<Quality, { ratio: number; samples: number; mirror: number; shadow: number }> = {
  high: { ratio: 2, samples: 4, mirror: 0.6, shadow: 2048 },
  medium: { ratio: 1.25, samples: 4, mirror: 0.4, shadow: 1024 },
  low: { ratio: 1, samples: 0, mirror: 0, shadow: 0 },
};
const ORDER: Quality[] = ['high', 'medium', 'low'];

const BACKGROUND = 0x05060a;
/** How far back the panels lean. */
const TILT = THREE.MathUtils.degToRad(8);
/** How high over the desk they float. */
const HOVER = 0.16;
/** Between stacked panels: they touch. */
const GAP = 0.004;
/** Where the camera starts: a little to the right and above, as in a product shot. */
const HOME = { azimuth: 0.44, polar: THREE.MathUtils.degToRad(79) };
/** The camera sways this much on its own (see `tick`), and this slowly. */
const DRIFT = { speed: 0.8, rate: 0.21 };
const INTRO_MS = 2800;

/** Last touch: darker corners, and a grain too fine to see that keeps the dark gradients from banding. */
const FinishShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uTime: { value: 0 }, uVignette: { value: 0.42 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float edge = smoothstep(0.82, 0.22, length((vUv - 0.5) * vec2(1.0, 0.92)));
      c.rgb *= mix(1.0 - uVignette, 1.0, edge);
      c.rgb += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) * (1.6 / 255.0);
      gl_FragColor = c;
    }`,
};

export interface SceneOptions {
  panels: number;
  brand: boolean;
  /** The camera sways by itself. */
  orbit: boolean;
  /** How it sways: so many degrees to each side, there and back in so many seconds (a film that long loops). */
  sway?: { degrees: number; seconds: number };
  /** A fixed level, or `auto` to start high and step down if the machine struggles. */
  quality: Quality | 'auto';
  mirror: boolean;
  /** Where the camera starts: degrees to the right, degrees above the desk, and how close (1 = fitted). */
  view?: { azimuth?: number; elevation?: number; zoom?: number };
  /**
   * Someone else places the camera (the front page, from how far it has been scrolled): no
   * dragging, and the stack grows from one panel to three on request. See `direct`.
   */
  directed?: boolean;
}

/** Where a directed scene is asked to be: it eases there. */
export interface Direction {
  /** Degrees to the right of the panel's front, and above the desk. */
  azimuth: number;
  elevation: number;
  /** 1 = the stack fits the view with room around it. */
  zoom: number;
  /** Where on the page the stack sits, in fractions of the view: 0.25 = a quarter to the right (or down). */
  shiftX: number;
  shiftY: number;
  /** 0 = one panel, 0.5 = two, 1 = the three of them: the others drop onto it one after another. */
  stack: number;
}

/** From how high the panels of a growing stack come down. */
const DROP = 3.4;
const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

export class Scene3D {
  readonly canvas: HTMLCanvasElement;
  panels: Panel[] = [];
  /** Told when the quality steps down by itself. */
  onQuality: ((q: Quality) => void) | null = null;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  /** The visitor's hand on the camera; none in a directed scene. */
  private readonly controls: OrbitControls | null;
  /** What the camera looks at: the middle of the stack. */
  private readonly target = new THREE.Vector3();
  private readonly key: THREE.SpotLight;
  private readonly desk: THREE.Mesh<THREE.CircleGeometry, THREE.MeshPhysicalMaterial>;
  private readonly stack = new THREE.Group();
  private readonly extras = new THREE.Group();
  private mirror: Reflector | null = null;
  private composer!: EffectComposer;
  private finish!: ShaderPass;

  private readonly opts: SceneOptions;
  private level: Quality;
  private readonly auto: boolean;
  private raf = 0;
  private last = 0;
  private time = 0;
  private startedAt = 0;
  private radius = 5;
  /** The visitor has moved the camera: it is theirs now (no intro, no refit on resize). */
  private touched = false;
  private slow = { frames: 0, seconds: 0, strikes: 0, warmup: 90 };
  /** Directed: where it has been asked to be, and where it is now (it arrives from a little further away). */
  private readonly want: Direction = { azimuth: THREE.MathUtils.radToDeg(HOME.azimuth), elevation: 90 - THREE.MathUtils.radToDeg(HOME.polar), zoom: 1, shiftX: 0, shiftY: 0, stack: 0 };
  private readonly at: Direction = { ...this.want, zoom: 0.72 };
  /** It has been told where to be at least once. */
  private placed = false;
  /** Called after each frame is drawn (the front page waits for the first one). */
  onFrame: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, opts: SceneOptions) {
    this.canvas = canvas;
    this.opts = opts;
    this.auto = opts.quality === 'auto';
    this.level = opts.quality === 'auto' ? 'high' : opts.quality;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.setClearColor(BACKGROUND);
    // Keeps the screens' own colours where a filmic curve would wash them out.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    RectAreaLightUniformsLib.init();

    const { scene, camera } = this;
    scene.background = new THREE.Color(BACKGROUND);
    scene.fog = new THREE.FogExp2(BACKGROUND, 0.045);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.3;
    pmrem.dispose();

    // A warm lamp from the front left (the only shadow) and a cold one from behind, for the edges.
    const key = new THREE.SpotLight(0xfff1e0, 1.9, 0, 0.5, 0.9, 0);
    key.position.set(-3.4, 6.5, 5.5);
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.012;
    key.shadow.radius = 5;
    key.shadow.camera.near = 2;
    key.shadow.camera.far = 22;
    this.key = key;
    const rim = new THREE.DirectionalLight(0x7f9fff, 0.6);
    rim.position.set(4.5, 3.5, -5);
    scene.add(key, key.target, rim);

    // Polished, but not so much that the lamp shows on it as a hot spot.
    const desk = new THREE.Mesh(new THREE.CircleGeometry(60, 96), new THREE.MeshPhysicalMaterial({ color: 0x0b0d12, roughness: 0.46, metalness: 0 }));
    desk.rotation.x = -Math.PI / 2;
    desk.receiveShadow = true;
    this.desk = desk;
    scene.add(desk);

    this.stack.rotation.x = -TILT;
    this.stack.position.y = HOVER;
    scene.add(this.stack, this.extras);

    if (opts.directed) this.controls = null;
    else {
      const controls = new OrbitControls(camera, canvas);
      this.controls = controls;
      controls.enableDamping = true;
      controls.dampingFactor = 0.06;
      controls.enablePan = false;
      controls.minPolarAngle = 0.45;
      // Not below the desk.
      controls.maxPolarAngle = 1.53;
      controls.rotateSpeed = 0.55;
      controls.zoomSpeed = 0.7;
      controls.addEventListener('start', () => (this.touched = true));
    }

    this.setPanels(opts.panels);
    this.applyQuality();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  /** One panel, or a stack of them (the feeds must be started again: these are new screens). */
  setPanels(count: number): void {
    for (const p of this.panels) {
      this.stack.remove(p.group);
      p.dispose();
    }
    this.clearExtras();
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.panels = Array.from({ length: Math.max(1, count) }, (_, i) => {
      const p = new Panel({ brand: this.opts.brand, anisotropy });
      p.group.position.set(0, PANEL.h / 2 + i * (PANEL.h + GAP), 0);
      this.stack.add(p.group);
      return p;
    });
    this.stack.updateMatrixWorld(true);
    this.buildCables();
    this.target.copy(this.stack.localToWorld(new THREE.Vector3(0, this.height / 2, 0)));
    this.key.target.position.copy(this.target);
    this.touched = false;
    this.startedAt = 0;
    this.frame();
  }

  /** Directed scenes: where to be from now on (only what is given changes). */
  direct(d: Partial<Direction>): void {
    Object.assign(this.want, d);
    if (this.placed) return;
    // The first time it is already there (a page may open half-way down its story), only a
    // little further away: it comes closer, it doesn't cross the page.
    this.placed = true;
    Object.assign(this.at, this.want, { zoom: this.want.zoom * 0.86 });
  }

  setOrbit(on: boolean): void {
    this.opts.orbit = on;
  }

  get quality(): Quality {
    return this.level;
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Stops drawing (nobody is looking); `start` resumes. */
  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Height of the stack. */
  private get height(): number {
    return this.panels.length * PANEL.h + (this.panels.length - 1) * GAP;
  }

  private clearExtras(): void {
    for (const o of [...this.extras.children]) {
      this.extras.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
  }

  /** A white USB cable from each panel: down from its plug to the desk, and away behind. */
  private buildCables(): void {
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(this.stack.quaternion);
    this.panels.forEach((p, i) => {
      const a = p.group.localToWorld(p.cable);
      const lie = 0.012;
      // Each lands a little further back than the one below; then they run together behind the
      // panels and off to the right, lying on the desk.
      const land = a.z - 0.2 - 0.05 * i;
      const path = new THREE.CatmullRomCurve3(
        [
          a,
          a.clone().addScaledVector(down, 0.09),
          new THREE.Vector3(a.x, a.y * 0.45, (a.z + land) / 2),
          new THREE.Vector3(a.x + 0.03, lie + 0.03, land),
          new THREE.Vector3(a.x + 0.3, lie, land - 0.12),
          new THREE.Vector3(1.0, lie, land - 0.3),
          new THREE.Vector3(2.4, lie, land - 0.75),
          new THREE.Vector3(5, lie, land - 1.9),
          new THREE.Vector3(12, lie, land - 5.5),
        ],
        false,
        'catmullrom',
        0.4,
      );
      const cable = new THREE.Mesh(new THREE.TubeGeometry(path, 140, 0.0085, 8), new THREE.MeshStandardMaterial({ color: 0xe6e8ec, roughness: 0.6 }));
      cable.castShadow = true;
      this.extras.add(cable);
    });
  }

  /** The distance from which a stack fills the view, with room around it, for this window's shape. */
  private fit(height = this.height, air = this.panels.length === 1 ? 2.4 : 1.5): number {
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const wide = (PANEL.w * 1.4) / (2 * t * this.camera.aspect);
    const tall = (height * air) / (2 * t);
    return Math.max(wide, tall);
  }

  /** Puts the camera at its starting place for this stack and window. */
  private frame(): void {
    const { controls } = this;
    if (!controls) return;
    controls.target.copy(this.target);
    const view = this.opts.view ?? {};
    this.radius = this.fit() / Math.max(0.2, view.zoom ?? 1);
    const azimuth = view.azimuth !== undefined ? THREE.MathUtils.degToRad(view.azimuth) : HOME.azimuth;
    const polar = view.elevation !== undefined ? THREE.MathUtils.degToRad(90 - view.elevation) : HOME.polar;
    const offset = new THREE.Vector3(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth)).multiplyScalar(this.radius);
    this.camera.position.copy(controls.target).add(offset);
    controls.minDistance = this.radius * 0.35;
    controls.maxDistance = this.radius * 2.6;
    controls.update();
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, LEVELS[this.level].ratio);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(Math.round(w * ratio), Math.round(h * ratio));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.controls && !this.touched) this.frame();
  }

  private applyQuality(): void {
    const level = LEVELS[this.level];
    const { renderer, scene, key, desk } = this;

    key.castShadow = level.shadow > 0;
    key.shadow.mapSize.set(level.shadow || 512, level.shadow || 512);
    key.shadow.map?.dispose();
    key.shadow.map = null;

    if (this.mirror) {
      scene.remove(this.mirror);
      this.mirror.dispose();
      this.mirror.geometry.dispose();
      this.mirror = null;
    }
    const mirrored = this.opts.mirror && level.mirror > 0;
    if (mirrored) {
      const size = Math.round(1024 * level.mirror * 2);
      const mirror = new Reflector(new THREE.CircleGeometry(60, 64), { textureWidth: size, textureHeight: size, color: 0x8c8c8c, clipBias: 0.002, multisample: level.samples });
      mirror.rotation.x = -Math.PI / 2;
      mirror.position.y = -0.004;
      // Reflector takes the camera's view to be centred. One moved sideways (a directed scene
      // puts the stack to one side of the page) has to be moved the other way for the mirror,
      // whose picture is left to right: otherwise a strip of the desk mirrors nothing and
      // smears the edge of the picture across it.
      const reflect = mirror.onBeforeRender;
      const flipped = new THREE.Matrix4();
      // The same camera, but for its view: made once, it follows the real one in all the rest.
      let seen: THREE.Camera | null = null;
      mirror.onBeforeRender = function (renderer, s, camera, ...rest) {
        if (!camera.projectionMatrix.elements[8]) return reflect.call(this, renderer, s, camera, ...rest);
        if (!seen || Object.getPrototypeOf(seen) !== camera) {
          seen = Object.create(camera) as THREE.Camera;
          seen.projectionMatrix = flipped;
        }
        flipped.copy(camera.projectionMatrix).elements[8]! *= -1;
        reflect.call(this, renderer, s, seen, ...rest);
      };
      scene.add(mirror);
      this.mirror = mirror;
    }
    // The desk lets a little of the mirror under it through: polished, not a looking glass.
    desk.material.transparent = mirrored;
    desk.material.opacity = mirrored ? 0.925 : 1;
    // With the mirror, the desk's own shine would show every light twice (the screens' as a bright blot).
    desk.material.specularIntensity = mirrored ? 0.04 : 0.45;
    desk.material.needsUpdate = true;

    this.composer?.dispose();
    const target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: level.samples });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, this.camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(2, 2), 0.32, 0.6, 0.9));
    composer.addPass(new OutputPass());
    this.finish = new ShaderPass(FinishShader);
    composer.addPass(this.finish);
    this.composer = composer;
    this.resize();
  }

  /** Steps the quality down when frames have been slow for a while (only in `auto`). */
  private measure(dt: number): void {
    if (!this.auto || this.level === 'low') return;
    const s = this.slow;
    if (s.warmup > 0) {
      s.warmup--;
      return;
    }
    s.frames++;
    s.seconds += dt;
    if (s.frames < 90) return;
    const fps = s.frames / s.seconds;
    s.frames = 0;
    s.seconds = 0;
    s.strikes = fps < 38 ? s.strikes + 1 : 0;
    if (s.strikes < 2) return;
    s.strikes = 0;
    s.warmup = 60;
    this.level = ORDER[ORDER.indexOf(this.level) + 1]!;
    this.applyQuality();
    this.onQuality?.(this.level);
  }

  private readonly tick = (ms: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.1, Math.max(0, (ms - this.last) / 1000));
    this.last = ms;
    this.time += dt;
    this.startedAt ||= ms;

    const { controls, camera } = this;
    if (!controls) this.follow(dt);
    else {
      if (!this.touched) {
        // Arriving: the camera comes in from a little further away.
        const p = Math.min(1, (ms - this.startedAt) / INTRO_MS);
        const away = 1 + 0.3 * (1 - p) ** 3;
        camera.position.sub(controls.target).setLength(this.radius * away).add(controls.target);
      }
      // A slow sway from side to side; dragging takes over, and it resumes around wherever it is left.
      controls.autoRotate = this.opts.orbit;
      // (autoRotateSpeed 1 is 6 degrees a second.)
      const swing = this.opts.sway;
      const w = swing ? (2 * Math.PI) / swing.seconds : 0;
      controls.autoRotateSpeed = swing ? (swing.degrees * w * Math.cos(this.time * w)) / 6 : DRIFT.speed * Math.cos(this.time * DRIFT.rate);
      controls.update(dt);
    }

    for (const p of this.panels) p.update(ms, dt);
    this.finish.uniforms.uTime!.value = this.time;
    this.composer.render(dt);
    this.onFrame?.();
    this.measure(dt);
  };

  /** A directed scene eases towards where it was asked to be: the camera, and how tall the stack is. */
  private follow(dt: number): void {
    const { at, want, camera, target } = this;
    const k = 1 - Math.exp(-dt * 4.2);
    for (const key of Object.keys(at) as (keyof Direction)[]) at[key] += (want[key] - at[key]) * k;

    // The panels above the first come down onto it, one after another.
    let grown = 0;
    this.panels.forEach((p, i) => {
      if (i === 0) return;
      // Half of `stack` each, so that 0.5 is exactly two panels.
      const e = smooth((at.stack - (i - 1) * 0.5) / 0.5);
      grown += e;
      p.group.visible = e > 0.002;
      p.group.position.y = PANEL.h / 2 + i * (PANEL.h + GAP) + (1 - e) * DROP;
      // Its cable was laid for where it ends up: it shows once it is there.
      const cable = this.extras.children[i];
      if (cable) cable.visible = e > 0.95;
    });
    const height = PANEL.h + grown * (PANEL.h + GAP);
    target.copy(this.stack.localToWorld(new THREE.Vector3(0, height / 2, 0)));
    this.key.target.position.copy(target);

    const radius = this.fit(height, 2.4 - 0.9 * Math.min(1, grown)) / Math.max(0.2, at.zoom);
    const azimuth = THREE.MathUtils.degToRad(at.azimuth);
    const polar = THREE.MathUtils.degToRad(90 - at.elevation);
    camera.position.set(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth)).multiplyScalar(radius).add(target);
    camera.lookAt(target);
    // Moving the stack on the page without turning the camera: the view is a window on a wider one.
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    camera.setViewOffset(w, h, -at.shiftX * w, -at.shiftY * h, w, h);
  }
}
