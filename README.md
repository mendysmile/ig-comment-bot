# ig-comment-bot

> **Self-hosted Instagram comment-to-DM bot.** When followers comment on your IG post with a configured keyword, the bot automatically replies with a private DM (with optional buttons). Built on Cloudflare Workers (free tier 100K req/day) + Notion as the rules backend. Replaces ManyChat/Chatfuel at ~$0/month.

> **自架 IG 留言關鍵字自動私訊機器人。** 觀眾在你 IG 貼文留言含預設關鍵字（例如「+1」「資料」），系統自動發私訊把資料連結送過去。整套用 Cloudflare Workers + Notion DB 自架，月費接近 0 元（免費額度 100K req/day），可省下 ManyChat / Chatfuel 等 SaaS 訂閱費。

---

## 為什麼自架（不用 ManyChat / Chatfuel）

| 項目 | ManyChat (Pro) | ig-comment-bot (本專案) |
|---|---|---|
| 月費 | $15-29 USD/月（NTD 475-920，per workspace 不限帳號）| 0 NTD（Cloudflare 免費額度足夠） |
| 計費單位 | 按 contacts 階梯（500 / 1k / 10k...）| 不計流量（免費額度 100K req/day 足夠個人帳號） |
| 控制權 | SaaS 廠商 | 你自己的 Cloudflare 帳號 |
| 規則 UI | ManyChat 後台 | Notion DB（你已熟悉的工作環境） |
| 客製化 | 受限於 ManyChat 功能 | 完全自由（直接改 worker 程式碼） |
| Meta App Review | 走 ManyChat 的 App | 自架自用不需要 |
| 部署門檻 | 註冊即用 | 需要一次性設定（~30 分鐘） |

ManyChat $15/月起跳（500 contacts）、實務上多數商家 $29/月（1,000+ contacts）。**年省 NTD 5,700 起、平均 ~NTD 11,000**（按 2026-05-04 匯率 1 USD = 31.65 TWD 換算）。

