# ig-comment-bot

> **Self-hosted Instagram comment-to-DM bot.** When followers comment on your IG post with a configured keyword, the bot automatically replies with a private DM (with optional buttons). Built on Cloudflare Workers (free tier 100K req/day) + Notion as the rules backend. Replaces ManyChat/Chatfuel at ~$0/month.

> **自架 IG 留言關鍵字自動私訊機器人。** 觀眾在你 IG 貼文留言含預設關鍵字（例如「+1」「資料」），系統自動發私訊把資料連結送過去。整套用 Cloudflare Workers + Notion DB 自架，月費接近 0 元（免費額度 100K req/day），可省下 ManyChat / Chatfuel 等 SaaS 訂閱費。

---

## 為什麼自架（不用 ManyChat / Chatfuel）

| 項目 | ManyChat (Pro) | ig-comment-bot (本專案) |
|---|---|---|
| 月費 | $15 USD/帳號（~NTD 800）| 0 NTD（Cloudflare 免費額度足夠） |
| 控制權 | SaaS 廠商 | 你自己的 Cloudflare 帳號 |
| 規則 UI | ManyChat 後台 | Notion DB（你已熟悉的工作環境） |
| 客製化 | 受限於 ManyChat 功能 | 完全自由（直接改 worker 程式碼） |
| Meta App Review | 走 ManyChat 的 App | 自架自用不需要 |
| 部署門檻 | 註冊即用 | 需要一次性設定（~30 分鐘） |

每月 800 × 12 = **年省 9,600 NTD/帳號**。雙帳號年省 19,200 NTD。

---

## 架構

```
IG 留言發生
    ↓
Meta IG Webhook 推 POST 到你的 Worker URL
    ↓
Cloudflare Worker
    ↓ HMAC-SHA-256 簽章驗證 → 從 Notion DB 拉規則 → 比對關鍵字
    ↓
Meta Private Reply API（用 comment_id 取代 user_id 規避 24 小時規則）
    ↓
留言者收到 DM ✨
```

**技術棧：**

- **Cloudflare Workers** — Serverless 邊緣運算，免費額度 100K req/day
- **Meta Instagram Login API**（新版，不是舊的 Facebook Login）— endpoint 是 `graph.instagram.com`
- **Webhook + HMAC-SHA-256 簽章驗證** — 用 App Secret 驗證請求真的來自 Meta
- **Private Reply API** — 用 `recipient: { comment_id: "..." }` 規避商家 24 小時訊息規則
- **Notion DB 當規則後台** — 改規則直接編 Notion，最多 60 秒生效，不用重新 deploy
- **KV cache** — 規則 60 秒 TTL、permalink 24 小時 TTL，避免每次 webhook 都打 Notion / IG API

---

## Quick Start（部署 5 步，~30 分鐘）

### 前置條件

- Cloudflare 帳號（免費）+ `wrangler` CLI（`npm i -g wrangler`）
- Meta Developers 帳號 + 一個 Meta App（內含 Instagram 子應用）
- 想自動回覆的 IG 商業/創作者帳號（一個或多個）
- Notion 帳號 + integration token

### Step 1：clone 跟建工作區

```bash
git clone https://github.com/mendysmile/ig-comment-bot.git
cd ig-comment-bot
cp wrangler.toml.example wrangler.toml
```

### Step 2：建 KV namespace

```bash
wrangler kv:namespace create RULES_CACHE
```
把回傳的 `id` 貼進 `wrangler.toml` 的 `[[kv_namespaces]]` 區塊。

### Step 3：複製 Notion DB template

打開 Notion template（連結待補 — duplicate 後得到自己的 DB），記下 data source ID。Schema 詳見下方「Notion DB schema」section。

### Step 4：設 secrets

```bash
# IG accounts 設定（JSON array）
wrangler secret put IG_ACCOUNTS
# 貼: [{"username":"your.handle","ig_id":"17841xxxxxxxxxx","token_secret":"ACCOUNT1_TOKEN"}]

# 各帳號的 access token（每個 IG_ACCOUNTS[].token_secret 對應一個）
wrangler secret put ACCOUNT1_TOKEN
# 貼: 從 Meta 後台拿到的 IG long-lived access token

# Webhook 跟 Notion
wrangler secret put APP_SECRET
# 貼: Meta 後台 IG 子應用的「Instagram 應用程式密鑰」(雷 6！不是父 App 的)
wrangler secret put VERIFY_TOKEN
# 貼: 自訂隨機字串
wrangler secret put NOTION_TOKEN
wrangler secret put NOTION_RULES_DB_ID

# Privacy Policy 顯示用
wrangler secret put PRIVACY_OWNER_NAME
wrangler secret put PRIVACY_OWNER_EMAIL
wrangler secret put PRIVACY_HANDLES
wrangler secret put PRIVACY_LAST_UPDATED
```

