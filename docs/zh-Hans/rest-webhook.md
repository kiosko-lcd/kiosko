# JSON 小组件与脚本推送

无需编写插件，就能把任何内容放上副屏的两种方式：

- **从 URL 获取 JSON。** Kiosko 每隔一段时间请求一个 URL（API、状态页、你网络中的传感器），并显示响应中的某个数值：以大字配上单位和曲线显示、以列表显示，或嵌在一句话里。
- **推送。** 脚本、cron 定时任务、你的 CI 或 Home Assistant 有消息时，用一条 `curl` 把数值发给 Kiosko：最近一次备份、一次部署、鱼缸的水温。

两者都内置在 Kiosko 中（基础组件插件）：**JSON 数值**、**JSON 列表**、**JSON 文字**和**推送**都在编辑器的组件库里，位于“开发”分类下。

## 从 URL 获取 JSON

添加一个 **JSON 数值**小组件，然后填写：

- **URL**：Kiosko 要请求的地址，例如
  `https://api.open-meteo.com/v1/forecast?latitude=40.42&longitude=-3.70&current=temperature_2m`
  （免费，无需密钥）。
- **数值路径**：数值在响应中的位置，例如 `$.current.temperature_2m`。一开始先留空：格子会列出它在响应中找到的路径及其数值，方便你复制一个。
- **单位**、**数值前缀**（`$`、`€`）、**小数位数**和**标签**。

**JSON 列表**显示多个数值，每个一行：列出各个**字段**（每个字段有标签、路径和单位），或者给出响应中某个列表的路径（**或其中的列表**，例如 `$.items`），再给出每个条目内标签和数值的路径（`name`、`price`）。对象也可以当作列表：每个键是一个条目，带有 `key` 和 `value`。

**JSON 文字**写出一句嵌有数值的话：`Backup {$.status} at {$.finished}`。`{$.items[*].name}` 会写出全部，用逗号分隔；`{{` 和 `}}` 写出花括号。

### 路径

JSONPath 的一小部分，读取时不会执行任何代码：

