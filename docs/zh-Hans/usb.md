# 通过 USB 连接副屏

**USB** 连接（`"device": { "driver": "usb" }`）让 Kiosko 通过 libusb 直接与利民 Thermalright LY 系列副屏（Trofeo Vision 9.16 及同系列；USB `0416:5408` 和 `0416:5409`）通信，不需要 Python，也不需要 `trcc serve`。

```json
"device": { "driver": "usb", "serial": "202592047DAE" }
```

- `serial`：USB 序列号。**有多块相同的副屏时，序列号是唯一能区分它们的依据**，所以请务必填写。找不到指定序列号的副屏时，Kiosko 会一直等它出现，绝不会换用另一块副屏（如果抢走另一个程序正在使用的同款副屏，会让那块副屏黑屏）。留空：使用找到的第一块副屏。
- `keepalive`：画面没有变化时，重新发送同一帧的间隔秒数（默认 1）。最后一帧发出 2–3 秒后，固件就会重新显示出厂 Logo。

`kiosko doctor` 会列出 libusb 能看到的副屏及其序列号；在编辑器的 **屏幕 → 添加屏幕 → 检测屏幕** 中也可以直接选择它们。

帧始终以 JPEG 格式发送。固件最多只接受约 511 871 字节，超过的帧会被**静默丢弃**；Kiosko 会读取副屏的确认应答，并在该屏幕的状态中提示你（“屏幕丢弃了一个 … KB 的帧：请降低 JPEG 质量”）。

## 各系统需要做什么

**Linux。** 你的用户必须有权限打开这个设备。如果 `kiosko doctor` 显示 `(unreadable)` 或访问错误，请添加一条 udev 规则，然后重新插拔副屏：

```
# /etc/udev/rules.d/99-kiosko-lcd.rules
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0416", ATTR{idProduct}=="540[89]", TAG+="uaccess"
```

（然后运行 `sudo udevadm control --reload && sudo udevadm trigger`。）Kiosko 使用副屏期间会暂时分离内核驱动，停止时再交还。两个程序不能同时使用同一块副屏：要交给 Kiosko 的副屏，请先停止正在驱动它的 `trcc serve` 或 `kiosko-sender`。

**Windows。** libusb 只能看到使用 **WinUSB** 驱动的设备，所以每块副屏都要先用免费工具 [Zadig](https://zadig.akeo.ie/) 换上 WinUSB 驱动。每块副屏只需要做一次：

1. 下载并运行 Zadig。它需要管理员权限，弹出“用户账户控制”窗口时请点击 **是**。
2. 在菜单中勾选 **Options → List All Devices**（列出所有设备），否则列表里可能看不到副屏。
3. 在下拉列表中选择副屏。辨认方法是看下方显示的 USB ID：`0416` 和 `5408`（或 `5409`）。**注意不要选错**，选成鼠标、键盘或其他设备会导致它们无法正常工作。
4. 在箭头右侧的驱动框中选择 **WinUSB**。
5. 点击 **Replace Driver**（替换驱动），等待完成。

换上 WinUSB 之后，利民官方的 TRCC 软件就识别不到这块副屏了；如果需要换回来，可以在“设备管理器”中恢复原来的驱动。没有安装 WinUSB 时，`kiosko doctor` 会显示 `LIBUSB_ERROR_NOT_SUPPORTED`。

**macOS。** 无需安装任何东西。

原生模块（`usb`）是**可选**依赖，提供 Linux、macOS 和 Windows 的预编译二进制文件；即使它无法加载，Kiosko 的其他功能仍然正常，这种连接方式也会告诉你原因。

## 开发状态

本功能依据 [thermalright-trcc-linux](https://github.com/Lexonight1/thermalright-trcc-linux) 9.12 实现的协议编写：对于 `packages/usb-ly` 中的 22 个测试帧（由 `trcc` 本身生成），每一帧发出的字节流与 `trcc` 完全相同，其余部分则用模拟固件进行测试。**目前还没有在真实的副屏上运行过**，也还没有在 macOS 或 Windows 上运行过：请把它当作实验性功能，并保留 `trcc serve` 或帧文件发送程序作为备用方案。