> **⚠️ 雷 1：** 別在非互動 shell（IDE 內 terminal、CI、AI coding tools 的 `!` 模式）跑 `wrangler secret put`，會設成空字串。一定要在原生 Terminal 互動模式下跑。

### Step 5：部署 + 設 Webhook

```bash
wrangler deploy
```

部署後會得到 `https://ig-comment-bot.<你的子網域>.workers.dev`。把以下 URL 設到 Meta 後台 → Webhook：

- Callback URL: `https://<你的 worker URL>/webhook`
- Verify Token: 跟你剛才 `wrangler secret put VERIFY_TOKEN` 設的一樣
- Privacy Policy URL: `https://<你的 worker URL>/privacy`（Meta 必填）
- Subscribe field: `comments`

---

## Notion DB schema

複製 [Notion template](https://...)（連結待補）後得到一個有 16 個欄位的 DB：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `name` | title | 規則名稱（你自己看的標籤） |
| `enabled` | checkbox | 啟用開關（沒勾就不會比對） |
| `account` | select | IG 帳號 username（要跟 `IG_ACCOUNTS[].username` 對應） |
| `post_link` | url | 指定 IG 貼文連結；留空 = 全帳號 fallback |
| `keywords` | rich_text | 關鍵字，逗號或換行分隔（例：`+1, info, link`） |
| `dm_message` | rich_text | DM 內文（≤ 1000 字） |
| `priority` | number | 多條同時命中時，數字大的優先 |
| `trigger_count` | number | 機器人自動寫回 +1 |
| `last_triggered` | date | 機器人自動寫回 |
| `notes` | rich_text | 自由備忘 |
| `button_1_text` | rich_text | 按鈕 1 標題（≤ 20 字元，可選） |
| `button_1_url` | url | 按鈕 1 連結（必須 https） |
| `button_2_text` ~ `button_3_text` | rich_text | 同上，最多 3 顆按鈕 |
| `button_2_url` ~ `button_3_url` | url | 同上 |

### 規則匹配邏輯（specific / fallback 兩段）

worker 收到 webhook 後分兩 pass（同帳號內）：

**Pass 1 — specific 匹配**：規則的 `post_link` **有填值** → 必須匹配當前留言所在貼文的 shortcode 才觸發。

**Pass 2 — fallback 匹配**：規則的 `post_link` **留空** → 全帳號通用，任何貼文都吃。Pass 1 沒中才會走到這裡。

**例**：

- 規則 A：`keywords = "discount"`、`post_link = https://www.instagram.com/p/ABC123/`
- 規則 B：`keywords = "info"`、`post_link 留空（fallback）`

| 留言發生地 | 留言內容 | 觸發 |
|---|---|---|
| ABC123 那篇 | `discount` | A（specific 命中） |
| ABC123 那篇 | `info` | B（specific 不含「info」，落到 fallback） |
| 其他貼文 | `discount` | 不觸發（specific 對不上、fallback 不含「discount」） |
| 其他貼文 | `info` | B（fallback 任何貼文都吃） |

---

## 6 個必踩的雷（按踩到順序）

> 這個 section 是這個專案最有價值的部分 — 從踩到坑、找 root cause、寫成可重現解法都記下來。每個雷對應一段時間的 debug。

### 雷 1：`wrangler secret put` 在非互動 shell 會設成空字串

**症狀：** 在 AI coding tools（Claude Code 的 `!` 模式、Cursor 等）跑 `wrangler secret put TOKEN_NAME`，命令回 `✨ Success! Uploaded`，但實際上 secret 值是空字串。

**原因：** 非互動 shell 無法接 wrangler 的 prompt 輸入。

**解法：** 開原生 Terminal（macOS Terminal.app、Linux GNOME Terminal、Windows PowerShell），到 worker 資料夾互動式跑 `wrangler secret put`，提示時直接貼值。

**驗證：** 寫一個臨時 `/debug` 端點印 `env.SECRET?.length`（不印值），用 curl 確認長度 > 0。

---

### 雷 2：endpoint 是 `graph.instagram.com` 不是 `graph.facebook.com`

**症狀：** 用 `graph.facebook.com/v21.0/{ig_id}/...` 拿到 `code 100, subcode 33: Object does not exist`。

**原因：** 新版 Instagram Login API（沒有 FB 登入版本）endpoint 不一樣。

**解法：** 所有呼叫改成 `graph.instagram.com/v21.0/{ig_id}/...`

**區分方式：** Access token 開頭是 `IGAA...` 是新版 IG API、是 `EAA...` 是舊版 FB 版。

---

### 雷 3：Dev Mode webhook 推送極不穩定

**症狀：** 留言 webhook 偶爾觸發、偶爾不觸發。

**原因：** Meta App 未發佈時 webhook 推送是「best effort」，沒保證。

**解法：** 完成基本資料（Privacy Policy URL 必填）+ App 設定後，到主控板「應用程式自訂和要求」最後一項「請確認符合所有要求，再發佈應用程式」按發佈。

**重要：** Meta 自己有寫「如果你只為自己的 IG 事業開發、不打算給客戶用，可以略過 App Review 程序」 — 自架自用發佈即可。

---

### 雷 4：直接發 DM 會被擋（24 小時規則）

**症狀：** 呼叫 `/me/messages` 帶 `recipient: { id: "..." }`，回 `403` + error_subcode `2534022`：「This message is sent outside of allowed window」。

**原因：** Meta 防騷擾規定 — 商家只能在用戶 24 小時內互動過後才能主動發 DM。

**解法：** 留言觸發私訊用專屬 **Private Reply API** — `recipient: { comment_id: "..." }` 取代 `recipient: { id: "..." }`，可以對任何留言者發 DM 不受限。

**取得 comment_id：** webhook payload 裡 `change.value.id` 就是。

---

### 雷 5：換 IG token 後 webhook 訂閱會失效

**症狀：** Token rotation 後留言不再觸發 webhook。

**原因：** Webhook 訂閱（subscribed_apps）是綁在當時的 access token 上，token 失效後訂閱也跟著失效。

**解法：** rotation 後立刻用新 token 重新訂閱（`POST /{ig-user-id}/subscribed_apps?subscribed_fields=comments`）。

本專案的 cron job 自動處理：每月 1 號 0:00 UTC 跑 `refresh_long_lived_access_token` + 重新 subscribe，不用手動操作。

---

### 雷 6：webhook 簽章用「Instagram 應用程式密鑰」，不是父 App 的應用程式密鑰

> **這是花最久時間 debug 的一個雷。**

**症狀：** HMAC-SHA-256 算出來跟 Meta 送的 `x-hub-signature-256` 永遠對不上，本地 Python 跟 worker 算的一致但都不等於 Meta expected。

**原因：** 新版 Instagram Login API 結構是「父 Meta App」+「Instagram 子應用」，**兩者各有獨立的 App ID 和 App Secret**。Meta 用 **Instagram 子應用的 App Secret** 簽 webhook，不是父 App 的。

**解法：** Meta 後台 → Instagram → API 設定，找「**Instagram 應用程式密鑰**」（不是父 App 設定 → 基本資料的那個「應用程式密鑰」）。那串才是 webhook 簽章 secret。

**驗證：** 寫一個 `/sigverify` 端點傳已知 body + sig，回傳 `match: true/false`，比起等 webhook 觸發省 5 分鐘。

---

## 端點總覽

| 端點 | 用途 |
|---|---|
| `GET /webhook` | Meta 設定 webhook 用的驗證端點（hub.challenge） |
| `POST /webhook` | Meta 推留言事件 |
| `GET /privacy` | Privacy Policy 公開頁（Meta App 必填） |
| `GET /refresh-rules?secret=<VERIFY_TOKEN>` | 清 KV cache，立即從 Notion 重拉規則 |
| `GET /run-refresh?secret=<VERIFY_TOKEN>` | 手動 rotate token + 重新訂閱（cron backup） |

---

## Token 自動刷新

Cloudflare Cron Trigger 每月 1 號 0:00 UTC（KST 09:00）自動跑 `refresh_long_lived_access_token` API：

1. 對每個 IG_ACCOUNTS 的帳號跑一次
2. 用舊 token 換新 60 天 token
3. 寫進 KV `tokens` key
4. 用新 token 重新 subscribe webhook（解決雷 5）

健檢方式：

```bash
curl "https://<你的 worker URL>/run-refresh?secret=$VERIFY_TOKEN"
```

回應每帳號含：`ok: true` / `expires_in_days: 60` / `subscribe_status: 200`。

---

## 不想自己摸？代部署服務

我提供「ig-comment-bot 部署 + 30 天答疑」加值服務 — NTD 6,800 一次性，含：

- 部署到你自己的 Cloudflare 帳號（你保有完全控制權）
- 設定前 5 條規則（含 button template、specific/fallback）
- 30 天 email 答疑
- vs ManyChat 年費 9,600，**8.5 個月內回本**

這個服務不適合：
- 想要規模化的企業客戶（建議直接用 ManyChat）
- 需要 Meta App Review 過 advanced permission（自架自用不需要）
- 想要 GUI 後台（這專案的後台是 Notion，要自己編輯）

**洽談**：[Adalyn 諮詢頁](https://...)（連結待補）

---

## License

MIT — 自由 fork、自由商用、保留版權聲明即可。

## Contributing

PR 歡迎，特別是：
- 其他平台支援（Threads、Facebook 留言）
- 規則 GUI（streamlit / next.js mini-app）
- 多語系 Privacy Policy template

---

## Related Articles

待補：
- LinkedIn case study（中文版，by Mandy）— 文組怎麼用 Cloudflare Workers 取代月費 SaaS
- LinkedIn case study（英文版，by Mendy）— webhook signature debugging deep dive
- Adalyn 部落格技術文 — 我如何省下每月 1,600 元
