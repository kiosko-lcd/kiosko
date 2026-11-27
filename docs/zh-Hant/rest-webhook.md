# JSON 小工具與腳本推送

不必寫外掛，就能把任何東西放上面板的兩種方式：

- **從 URL 取得 JSON。** Kiosko 每隔一段時間查詢一個 URL（API、狀態頁面、你網路上的感測器），並顯示回應中的某個數值：以大字搭配單位和曲線顯示、以清單顯示，或嵌在一句話裡。
- **推送。** 腳本、cron 排程、你的 CI 或 Home Assistant 有事要說時，用一個 `curl` 把數值送給 Kiosko：最近一次備份、一次部署、魚缸的溫度。

兩者都內建於 Kiosko（基本工具外掛）：**JSON 數值**、**JSON 清單**、**JSON 文字**和**推送**都在編輯器的小工具庫中，位於「開發」分類下。

## 從 URL 取得 JSON

新增一個 **JSON 數值**小工具，並填寫：

- **URL**：Kiosko 要查詢的網址，例如
  `https://api.open-meteo.com/v1/forecast?latitude=40.42&longitude=-3.70&current=temperature_2m`
  （免費，不需金鑰）。
- **數值路徑**：數值在回應中的位置，例如 `$.current.temperature_2m`。一開始先留空：方格會列出它在回應中找到的路徑及其數值，方便你複製一個。
- **單位**、**數值前綴**（`$`、`€`）、**小數位數**和**標籤**。

**JSON 清單**會顯示多個數值，每個一列：列出各個**欄位**（每個欄位有標籤、路徑和單位），或指定回應中某個清單的路徑（**或其中的清單**，例如 `$.items`），再指定每個項目內標籤和數值的路徑（`name`、`price`）。物件也能當作清單：每個鍵是一個項目，帶有 `key` 和 `value`。

**JSON 文字**會寫出一句嵌有數值的話：`Backup {$.status} at {$.finished}`。`{$.items[*].name}` 會寫出全部，以逗號分隔；`{{` 和 `}}` 會寫出大括號。

### 路徑

JSONPath 的一小部分，讀取時不會執行任何程式碼：

