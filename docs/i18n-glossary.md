# Translating Kiosko: Chinese glossary and rules

The words and rules Kiosko's Traditional and Simplified Chinese use, so a
new text or a new plugin says things the same way. See CONTRIBUTING.md,
"Translations", for where texts live.

Two targets, translated separately (not converted from one to the other):
- **zh-Hant**: Traditional Chinese **as written in Taiwan** (Taiwan's software vocabulary).
- **zh-Hans**: Simplified Chinese **as written in mainland China** (mainland vocabulary).

Context: Kiosko paints widgets on small always-on USB LCD panels (Thermalright Trofeo Vision, AIO
cooler screens). Texts are (a) labels painted on the panel — often tiny, so be SHORT — and (b)
the web editor's names, descriptions and option labels/help — normal UI prose.

## Rules
1. Output a TypeScript expression of the **same literal kind** as the English one: if `en` is
   `'...'`, write `'...'` (escape `'` as `\'`); if `"..."`, use `"..."`; if a template literal
   `` `...${x}...` `` keep a template literal with **exactly the same `${...}` expressions**
   (you may reorder them). Keep `\n` escapes. Keep `{placeholders}` exactly.
2. If the Spanish (`es`) equals the English (product names, `CPU`, `RSS`, units like `°C`,
   abbreviations), keep the same text in both Chinese versions.
3. Keep product/brand/protocol names in Latin: GitHub, GitLab, Home Assistant, Claude, Codex,
   Gemini, Open-Meteo, RSS, ICS, MQTT, JSON, URL (but "web address" → 網址/网址), API, CPU, GPU,
   SSH, Prometheus, ollama, vLLM, Teams, Zoom, Kiosko.
4. Full-width punctuation in Chinese prose: ，。：；（）？！「」 (TW) / “”（CN quotes may use “”）.
   Keep ASCII punctuation inside code, paths, numbers, `key: value` technical strings and before
   placeholders like `${x}` when it is technical.
5. Put a half-width space between Chinese and Latin letters/digits/placeholders:
   `${n} 個小工具`, `GitHub 的 PR`.
6. Labels painted on the panel must stay short (2–6 characters when the English is one or two
   words). No trailing 。 on labels/titles; use it on full sentences (descriptions, help).
7. Never mix scripts: zh-Hant uses only Traditional characters, zh-Hans only Simplified.
8. Don't translate code identifiers, option values, file names, command names, env vars.
9. Time units: 秒, 分鐘/分钟 (short label: 分), 小時/小时 (short: 時/时 or h when the English uses h),
   天, 週/周, 月, 年. "ago" → 前 (5 分鐘前 / 5 分钟前). "in 5 min" → 5 分鐘後 / 5 分钟后.

## Vocabulary (en → zh-Hant (Taiwan) / zh-Hans (mainland))
| en | zh-Hant | zh-Hans |
|---|---|---|
| widget | 小工具 | 小组件 |
| plugin | 外掛 | 插件 |
| panel (the LCD) | 面板 | 副屏 (how these panels are sold in China; 屏幕 is a screen) |
| screen (a configured screen) | 螢幕 | 屏幕 |
| tile | 方格 | 格子 |
| page | 頁面 | 页面 |
| interlude | 過場動畫 | 过场动画 |
| (data) source | 資料來源 | 数据源 |
| settings | 設定 | 设置 |
| option(s) | 選項 | 选项 |
| advanced | 進階 | 高级 |
| refresh | 重新整理 | 刷新 |
| file / folder | 檔案 / 資料夾 | 文件 / 文件夹 |
| path | 路徑 | 路径 |
| command | 指令 | 命令 |
| network | 網路 | 网络 |
| server / host | 伺服器 / 主機 | 服务器 / 主机 |
| default | 預設 | 默认 |
| show / hide | 顯示 / 隱藏 | 显示 / 隐藏 |
| enable / disable | 啟用 / 停用 | 启用 / 禁用 |
| sample / demo data | 範例資料 | 示例数据 |
| error / warning | 錯誤 / 警告 | 错误 / 警告 |
| API key | API 金鑰 | API 密钥 |
| access token | 存取權杖 | 访问令牌 |
| password / username / account | 密碼 / 使用者名稱 / 帳號 | 密码 / 用户名 / 账号 |
| calendar | 行事曆 | 日历 |
| agenda | 行程 | 日程 |
| meeting / event | 會議 / 活動 | 会议 / 事件 |
| all day | 全天 | 全天 |
| today / tomorrow / yesterday | 今天 / 明天 / 昨天 | 今天 / 明天 / 昨天 |
| work hours | 上班時間 | 工作时间 |
| holiday | 假日 | 假日 |
| weather / forecast | 天氣 / 預報 | 天气 / 预报 |
| temperature / humidity / wind | 溫度 / 濕度 / 風 | 温度 / 湿度 / 风 |
| rain / precipitation | 雨 / 降雨 | 雨 / 降水 |
| partly cloudy | 晴時多雲 | 多云 |
| air quality | 空氣品質 | 空气质量 |
| earthquake | 地震 | 地震 |
| traffic | 交通 | 路况 |
| news / headline / outlet | 新聞 / 標題 / 媒體 | 新闻 / 标题 / 媒体 |
| memory (RAM) | 記憶體 | 内存 |
| disk | 磁碟 | 磁盘 |
| VRAM | 顯示記憶體 | 显存 |
| graphics card | 顯示卡 | 显卡 |
| process | 處理程序 | 进程 |
| load | 負載 | 负载 |
| fan | 風扇 | 风扇 |
| uptime | 運作時間 | 运行时间 |
| software | 軟體 | 软件 |
| information | 資訊 | 信息 |
| repository | 儲存庫 | 仓库 |
| branch / commit | 分支 / 提交 | 分支 / 提交 |
| pull request / merge request | 拉取要求 (PR) / 合併要求 (MR) | 拉取请求 (PR) / 合并请求 (MR) |
| review | 審查 | 审查 |
| issue | 問題 | 议题 |
| pipeline | 管線 | 流水线 |
| build / deploy | 建置 / 部署 | 构建 / 部署 |
| running / passed / failed | 執行中 / 通過 / 失敗 | 运行中 / 通过 / 失败 |
| AI agent | AI 代理 | AI 智能体 |
| session | 工作階段 | 会话 |
| waiting for you / for input | 等你回應 / 等待輸入 | 等你回复 / 等待输入 |
| permission | 權限 | 权限 |
| token (LLM) | token | token |
| rate limit | 速率限制 | 速率限制 |
| usage / spend / cost | 用量 / 花費 / 成本 | 用量 / 花费 / 成本 |
| model (LLM) | 模型 | 模型 |
| local LLM | 本機 LLM | 本地大模型 |
| call / on a call | 通話 / 通話中 | 通话 / 通话中 |
| microphone / camera | 麥克風 / 攝影機 | 麦克风 / 摄像头 |
| muted | 靜音 | 静音 |
| entity (Home Assistant) | 實體 | 实体 |
| sensor | 感測器 | 传感器 |
| light / switch | 燈 / 開關 | 灯 / 开关 |
| thermostat | 溫控器 | 温控器 |
| battery | 電池 | 电池 |
| energy / power | 能源 / 功率 | 能源 / 功率 |
| door / window | 門 / 窗 | 门 / 窗 |
| room | 房間 | 房间 |
| now playing | 正在播放 | 正在播放 |
| countdown | 倒數 | 倒计时 |
| compliments | 讚美 | 夸夸 |
| Thermalright | 利民（Thermalright） | 利民（Thermalright） |
| always on | 全天候常亮 | 常亮 |
| week 47 | 第 47 週 | 第 47 周 |
| timesheet / hours logged | 工時 / 已登記工時 | 工时 / 已登记工时 |
| cat(s) | 貓 | 猫 |
| empty / nothing | 無 / 沒有 | 无 / 没有 |
| hide when empty | 沒有內容時隱藏 | 没有内容时隐藏 |
| more (+2 more) | 還有 | 还有 |

## Checking

- `packages/web/landing/pages.test.ts` fails if Traditional and Simplified
  characters mix in the site's texts.
- A text's script can be checked with OpenCC: what a Simplified text turns
  into with `t2s` must be itself, and a Traditional one with `s2tw` (台 and
  表 are fine in Taiwan).
