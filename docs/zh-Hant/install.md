# Kiosko 快速入門

Kiosko 能把各種小工具（時鐘、天氣、行事曆、系統狀態、AI 代理工作階段……）排列在小型 USB LCD 面板上，例如利民 Thermalright 的 Trofeo Vision 9.16 吋長條面板與一體式水冷頭上的螢幕。
你在瀏覽器裡的視覺化編輯器中排版，背景執行的小程式會讓面板上的內容隨時保持最新。

> 想先看看？到 <https://kioskolcd.dev/demo/> 就能在瀏覽器裡試用真正的編輯器，不必安裝任何東西。

## 安裝

### Windows：使用安裝程式

不需要 Node.js。

1. 從 [最新版本](https://github.com/kiosko-lcd/kiosko/releases/latest) 下載 `Kiosko-Setup-<版本>-x64.exe`。
2. 執行它。安裝程式只為目前的使用者安裝，**不需要系統管理員權限**。安裝時可以勾選「登入時啟動 Kiosko」以及「把 `kiosko` 指令加入 `PATH`」。
3. 從「開始」功能表開啟 **Kiosko**。

安裝程式目前還沒有程式碼簽章，所以 Windows SmartScreen 可能會跳出警告：請按 **其他資訊 → 仍要執行**。解除安裝時會保留你的設定。

如果要透過 USB 連接面板，每個面板需要先安裝一次 WinUSB 驅動程式，步驟請見 [透過 USB 連接面板](usb.md)。

已經裝了 Node.js 的話，在 Windows 上也可以改用下面的 `npm install -g kiosko`。

### Linux 與 macOS：使用 npm

需要 **Node.js 22.18 或更新版本**（可到 <https://nodejs.org/> 下載）。在終端機中執行：

```sh
npm install -g kiosko
```

官方外掛（天氣、行事曆、系統狀態、新聞等）會一併安裝。

## 第一次執行

```sh
kiosko start --open
```

這個指令會啟動 Kiosko，並在瀏覽器中開啟編輯器，網址是 <http://127.0.0.1:7420>。（Windows 使用者從「開始」功能表開啟 Kiosko 即可。）

第一次執行時，Kiosko 會建立一個「虛擬螢幕」並放上幾個小工具，讓你在接上任何硬體之前就能先玩玩看。在編輯器裡：

- 把小工具拖到依實際比例繪製的面板上，在格線上調整大小；
- 把一個小工具拖到另一個上面，就會疊在一起輪流顯示；
- 你在編輯器裡看到的畫面，和面板上顯示的是同一套程式畫出來的。

接上面板後，到 **螢幕 → 新增螢幕**，選擇 **面板型號** 和連線方式：

| 連線方式 | 適用情況 |
|---|---|
| **Virtual**（虛擬） | 沒有硬體：只在編輯器中顯示。 |
| **USB** | LY 系列面板（`0416:5408` / `5409`，例如 Trofeo Vision 9.16），由 Kiosko 直接驅動，支援 Linux、macOS、Windows。仍屬實驗性功能，詳見 [透過 USB 連接面板](usb.md)。 |
| **trcc serve** | Linux，搭配執行 `trcc serve` 的 [thermalright-trcc-linux](https://github.com/Lexonight1/thermalright-trcc-linux)。 |
| **Frame file**（畫面檔案） | Kiosko 寫出 `frame.jpg`，再由外部的傳送程式送到面板上。 |

**偵測面板** 按鈕會列出 Kiosko 找到的 USB 面板。

想讓 Kiosko 在登入時自動啟動（如果安裝程式還沒幫你設定）：

```sh
kiosko service install
```

## 切換成繁體中文

到編輯器的 **Settings → Language**（中文介面下是 **設定 → 語言**），選擇 **繁體中文**。
這個設定同時決定編輯器的介面語言，以及面板上小工具顯示的文字（日期、星期、天氣說明等）。選 **自動** 則會跟隨系統語言。

## 中文字型

面板上的中文、日文和韓文會使用**系統內建的字型**來繪製：

| 系統 | 使用的字型 |
|---|---|
| Windows | 微軟正黑體（Microsoft JhengHei）；簡體中文使用微軟雅黑（Microsoft YaHei） |
| macOS | 蘋方（PingFang） |
| Linux | Noto Sans CJK |

在 Debian 或 Ubuntu 上如果缺少中文字型，請安裝：

```sh
sudo apt install fonts-noto-cjk
```

（Fedora：`google-noto-sans-cjk-fonts`；Arch：`noto-fonts-cjk`。）在 Windows 上，如果字型不見了，可以到 **設定 → 應用程式 → 選用功能** 加入「中文補充字型」。

想用別的字型？把 `.otf` 字型檔（例如 Noto Sans TC）放進 Kiosko 主資料夾裡的 `fonts` 資料夾，Kiosko 會優先使用它：

| 系統 | `fonts` 資料夾的位置 |
|---|---|
| Windows | `%APPDATA%\Kiosko\fonts` |
| macOS | `~/Library/Application Support/Kiosko/fonts` |
| Linux | `~/.config/kiosko/fonts` |

不確定目前用的是哪個字型？執行：

```sh
kiosko doctor
```

`fonts` 那一行會告訴你中文是由哪個字型繪製的；如果找不到任何中文字型（中文字會變成空白方框），它也會告訴你該怎麼補上。

## 與 Thermalright 官方 TRCC 軟體並用

**同一個面板一次只能由一個程式控制。** 要讓 Kiosko 驅動面板，請先關閉 Thermalright 官方的 TRCC 軟體（在 Linux 上則是停止 `trcc serve` 或其他傳送程式），兩者不能同時使用同一個面板。

另外，在 Windows 上為面板換成 WinUSB 驅動程式之後，TRCC 就看不到這個面板了；想改回來用 TRCC，可以在「裝置管理員」中還原原本的驅動程式。詳見 [透過 USB 連接面板](usb.md)。

## 更新 Kiosko

Kiosko 每天會向 npm（你設定的來源）詢問一次是否有新版本。有新版本時，編輯器頂端會顯示提示（點 × 關閉後，直到下一個版本才會再出現），**外掛 → 更新** 會列出新功能（GitHub 的發行說明；連不上 GitHub 時只列出 npm 上的版本號）、因此可以更新的外掛，以及適合你安裝方式的更新方法：

- **npm（Linux、macOS）**：點 **將 Kiosko 更新至 …**。Kiosko 會用你的 npm 與來源安裝該版本，確認新版本能啟動並載入你的外掛，然後重新啟動；任何一步失敗都會裝回原本的版本。也可以手動執行 `npm install -g kiosko@<版本>`，再重新啟動 Kiosko。
- **Windows 安裝程式**：點同一個按鈕，Kiosko 會從 GitHub 下載該版本的 `Kiosko-Setup-<版本>-x64.exe`，以發行版本公布的 `.sha256` 驗證，你確認後才執行。
- **Windows 上的 npm**：先停止 Kiosko，再執行上面的 npm 指令，然後重新啟動。
- **原始碼**：`git pull && npm install && npm run web:build`，然後重新啟動。

每一步都會記錄在 **活動紀錄** 中。

## 疑難排解與求助

- 先執行 `kiosko doctor`：它會列出 Kiosko 的版本、設定檔、已載入的外掛、中文字型、Kiosko 看得到的 USB 面板（含序號），以及每個螢幕的狀態。
- 編輯器的 **活動紀錄** 頁面會顯示詳細的執行紀錄。
- 有問題或建議，歡迎到 GitHub 開 issue：<https://github.com/kiosko-lcd/kiosko/issues>。請附上 `kiosko doctor` 的輸出結果。