| 路徑 | 找到 |
|---|---|
| `$` | 整個回應（純文字也可以） |
| `$.current.temperature_2m` | 一個鍵，再一個鍵（`$` 和第一個點可省略：`current.temperature_2m`） |
| `items[0].price` | 清單的第一個項目 |
| `items[-1]` | 最後一個（負數索引從尾端往回數） |
| `['key with spaces']` | 含空格或點的鍵，加上引號（`\` 跳脫引號） |
| `items[*].name`、`prices.*` | 每個項目，或物件的每個值（用於清單和文字） |
| `items.length` | 清單有幾個項目 |

只會讀取回應中確實存在的鍵。路徑最多 300 個字元、32 層，萬用字元最多收集 500 個值。

### 依數值變色

**依數值變色**是一份規則清單；第一條成立的規則決定數值的顏色（綠色、藍色、琥珀色、紅色、主題的強調色或淡色）：

| 規則 | 在數值為下列情況時成立 |
|---|---|
| `>= 30`、`> 30`、`< 0`、`<= 5` | 數字，進行比較 |
| `30` | 大於或等於 30 的數字（單獨一個數字表示 `>=`） |
| `= failed`、`!= ok` | 是（或不是）該文字，不分大小寫；或是該數字 |

在 **JSON 文字**中，**顏色依據**指定規則要看哪個路徑（`$.status`）；沒有設定時，規則看的是整句話。

### 曲線

**JSON 數值**會在數值下方畫出它的歷史：每次重新整理一個點，最多到**曲線點數**（預設 60）。曲線存放在 Kiosko 的快取（記憶體）中，所以重新啟動 Kiosko 不會清空，重新啟動電腦則會。把**歷史曲線**設為「不顯示」，就只顯示數值。

### 金鑰、權杖和標頭

把金鑰或權杖填在**密鑰**：編輯器會遮蔽它，也絕不會寫進記錄。預設會原封不動放進 `Authorization` 標頭，所以請寫完整的值（`Bearer abc123`、`token abc123`）。在進階選項中：

- **密鑰使用的標頭**：改用其他標頭（`X-Api-Key`），或留空。
- 在 URL（`…?apikey={secret}`）、標頭值或內文中寫上 `{secret}`，就會改放在那裡（在 URL 中會經過 URL 編碼）。
- **其他標頭**、**方法**（GET 或 POST）和**內文（POST）**（看起來像 JSON 時以 JSON 送出）。

和 Kiosko 的所有密鑰一樣，它存放在設定檔中（Linux 上為 `~/.config/kiosko/config.json`），只有你能讀取。

### 重新整理、限制和錯誤

- 每個小工具預設每分鐘查詢一次；可用小工具的**重新整理間隔**更改（最短 5 秒；請留意 API 的限制）。兩個小工具在同一時間查詢同一個 URL 時，會共用一次請求。
- **逾時時間**（預設 10 秒，最多 60 秒）和**回應大小上限**（預設 512 KB，最多 5 MB）：超過的回應會被拒絕。
- Kiosko 以 `kiosko-core Kiosko (+https://kioskolcd.dev)` 自我介紹；伺服器給過 ETag 或日期時，會回送 `If-None-Match`/`If-Modified-Since`；伺服器表示「請求太多」（429、`Retry-After`）時，會依指示等待。
- 請求失敗時，小工具會保留最後的數值，編輯器會在小工具選項下方、顯示資料更新時間的地方說明原因（`HTTP 404 from api.example.com`、`timed out after 10 s`、`response larger than 524288 bytes`）。

URL 是你自己輸入的，所以 Kiosko 會把它列在設定會連線的主機中（`kiosko config import` 在套用別人寫的設定前會顯示出來）。

## 腳本推送

### 建立推送名稱

在**設定 → 推送**中輸入名稱（小寫字母、數字、`-` 和 `_`，例如 `backup`），然後按**新增**。Kiosko 會為它產生隨機權杖，並顯示它的 URL、權杖，以及一個可以試用的 `curl`。接著在頁面上新增**推送**小工具，並選擇這個名稱。

```sh
curl -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"value": 42, "text": "Backup finished"}' http://127.0.0.1:7420/api/push/backup
```

**產生新權杖**會取代原本的權杖（從此使用舊權杖的腳本都會被拒絕）；垃圾桶圖示會刪除該名稱。

### 要送什麼

一個 JSON 物件；每個欄位都可省略：

| 欄位 | 推送小工具如何使用 |
|---|---|
| `value` | 以大字顯示（數字或短詞） |
| `text`（或 `message`） | 顯示在下方的一行字，或單獨顯示，盡可能放大 |
| `title` | 小字，在最上方 |
| `unit` | 接在數值後面（或使用小工具自己的**單位**） |
| `level` | `ok`（綠色）、`info`（藍色）、`warn`（琥珀色）、`alert`（紅色，且方格在持續期間一直留在螢幕上）、`critical`（紅色，且在允許警示的螢幕上顯示全螢幕警示） |
| `ttlMs` | 有效多久，單位為毫秒（最多 30 天）：過了之後，小工具會隱藏到下一次推送 |

純文字（`curl -d 'Deploy done' …`）會視為 `{"text": "Deploy done"}`，表單（`-d value=21.5 -d unit=°C`）會視為物件，數字仍是數字。不論 `Content-Type` 為何，JSON 都會當成 JSON 讀取（單純的 `curl -d` 會宣稱是表單）。

其他任何 JSON 也可以：用 **JSON 數值**、**JSON 清單**或 **JSON 文字**顯示，把它的**或推送名稱**設為該名稱，再指定其中的路徑（`{"temp": 21.4, "humidity": 48}` 搭配路徑 `$.temp`）。這時 JSON 數值的曲線每次推送一個點。

### 請求

| | |
|---|---|
| `POST /api/push/<name>`（或 `PUT`） | 新內容；回應 `{"ok": true, "at": …}` |
| `GET /api/push/<name>` | 目前的內容 |
| `DELETE /api/push/<name>` | 清除內容 |
| 權杖 | `Authorization: Bearer <token>`，或在 URL 中加上 `?token=<token>` |

回應：名稱不存在或權杖錯誤時回 `401`（兩者相同，讓人猜不出名稱）；內文為空，或以 JSON 送出卻是損壞的 JSON 時回 `400`；超過 64 KB 回 `413`；每個名稱連續超過 20 個請求、之後每秒超過 5 個時回 `429`（請依 `Retry-After` 等待）。

每個名稱的最新內容，以及供曲線使用的簡短歷史（最多 240 筆或 64 KB），會保存在記憶體和設定檔旁的 `push.json` 中，所以重新啟動後，一天才變一次的方格也不會變成空白。

### 僅限這台電腦

Kiosko 的編輯器和 API 在 `127.0.0.1:7420` 上接聽，只限這台電腦，推送也從同一處進來。要從其他地方推送：

- **在這台電腦上執行腳本**，也就是執行 Kiosko 的地方（cron、systemd 計時器、git hook、自架的 CI runner）。
- **或透過通道把連接埠帶過去**，在另一台電腦上執行：`ssh -N -L 7420:127.0.0.1:7420 you@kiosko-machine`，然後在那台電腦上推送到 `http://127.0.0.1:7420/…`。
- 或在這台電腦上寫個小腳本，取得需要的資料後再推送。

不要為此把連接埠開放給你的網路（`server.host: 0.0.0.0`）：整個編輯器也會跟著對外開放。

### 為什麼推送不需要 `X-Kiosko: 1`

其他會變更內容的請求都必須帶上 `X-Kiosko: 1` 標頭：你瀏覽的網頁若要把它送到 `127.0.0.1`，瀏覽器必須先詢問 Kiosko，而 Kiosko 從不同意，所以網頁無法在你背後操控編輯器（CSRF）。推送自帶密鑰，也就是權杖，這類網頁不可能知道，因此再要求標頭只會讓腳本變長。推送只能設定其名稱所顯示的內容，碰不到設定、外掛或其他任何東西。防範 DNS rebinding 的 `Host` 檢查依然有效。

## 範例

### 最近一次備份

在備份腳本的結尾：

```sh
#!/bin/sh
TOKEN=…   # 設定 → 推送 → backup
if restic backup /home; then
  body='{"title": "Backup", "value": "OK", "text": "'"$(date +%H:%M)"'", "level": "ok", "ttlMs": 129600000}'
else
  body='{"title": "Backup", "value": "FAILED", "level": "alert"}'
fi
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -d "$body" http://127.0.0.1:7420/api/push/backup
```

`ttlMs` 設為 36 小時：如果某天晚上沒有備份，方格會消失，而不是對舊的備份顯示「OK」。

### 部署

從部署腳本，或同一台電腦上自架的 CI runner：

```sh
curl -fsS -X POST -H "Authorization: Bearer $KIOSKO_TOKEN" \
  -d "{\"title\": \"Deploy\", \"value\": \"#$CI_PIPELINE_ID\", \"text\": \"$CI_COMMIT_REF_NAME passed\", \"level\": \"ok\", \"ttlMs\": 3600000}" \
  http://127.0.0.1:7420/api/push/deploy
```

### 魚缸的溫度

由 cron 每 5 分鐘讀取一次的感測器（`*/5 * * * *`），以 **JSON 數值**顯示：**或推送名稱**設為 `aquarium`，路徑 `$.temp`，單位 `°C`，顏色 `< 23` 藍色、`> 27` 紅色，並顯示曲線：

```sh
t=$(cat /sys/bus/w1/devices/28-*/temperature)
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -d "{\"temp\": $(echo "scale=1; $t/1000" | bc)}" \
  http://127.0.0.1:7420/api/push/aquarium
```

### Home Assistant

Home Assistant 在同一台電腦上（或透過通道帶來連接埠）時，在 `configuration.yaml` 中加入 `rest_command`：

```yaml
rest_command:
  kiosko_doorbell:
    url: http://127.0.0.1:7420/api/push/doorbell
    method: POST
    headers:
      authorization: "Bearer <token>"
    content_type: application/json
    payload: '{"title": "Doorbell", "text": "Someone at the door", "level": "alert", "ttlMs": 120000}'
```

從自動化中呼叫它（`action: rest_command.kiosko_doorbell`）。若要一直顯示 Home Assistant 的實體，用 Home Assistant 外掛比較好。

### Windows（PowerShell）

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7420/api/push/backup `
  -Headers @{ Authorization = "Bearer <token>" } -ContentType application/json `
  -Body '{"value": "OK", "level": "ok"}'
```
