/** The viewer's few words, in the languages Kiosko speaks; the browser's language picks. */
const TEXTS = {
  en: {
    title: 'Kiosko screen',
    pair: 'Pair this screen',
    steps: 'In Kiosko’s editor go to Screens → Add screen → Browser, and type this code:',
    thisOne: 'This browser',
    connecting: 'Connecting to Kiosko…',
    offline: 'Kiosko is not answering. Trying again…',
    menu: 'Menu',
    full: 'Full screen',
    forget: 'Forget the pairing',
    forgetAsk: 'Forget the pairing? Kiosko will have to pair this browser again.',
    close: 'Close',
    awakeLock: 'Kept awake (Wake Lock)',
    awakeVideo: 'Kept awake (video)',
    awakeNone: 'This browser may let the screen sleep: see the guide',
    hint: 'Tap for full screen. Hold for the menu.',
  },
  es: {
    title: 'Pantalla de Kiosko',
    pair: 'Empareja esta pantalla',
    steps: 'En el editor de Kiosko ve a Pantallas → Añadir pantalla → Navegador y escribe este código:',
    thisOne: 'Este navegador',
    connecting: 'Conectando con Kiosko…',
    offline: 'Kiosko no responde. Reintentando…',
    menu: 'Menú',
    full: 'Pantalla completa',
    forget: 'Olvidar el emparejamiento',
    forgetAsk: '¿Olvidar el emparejamiento? Kiosko tendrá que emparejar este navegador otra vez.',
    close: 'Cerrar',
    awakeLock: 'Sin apagarse (Wake Lock)',
    awakeVideo: 'Sin apagarse (vídeo)',
    awakeNone: 'Este navegador puede dejar que la pantalla se apague: mira la guía',
    hint: 'Toca para pantalla completa. Mantén pulsado para el menú.',
  },
  de: {
    title: 'Kiosko-Bildschirm',
    pair: 'Diesen Bildschirm koppeln',
    steps: 'Im Kiosko-Editor: Bildschirme → Bildschirm hinzufügen → Browser, dann diesen Code eingeben:',
    thisOne: 'Dieser Browser',
    connecting: 'Verbinde mit Kiosko…',
    offline: 'Kiosko antwortet nicht. Neuer Versuch…',
    menu: 'Menü',
    full: 'Vollbild',
    forget: 'Kopplung vergessen',
    forgetAsk: 'Kopplung vergessen? Kiosko muss diesen Browser dann neu koppeln.',
    close: 'Schließen',
    awakeLock: 'Bleibt an (Wake Lock)',
    awakeVideo: 'Bleibt an (Video)',
    awakeNone: 'Dieser Browser lässt den Bildschirm eventuell ausgehen: siehe Anleitung',
    hint: 'Tippen für Vollbild. Gedrückt halten für das Menü.',
  },
  'zh-Hans': {
    title: 'Kiosko 屏幕',
    pair: '配对此屏幕',
    steps: '在 Kiosko 编辑器中前往 屏幕 → 添加屏幕 → 浏览器，然后输入此代码：',
    thisOne: '此浏览器',
    connecting: '正在连接 Kiosko…',
    offline: 'Kiosko 没有响应，正在重试…',
    menu: '菜单',
    full: '全屏',
    forget: '取消配对',
    forgetAsk: '取消配对？之后 Kiosko 需要重新配对此浏览器。',
    close: '关闭',
    awakeLock: '保持常亮（Wake Lock）',
    awakeVideo: '保持常亮（视频）',
    awakeNone: '此浏览器可能会让屏幕休眠：请参阅指南',
    hint: '轻触进入全屏，长按打开菜单。',
  },
  'zh-Hant': {
    title: 'Kiosko 螢幕',
    pair: '配對此螢幕',
    steps: '在 Kiosko 編輯器中前往 螢幕 → 新增螢幕 → 瀏覽器，然後輸入此代碼：',
    thisOne: '此瀏覽器',
    connecting: '正在連線至 Kiosko…',
    offline: 'Kiosko 沒有回應，正在重試…',
    menu: '選單',
    full: '全螢幕',
    forget: '取消配對',
    forgetAsk: '取消配對？之後 Kiosko 需要重新配對此瀏覽器。',
    close: '關閉',
    awakeLock: '保持常亮（Wake Lock）',
    awakeVideo: '保持常亮（影片）',
    awakeNone: '此瀏覽器可能會讓螢幕休眠：請參閱指南',
    hint: '輕觸進入全螢幕，長按開啟選單。',
  },
} as const;

export type ViewerText = keyof (typeof TEXTS)['en'];
export const VIEWER_LANGS = Object.keys(TEXTS) as (keyof typeof TEXTS)[];

/** The language for these tags (navigator.languages): zh-TW, zh-HK and zh-Hant are traditional; other Chinese simplified. */
export function viewerLang(tags: readonly string[]): keyof typeof TEXTS {
  for (const raw of tags) {
    const t = raw.toLowerCase();
    if (t.startsWith('zh')) return /hant|-tw|-hk|-mo/.test(t) ? 'zh-Hant' : 'zh-Hans';
    const base = t.split('-')[0] as keyof typeof TEXTS;
    if (base in TEXTS) return base;
  }
  return 'en';
}

export function textsFor(lang: keyof typeof TEXTS): Record<ViewerText, string> {
  return TEXTS[lang];
}
