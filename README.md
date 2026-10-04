# DCA Score Bot

社群留言輸入 `$代碼`，自動回覆 DCA Score。目前平台：YouTube（只處理 `config.json` 列出的影片）。

## 規則（已定案）

| 項目 | 規則 |
|---|---|
| 觸發 | 代碼前加 `$`（全形 `＄` 也算） |
| 多個代碼 | 逗號分隔（全形 `，` 也算）；沒有分隔只取第一個 |
| 上限 | 每則最多 5 個；每人每天 1 則回覆（台北時間）；YouTube 每天 150 則（美西時間，對齊 YouTube 額度重置） |
| 格式 | Yahoo 格式，大小寫不拘；台股可省略 `.TW`／`.TWO`；加密貨幣可省略 `-USD` |
| 撞名 | 加密貨幣 → 台股 → 美股 |
| 錯誤代碼 | 不推測、不回覆、不記錄 |
| 回覆 | 完整名稱 + 代碼 + 分數，附網站連結；回覆語言跟著留言（有中文 → 中文） |
| 同一人多則 | 同一批、同一支影片合併成一則，回在最新那則底下 |

## 排程

- `DCA Score Bot`：每 30 分鐘一批（私人 repo 免費額度內）。手動執行時可勾「試跑」。
- `Update Ticker Database`：每週一 02:00（台北）重建 `data/tickers-db.json`。
  - 美股：Nasdaq Trader 全市場清單（排除權證、單位、優先股）
  - 台股：證交所＋櫃買中心公開資料（一般股票與 ETF）
  - 加密貨幣：CoinGecko 市值前 50（排除規則與網站每週精選相同，且必須在 Yahoo 查得到）

## 記錄

Google Sheet 分頁 `BotLog`（第一次執行時自動建立）。只記錄處理過的 `$` 留言，用於去重與上限計算。
Actions 執行紀錄只印統計數字，不印留言內容。

## Secrets

`YT_CLIENT_ID`、`YT_CLIENT_SECRET`、`YT_REFRESH_TOKEN`、`GOOGLE_SERVICE_ACCOUNT`

## 新增影片／平台

- 影片：把影片 ID 加進 `config.json` → `platforms.youtube.videoIds`
- 平台：在 `platforms/` 新增模組（只需實作「抓留言」與「回覆」），在 `bot.mjs` 加入

## 已知限制

- 回覆串：只看得到 YouTube 隨留言一起回傳的回覆（每串最近幾則），很長的回覆串裡較舊的回覆可能讀不到。
- 只處理 72 小時內的留言。
