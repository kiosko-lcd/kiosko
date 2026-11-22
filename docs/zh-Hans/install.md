# Kiosko 快速入门

Kiosko 可以把各种小组件（时钟、天气、日历、系统状态、AI 智能体会话……）排列在小尺寸的 USB LCD 副屏上，比如利民 Thermalright 的 Trofeo Vision 9.16 英寸长条副屏和一体式水冷冷头上的屏幕。
你在浏览器里的可视化编辑器中排版，后台运行的小程序会让副屏上的内容始终保持最新。

> 想先看看？打开 <https://kioskolcd.dev/demo/> 就能在浏览器里试用真正的编辑器，无需安装任何东西。

## 安装

### Windows：使用安装程序

不需要 Node.js。

1. 从 [最新版本](https://github.com/kiosko-lcd/kiosko/releases/latest) 下载 `Kiosko-Setup-<版本>-x64.exe`。（国内访问 GitHub 下载可能很慢，见下文“[国内网络](#国内网络)”。）
2. 运行它。安装程序只为当前用户安装，**不需要管理员权限**。安装时可以勾选“登录时启动 Kiosko”和“把 `kiosko` 命令添加到 `PATH`”。
3. 从“开始”菜单打开 **Kiosko**。

安装程序目前还没有代码签名，所以 Windows SmartScreen 可能会弹出警告：请点击 **更多信息 → 仍要运行**。卸载时会保留你的设置。

如果要通过 USB 连接副屏，每块副屏需要先安装一次 WinUSB 驱动，步骤见 [通过 USB 连接副屏](usb.md)。

如果已经装了 Node.js，在 Windows 上也可以改用下面的 `npm install -g kiosko`。

### Linux 和 macOS：使用 npm

需要 **Node.js 22.18 或更高版本**（可从 <https://nodejs.org/> 下载，国内用户见下文“[国内网络](#国内网络)”）。在终端中运行：

```sh
npm install -g kiosko
```

官方插件（天气、日历、系统状态、新闻等）会一并安装。

## 国内网络

在中国大陆，npm 官方源和 GitHub 下载有时会很慢甚至超时。可以改用 npmmirror（原淘宝 npm 镜像）：

**npm 包**：把 npm 源切换到 npmmirror：

```sh
npm config set registry https://registry.npmmirror.com
npm install -g kiosko
```

如果不想修改全局设置，也可以只在这一次安装时指定：

```sh
npm install -g kiosko --registry https://registry.npmmirror.com
```

**Node.js 本身**：可以从 npmmirror 的二进制镜像下载安装包：<https://npmmirror.com/mirrors/node/>。进入版本号目录（22.18 或更高），Windows 选 `.msi`，macOS 选 `.pkg`，Linux 选 `.tar.xz`。

**Windows 安装程序**：它只发布在 GitHub 上，国内下载可能很慢。如果下载不下来，推荐改走 npm 路线：先从上面的镜像安装 Node.js，再用 npmmirror 运行 `npm install -g kiosko`。这样装出来的功能完全一样，只是没有“开始”菜单里的快捷方式，用命令 `kiosko start --open` 启动即可。

另外，部分插件需要访问境外服务（例如天气插件使用的 Open-Meteo、新闻插件订阅的 RSS 源），在国内网络环境下可能无法获取数据。

## 第一次运行

```sh
kiosko start --open
```

这个命令会启动 Kiosko，并在浏览器中打开编辑器，地址是 <http://127.0.0.1:7420>。（用安装程序装的 Windows 用户，从“开始”菜单打开 Kiosko 即可。）

第一次运行时，Kiosko 会创建一个“虚拟屏幕”并放上几个小组件，让你在连接任何硬件之前就能先上手体验。在编辑器里：

- 把小组件拖到按实际比例绘制的副屏上，在网格上调整大小；
- 把一个小组件拖到另一个上面，它们就会叠在一起轮流显示；
- 编辑器里看到的画面，和副屏上显示的是同一套代码画出来的。

接上副屏后，进入 **屏幕 → 添加屏幕**，选择 **副屏型号** 和连接方式：

| 连接方式 | 适用情况 |
|---|---|
| **Virtual**（虚拟） | 没有硬件：只在编辑器中显示。 |
| **USB** | LY 系列副屏（`0416:5408` / `5409`，例如 Trofeo Vision 9.16），由 Kiosko 直接驱动，支持 Linux、macOS、Windows。目前仍是实验性功能，详见 [通过 USB 连接副屏](usb.md)。 |
| **trcc serve** | Linux，配合运行 `trcc serve` 的 [thermalright-trcc-linux](https://github.com/Lexonight1/thermalright-trcc-linux)。 |
| **Frame file**（帧文件） | Kiosko 写出 `frame.jpg`，再由外部的发送程序推送到副屏上。 |

**检测副屏** 按钮会列出 Kiosko 找到的 USB 副屏。

想让 Kiosko 在登录时自动启动（如果安装程序还没帮你设置）：

```sh
kiosko service install
```

## 切换到简体中文

在编辑器中进入 **Settings → Language**（中文界面下是 **设置 → 语言**），选择 **简体中文**。
这个设置同时决定编辑器的界面语言，以及副屏上小组件显示的文字（日期、星期、天气描述等）。选择 **自动** 则跟随系统语言。

## 中文字体

副屏上的中文、日文和韩文使用**系统自带的字体**来绘制：

| 系统 | 使用的字体 |
|---|---|
| Windows | 微软雅黑（Microsoft YaHei）；繁体中文使用微软正黑体（Microsoft JhengHei） |
| macOS | 苹方（PingFang） |
| Linux | Noto Sans CJK（思源黑体） |

在 Debian 或 Ubuntu 上如果缺少中文字体，请安装：

```sh
sudo apt install fonts-noto-cjk
```

（Fedora：`google-noto-sans-cjk-fonts`；Arch：`noto-fonts-cjk`。）在 Windows 上，如果字体缺失，可以在 **设置 → 应用 → 可选功能** 中添加“中文补充字体”。

想用别的字体？把 `.otf` 字体文件（例如 Noto Sans SC）放进 Kiosko 主目录下的 `fonts` 文件夹，Kiosko 会优先使用它：

| 系统 | `fonts` 文件夹的位置 |
|---|---|
| Windows | `%APPDATA%\Kiosko\fonts` |
| macOS | `~/Library/Application Support/Kiosko/fonts` |
| Linux | `~/.config/kiosko/fonts` |

不确定当前用的是哪个字体？运行：

```sh
kiosko doctor
```

`fonts` 这一行会告诉你中文是用哪个字体绘制的；如果找不到任何中文字体（中文会显示成空白方框），它也会告诉你怎么补上。

## 与利民官方 TRCC 软件同时使用

**同一块副屏同一时间只能由一个程序控制。** 要让 Kiosko 驱动副屏，请先关闭利民 Thermalright 官方的 TRCC 软件（在 Linux 上则是停止 `trcc serve` 或其他发送程序），两者不能同时使用同一块副屏。

另外，在 Windows 上给副屏换成 WinUSB 驱动之后，TRCC 就识别不到这块副屏了；如果想换回 TRCC，可以在“设备管理器”中恢复原来的驱动。详见 [通过 USB 连接副屏](usb.md)。

## 更新 Kiosko

Kiosko 每天会向 npm（你设置的源，例如 npmmirror）询问一次是否有新版本。有新版本时，编辑器顶栏会显示提示（点 × 关闭后，直到下一个版本才会再出现），**插件 → 更新** 里会列出新功能（GitHub 的发行说明；连不上 GitHub 时只列出 npm 上的版本号）、因此可以更新的插件，以及适合你安装方式的更新方法：

- **npm（Linux、macOS）**：点 **将 Kiosko 更新到 …**。Kiosko 会用你的 npm 和源安装该版本，确认新版本能启动并加载你的插件，然后重启；任何一步失败都会装回原来的版本。也可以手动运行 `npm install -g kiosko@<版本> --registry https://registry.npmmirror.com`，再重启 Kiosko。
- **Windows 安装程序**：点同一个按钮，Kiosko 会从 GitHub 下载该版本的 `Kiosko-Setup-<版本>-x64.exe`，用发行版公布的 `.sha256` 校验，你确认后才运行。连不上 GitHub 时，请从其他渠道下载安装程序并手动运行。
- **Windows 上的 npm**：先停止 Kiosko，再运行上面的 npm 命令，然后重新启动。
- **源代码**：`git pull && npm install && npm run web:build`，然后重启。

每一步都会记录在 **活动记录** 中。

## 故障排查与求助

- 先运行 `kiosko doctor`：它会列出 Kiosko 的版本、配置文件、已加载的插件、中文字体、Kiosko 能看到的 USB 副屏（含序列号），以及每个屏幕的状态。
- 编辑器的 **活动记录** 页面会显示详细的运行日志。
- 有问题或建议，欢迎到 GitHub 提 issue：<https://github.com/kiosko-lcd/kiosko/issues>。请附上 `kiosko doctor` 的输出。
