/** The 3D page's words, by language: every language Kiosko speaks has them (a test checks). */
type Words = {
  tagline: string;
  starting: string;
  failed: string;
  one: string;
  three: string;
  orbit: string;
  record: string;
  stop: string;
  editor: string;
  hint: string;
  note: string;
  quality: { high: string; medium: string; low: string };
  interlude: string;
};

export const TEXTS: Record<string, Words> = {
  en: {
    tagline: 'A panel on your desk, in 3D. Its screen is painted live, in your browser, by the same code that drives the real one.',
    starting: 'Starting Kiosko in your browser…',
    failed: 'This browser could not start the 3D view',
    one: 'One panel',
    three: 'Three panels',
    orbit: 'Camera sway',
    record: 'Record',
    stop: 'Stop',
    editor: 'Open the editor',
    hint: 'Drag to look around · scroll to zoom · H hides this',
    note: 'Sample data. Thermalright is a trademark of its owner; Kiosko is an independent open-source project.',
    quality: { high: 'High quality', medium: 'Medium quality', low: 'Low quality' },
    interlude: 'interlude',
  },
  es: {
    tagline: 'Un panel en tu mesa, en 3D. Su pantalla la pinta en directo, en tu navegador, el mismo código que mueve el de verdad.',
    starting: 'Arrancando Kiosko en tu navegador…',
    failed: 'Este navegador no ha podido arrancar la vista 3D',
    one: 'Un panel',
    three: 'Tres paneles',
    orbit: 'Vaivén de cámara',
    record: 'Grabar',
    stop: 'Parar',
    editor: 'Abrir el editor',
    hint: 'Arrastra para mirar alrededor · rueda para acercar · H oculta esto',
    note: 'Datos de muestra. Thermalright es una marca de su propietario; Kiosko es un proyecto independiente de código abierto.',
    quality: { high: 'Calidad alta', medium: 'Calidad media', low: 'Calidad baja' },
    interlude: 'interludio',
  },
  'zh-Hant': {
    tagline: '桌上的一塊面板，以 3D 呈現。它的畫面由驅動真實面板的同一套程式碼，在你的瀏覽器裡即時繪製。',
    starting: '正在你的瀏覽器中啟動 Kiosko…',
    failed: '這個瀏覽器無法啟動 3D 檢視',
    one: '一塊面板',
    three: '三塊面板',
    orbit: '鏡頭擺動',
    record: '錄影',
    stop: '停止',
    editor: '開啟編輯器',
    hint: '拖曳以環顧四周 · 滾輪縮放 · 按 H 隱藏說明',
    note: '範例資料。Thermalright 為其所有者的商標；Kiosko 是獨立的開放原始碼專案。',
    quality: { high: '高畫質', medium: '中畫質', low: '低畫質' },
    interlude: '過場動畫',
  },
  'zh-Hans': {
    tagline: '桌上的一块副屏，以 3D 呈现。它的画面由驱动真实副屏的同一套代码，在你的浏览器里实时绘制。',
    starting: '正在你的浏览器中启动 Kiosko…',
    failed: '这个浏览器无法启动 3D 视图',
    one: '一块副屏',
    three: '三块副屏',
    orbit: '镜头摆动',
    record: '录制',
    stop: '停止',
    editor: '打开编辑器',
    hint: '拖动以环顾四周 · 滚轮缩放 · 按 H 隐藏说明',
    note: '示例数据。Thermalright（利民）是其所有者的商标；Kiosko 是独立的开源项目。',
    quality: { high: '高画质', medium: '中画质', low: '低画质' },
    interlude: '过场动画',
  },
};
