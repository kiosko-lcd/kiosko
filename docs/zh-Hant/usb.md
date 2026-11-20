# 透過 USB 連接面板

**USB** 連線（`"device": { "driver": "usb" }`）讓 Kiosko 透過 libusb 自己和 Thermalright LY 系列面板（Trofeo Vision 9.16 及同系列；USB `0416:5408` 和 `0416:5409`）通訊，不需要 Python，也不需要 `trcc serve`。

```json
"device": { "driver": "usb", "serial": "202592047DAE" }
```

- `serial`：USB 序號。**有多個相同的面板時，序號是唯一能區分它們的依據**，所以請務必填寫。找不到指定序號的面板時，Kiosko 會一直等它出現，絕不會改用另一個面板（若搶走另一個程式正在使用的相同面板，會讓那個面板變成黑畫面）。留空：使用第一個找到的面板。
- `keepalive`：畫面沒有變化時，重新傳送同一個影格的間隔秒數（預設 1）。最後一個影格送出後 2–3 秒，韌體就會重新顯示出廠標誌。

`kiosko doctor` 會列出 libusb 看得到的面板及其序號；在編輯器的 **螢幕 → 新增螢幕 → 偵測面板** 中也能直接選擇它們。

影格一律以 JPEG 格式傳送。韌體最多只接受約 511 871 位元組，超過的影格會被**默默丟棄**；Kiosko 會讀取面板的確認回應，並在該螢幕的狀態中告訴你（「面板丟棄了一個 … KB 的影格：請調低 JPEG 品質」）。

## 各作業系統需要做什麼

**Linux。** 你的使用者帳號必須有權限開啟這個裝置。如果 `kiosko doctor` 顯示 `(unreadable)` 或存取錯誤，請加入一條 udev 規則，然後重新插拔面板：

```
# /etc/udev/rules.d/99-kiosko-lcd.rules
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0416", ATTR{idProduct}=="540[89]", TAG+="uaccess"
```

（接著執行 `sudo udevadm control --reload && sudo udevadm trigger`。）Kiosko 使用面板期間會暫時卸離核心驅動程式，停止時再交還。兩個程式不能同時使用同一個面板：要交給 Kiosko 的面板，請先停止正在驅動它的 `trcc serve` 或 `kiosko-sender`。

**Windows。** libusb 只看得到使用 **WinUSB** 驅動程式的裝置，所以每個面板都要先用免費工具 [Zadig](https://zadig.akeo.ie/) 換上 WinUSB 驅動程式。這件事每個面板只需做一次：

1. 下載並執行 Zadig。它需要系統管理員權限，跳出「使用者帳戶控制」視窗時請按 **是**。
2. 在選單中勾選 **Options → List All Devices**（列出所有裝置），否則清單裡可能看不到面板。
3. 從下拉式清單中選擇面板。辨認的方法是看下方的 USB ID：`0416` 和 `5408`（或 `5409`）。**請小心不要選錯**，選到滑鼠、鍵盤或其他裝置會讓它們無法正常使用。
4. 在箭頭右邊的驅動程式欄位選擇 **WinUSB**。
5. 按 **Replace Driver**（取代驅動程式），等待完成。

換上 WinUSB 之後，Thermalright 官方的 TRCC 軟體就看不到這個面板了；如果需要改回來，可以在「裝置管理員」中還原原本的驅動程式。沒有安裝 WinUSB 時，`kiosko doctor` 會顯示 `LIBUSB_ERROR_NOT_SUPPORTED`。

**macOS。** 不需要安裝任何東西。

原生模組（`usb`）是**選用**的相依套件，附有 Linux、macOS 和 Windows 的預先編譯版本；即使它無法載入，Kiosko 的其他功能仍照常運作，這個連線方式也會告訴你原因。

## 開發狀態

本功能依據 [thermalright-trcc-linux](https://github.com/Lexonight1/thermalright-trcc-linux) 9.12 所實作的通訊協定撰寫：對 `packages/usb-ly` 中的 22 個測試影格（由 `trcc` 本身產生），每個影格送出的位元組資料流與 `trcc` 完全相同，其餘部分則以模擬的韌體進行測試。**目前還沒有在真正的面板上執行過**，也還沒在 macOS 或 Windows 上執行過：請把它當成實驗性功能，並保留 `trcc serve` 或畫面檔案傳送程式作為備案。