| 路径 | 找到 |
|---|---|
| `$` | 整个响应（纯文本也行） |
| `$.current.temperature_2m` | 一个键，再一个键（`$` 和第一个点可以省略：`current.temperature_2m`） |
| `items[0].price` | 列表的第一个条目 |
| `items[-1]` | 最后一个（负数索引从末尾倒数） |
| `['key with spaces']` | 含空格或点的键，加引号（`\` 转义引号） |
| `items[*].name`、`prices.*` | 每个条目，或对象的每个值（用于列表和文字） |
| `items.length` | 列表有多少个条目 |

只读取响应中确实存在的键。路径最多 300 个字符、32 级，通配符最多收集 500 个值。

### 按数值变色

**按数值变色**是一组规则；第一条成立的规则决定数值的颜色（绿色、蓝色、琥珀色、红色、主题的强调色或暗淡）：

| 规则 | 数值满足以下条件时成立 |
|---|---|
| `>= 30`、`> 30`、`< 0`、`<= 5` | 数字，进行比较 |
| `30` | 大于等于 30 的数字（单独一个数字表示 `>=`） |
| `= failed`、`!= ok` | 是（或不是）该文字，不区分大小写；或是该数字 |

在 **JSON 文字**中，**颜色依据**指定规则看哪个路径（`$.status`）；不设置时，规则看整句话。

### 曲线

**JSON 数值**会在数值下方画出它的历史：每次刷新一个点，最多到**曲线点数**（默认 60）。曲线保存在 Kiosko 的缓存（内存）中，所以重启 Kiosko 不会清空，重启电脑则会。把**历史曲线**设为“不显示”，就只显示数值。

### 密钥、令牌和请求头

把密钥或令牌填在**密钥**中：编辑器会遮盖它，也绝不会写进日志。默认会原样放进 `Authorization` 请求头，所以请填写完整的值（`Bearer abc123`、`token abc123`）。在高级选项中：

- **密钥使用的请求头**：换用其他请求头（`X-Api-Key`），或留空。
- 在 URL（`…?apikey={secret}`）、请求头的值或请求体中写上 `{secret}`，就会改放到那里（在 URL 中会做 URL 编码）。
- **其他请求头**、**方法**（GET 或 POST）和**请求体（POST）**（看起来像 JSON 时按 JSON 发送）。

和 Kiosko 的所有密钥一样，它保存在配置文件中（Linux 上为 `~/.config/kiosko/config.json`），只有你能读取。

### 刷新、限制和错误

- 每个小组件默认每分钟请求一次；可以用小组件的**刷新间隔**修改（最短 5 秒；注意 API 的限制）。两个小组件同时请求同一个 URL 时，会共用一次请求。
- **超时时间**（默认 10 秒，最长 60 秒）和**响应大小上限**（默认 512 KB，最大 5 MB）：超出的响应会被拒绝。
- Kiosko 以 `kiosko-core Kiosko (+https://kioskolcd.dev)` 标识自己；服务器给过 ETag 或日期时，会回传 `If-None-Match`/`If-Modified-Since`；服务器表示“请求过多”（429、`Retry-After`）时，会按要求等待。
- 请求失败时，小组件保留最后的数值，编辑器会在小组件选项下方、显示数据更新时间的地方说明原因（`HTTP 404 from api.example.com`、`timed out after 10 s`、`response larger than 524288 bytes`）。

URL 是你自己输入的，所以 Kiosko 会把它列在配置要连接的主机中（`kiosko config import` 在应用别人写的配置之前会显示出来）。

## 脚本推送

### 创建推送名称

在**设置 → 推送**中输入名称（小写字母、数字、`-` 和 `_`，例如 `backup`），然后点击**添加**。Kiosko 会为它生成一个随机令牌，并显示它的 URL、令牌，以及一条可以试用的 `curl`。接着在页面上添加**推送**小组件，并选择这个名称。

```sh
curl -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"value": 42, "text": "Backup finished"}' http://127.0.0.1:7420/api/push/backup
```

**生成新令牌**会替换原来的令牌（此后使用旧令牌的脚本都会被拒绝）；垃圾桶图标会删除该名称。

### 发送什么

一个 JSON 对象；每个字段都可省略：

| 字段 | 推送小组件如何使用 |
|---|---|
| `value` | 以大字显示（数字或短词） |
| `text`（或 `message`） | 显示在下方的一行字，或单独显示，尽量放大 |
| `title` | 小字，在顶部 |
| `unit` | 跟在数值后面（或使用小组件自己的**单位**） |
| `level` | `ok`（绿色）、`info`（蓝色）、`warn`（琥珀色）、`alert`（红色，且格子在持续期间一直留在屏幕上）、`critical`（红色，且在允许告警的屏幕上显示全屏告警） |
| `ttlMs` | 有效时长，单位为毫秒（最长 30 天）：过期后小组件会隐藏，直到下一次推送 |

纯文本（`curl -d 'Deploy done' …`）会被当作 `{"text": "Deploy done"}`，表单（`-d value=21.5 -d unit=°C`）会被当作对象，数字仍是数字。无论 `Content-Type` 是什么，JSON 都按 JSON 读取（单纯的 `curl -d` 会声称是表单）。

其他任何 JSON 也可以：用 **JSON 数值**、**JSON 列表**或 **JSON 文字**显示，把它的**或推送名称**设为该名称，再指定其中的路径（`{"temp": 21.4, "humidity": 48}` 配合路径 `$.temp`）。这时 JSON 数值的曲线每次推送一个点。

### 请求

| | |
|---|---|
| `POST /api/push/<name>`（或 `PUT`） | 新内容；返回 `{"ok": true, "at": …}` |
| `GET /api/push/<name>` | 当前的内容 |
| `DELETE /api/push/<name>` | 清除内容 |
| 令牌 | `Authorization: Bearer <token>`，或在 URL 中加 `?token=<token>` |

返回：名称不存在或令牌错误时返回 `401`（两者相同，让人猜不出名称）；请求体为空，或以 JSON 发送却是损坏的 JSON 时返回 `400`；超过 64 KB 返回 `413`；每个名称连续超过 20 个请求、之后每秒超过 5 个时返回 `429`（请按 `Retry-After` 等待）。

每个名称的最新内容，以及供曲线使用的简短历史（最多 240 条或 64 KB），保存在内存和配置文件旁的 `push.json` 中，所以重启后，一天才变一次的格子也不会变空。

### 仅限这台电脑

Kiosko 的编辑器和 API 监听 `127.0.0.1:7420`，仅限这台电脑，推送也从同一处进来。要从其他地方推送：

- **在这台电脑上运行脚本**，也就是运行 Kiosko 的地方（cron、systemd 定时器、git hook、自建的 CI runner）。
- **或者通过隧道把端口转过去**，在另一台机器上运行：`ssh -N -L 7420:127.0.0.1:7420 you@kiosko-machine`，然后在那台机器上推送到 `http://127.0.0.1:7420/…`。
- 或者在这台电脑上写个小脚本，取到需要的数据后再推送。

不要为此把端口开放给你的网络（`server.host: 0.0.0.0`）：整个编辑器也会随之暴露。

### 为什么推送不需要 `X-Kiosko: 1`

其他会修改内容的请求都必须带上 `X-Kiosko: 1` 请求头：你访问的网页要把它发到 `127.0.0.1`，浏览器必须先询问 Kiosko，而 Kiosko 从不同意，所以网页无法在你背后操控编辑器（CSRF）。推送自带密钥，也就是令牌，这类网页不可能知道，因此再要求请求头只会让脚本更长。推送只能设置其名称所显示的内容，碰不到配置、插件或其他任何东西。防范 DNS 重绑定的 `Host` 检查依然有效。

## 示例

### 最近一次备份

在备份脚本的末尾：

```sh
#!/bin/sh
TOKEN=…   # 设置 → 推送 → backup
if restic backup /home; then
  body='{"title": "Backup", "value": "OK", "text": "'"$(date +%H:%M)"'", "level": "ok", "ttlMs": 129600000}'
else
  body='{"title": "Backup", "value": "FAILED", "level": "alert"}'
fi
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -d "$body" http://127.0.0.1:7420/api/push/backup
```

`ttlMs` 设为 36 小时：如果某天夜里没备份，格子会消失，而不是对旧备份显示“OK”。

### 部署

从部署脚本，或同一台机器上自建的 CI runner：

```sh
curl -fsS -X POST -H "Authorization: Bearer $KIOSKO_TOKEN" \
  -d "{\"title\": \"Deploy\", \"value\": \"#$CI_PIPELINE_ID\", \"text\": \"$CI_COMMIT_REF_NAME passed\", \"level\": \"ok\", \"ttlMs\": 3600000}" \
  http://127.0.0.1:7420/api/push/deploy
```

### 鱼缸的水温

由 cron 每 5 分钟读取一次的传感器（`*/5 * * * *`），用 **JSON 数值**显示：**或推送名称**设为 `aquarium`，路径 `$.temp`，单位 `°C`，颜色 `< 23` 蓝色、`> 27` 红色，并显示曲线：

```sh
t=$(cat /sys/bus/w1/devices/28-*/temperature)
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -d "{\"temp\": $(echo "scale=1; $t/1000" | bc)}" \
  http://127.0.0.1:7420/api/push/aquarium
```

### Home Assistant

Home Assistant 在同一台机器上（或通过隧道转发了端口）时，在 `configuration.yaml` 中加入 `rest_command`：

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

在自动化中调用它（`action: rest_command.kiosko_doorbell`）。如果要一直显示 Home Assistant 的实体，用 Home Assistant 插件更合适。

### Windows（PowerShell）

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7420/api/push/backup `
  -Headers @{ Authorization = "Bearer <token>" } -ContentType application/json `
  -Body '{"value": "OK", "level": "ok"}'
```