> **定價來源**：[ManyChat Pricing](https://manychat.com/pricing) / [Featurebase ManyChat Pricing 2026](https://www.featurebase.app/blog/manychat-pricing)。匯率即時參考 [Trading Economics — Taiwanese Dollar](https://tradingeconomics.com/taiwan/currency)。Pricing 跟匯率都會浮動，自己算之前先確認當下值。

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

### Step 3：在 Notion 建規則 DB

到 Notion 開新 DB（任何 page 底下都行），按下方「Notion DB schema」section 列出的 16 個欄位（英文欄位名 + 對應型別）建好。建完後把 data source ID 抓出來（Notion DB URL `https://www.notion.so/<workspace>/<DB-ID>?v=<view-id>` 中的 `<DB-ID>`）。

> 沒提供現成 template — schema 簡單，自己建一次就熟了，也方便依需求增減欄位。

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

在 Notion 開新 DB，建以下 16 個欄位（欄位名要完全一致，worker 用名字 lookup）：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `name` | title | 規則名稱（你自己看的標籤） |
| `enabled` | checkbox | 啟用開關（沒勾就不會比對） |
| `account` | select | IG 帳號 username（要跟 `IG_ACCOUNTS[].username` 對應） |
| `post_link` | url | 指定 IG 貼文連結；留空 = 全帳號 fallback |
| `keywords` | rich_text | 關鍵字，逗號或換行分隔（例：`+1, info, link`） |
| `dm_message` | rich_text | DM 內文（≤ 1000 字） |
| `priority` | number | 多條同時符合時，數字大的優先 |
| `trigger_count` | number | 機器人自動寫回 +1 |
| `last_triggered` | date | 機器人自動寫回 |
| `notes` | rich_text | 自由備忘 |
| `button_1_text` | rich_text | 按鈕 1 標題（≤ 20 字元，可選） |
| `button_1_url` | url | 按鈕 1 連結（必須 https） |
| `button_2_text` ~ `button_3_text` | rich_text | 同上，最多 3 顆按鈕 |
| `button_2_url` ~ `button_3_url` | url | 同上 |

### 規則匹配邏輯（specific / fallback 兩段）

worker 收到 webhook 後分兩 pass（同帳號內）：

**Pass 1 — specific 比對**：規則的 `post_link` **有填值** → 必須符合當前留言所在貼文的 shortcode 才會觸發。

**Pass 2 — fallback 比對**：規則的 `post_link` **留空** → 全帳號通用，任何貼文都吃。Pass 1 沒有任何規則符合才會走到這裡。

**例**：

- 規則 A：`keywords = "discount"`、`post_link = https://www.instagram.com/p/ABC123/`
- 規則 B：`keywords = "info"`、`post_link 留空（fallback）`

| 留言發生地 | 留言內容 | 觸發 |
|---|---|---|
| ABC123 那篇 | `discount` | A（specific 比對成功） |
| ABC123 那篇 | `info` | B（specific 不含「info」，落到 fallback） |
| 其他貼文 | `discount` | 不觸發（specific 沒符合、fallback 不含「discount」） |
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

## 不想自己摸索？代部署服務

兩個方案（含部署到你自己的 Cloudflare 帳號 + 30 天 email 問題解答），依需求選一：

### 陽春版

- 留言觸發 → 直接送文字 + 連結 DM（一步驟）
- 設定前 5 條觸發規則（含 button template、specific/fallback）
- 適合：剛起步、不擔心機器人批量取得資源的個人帳號

### 完整版

- 陽春版全部功能 +
- **兩步驟確認機制**：用戶點按鈕進確認頁才看到資源連結，HMAC 簽章 + 24h 效期，防自動化程式批量取得資源
- 適合：發攻略 / 課綱 / PDF 等資源怕被批量取得的帳號

### 共同條件

- 部署到你**自己的** Cloudflare 帳號（你保有完全控制權）
- 部署後 30 天內 email 問題解答（範圍：部署 + 規則設定）

### 不適合

- 想要規模化的企業客戶（建議直接用 ManyChat）
- 想要 GUI 後台（這專案後台是 Notion，要自己編輯）
- 想要替別人 IG 帳號代操作（需要過 Meta App Review，本服務只處理你自己的帳號）

### 不含（兩個方案皆然）

- Meta App 申請與設定（你自己準備）
- 客製化功能開發
- 規模化代管或長期維護
- IG 帳號被 Meta 限制 / 封鎖的賠償（由帳號擁有者自行承擔）
- Meta API 政策變動造成的服務中斷（不在保障範圍，亦不退款）
- 部署完成並交付後不提供退款

**洽談**：[填申請表看完整方案 + 定價](https://tally.so/r/xX9zqy)（24-48 小時內回覆）

---

## License

MIT — 自由 fork、自由商用、保留版權聲明即可。

## Contributing

這是個人 portfolio 專案，主力放在自用 + 諮詢服務上，**不主動收 PR、也不負責回應 issue**。歡迎自由 fork 改成你自己的版本（MIT License），或在 fork 上加你想要的功能（例如 Threads / Facebook 留言支援、規則網頁 GUI、多語系 Privacy Policy template）。如果你的 fork 寫得不錯，歡迎 ping 我 — 我可能會在 README 加個 Inspired Forks 區塊互推。

---

## Related Articles

- [文組怎麼用 Cloudflare Workers 取代月費 SaaS](https://www.linkedin.com/posts/mendy-chiang-27a8971b_%E6%96%87%E7%B5%84%E5%90%8C%E5%AD%B8%E5%B8%B8%E5%95%8F%E6%88%91%E6%80%8E%E9%BA%BC%E8%87%AA%E5%AD%B8%E9%9B%B2%E7%AB%AF%E6%88%91%E6%83%B3%E8%AA%AA%E7%9A%84%E6%98%AF%E6%89%BE%E4%BD%A0%E7%94%9F%E6%B4%BB%E4%B8%AD%E7%9A%84%E5%B0%8F%E7%97%9B%E9%BB%9E%E7%94%A8%E9%9B%B2%E7%AB%AF%E6%9C%8D%E5%8B%99%E5%8E%BB%E8%A7%A3%E6%B1%BA%E5%AE%83-activity-7457280298851115008-UvJe)（LinkedIn，2026-05-05）

待補：
- webhook signature debugging deep dive（LinkedIn 英文版）
- Adalyn 部落格技術文 — 自架取代月費 SaaS 全紀錄
