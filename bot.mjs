// 入口：GitHub Actions 定時執行（排程可能延遲，回覆不保證時間）。
//   1. $ 查詢：核准（全部攔截模式）＋回覆分數
//   2. 一般留言：整理到 Sheet 的留言分頁，由 Henry 在 YouTube 手動回覆
// 執行紀錄只印統計數字，不印任何留言內容或使用者資料（試跑模式除外）。

import { readFileSync } from 'node:fs';
import { runBatch } from './core/run.mjs';
import { makeScorer } from './core/score.mjs';
import { syncInbox, INBOX_COLUMNS, inboxSetup } from './core/inbox.mjs';
import { LIBRARY_COLUMNS } from './core/library.mjs';
import { makeAi } from './core/ai.mjs';
import { sheetsClient, sheetsStore, tableStore, memoryStore, memoryTable } from './store/sheets.mjs';
import { youtubeAdapter } from './platforms/youtube.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
const db = JSON.parse(readFileSync(new URL('./data/tickers-db.json', import.meta.url)));
const dryRun = process.env.DRY_RUN === '1';
const env = (k) => {
  if (!process.env[k]) throw new Error(`缺少 Secret：${k}`);
  return process.env[k];
};

const adapters = [];
const yt = config.platforms.youtube;
if (yt?.enabled && yt.videoIds.length) {
  adapters.push(youtubeAdapter({
    cfg: yt,
    credentials: { clientId: env('YT_CLIENT_ID'), clientSecret: env('YT_CLIENT_SECRET'), refreshToken: env('YT_REFRESH_TOKEN') },
  }));
}
// 之後加平台：在 platforms/ 新增一個模組，並在這裡加入 adapters

if (!adapters.length) {
  console.log('沒有啟用的平台或影片，結束。');
  process.exit(0);
}

// 每個平台這一批只抓一次留言，$ 查詢與留言分頁共用
for (const a of adapters) {
  const fetchOnce = a.fetchComments;
  let cached;
  a.fetchComments = (opts) => (cached ??= fetchOnce(opts));
}

const hasSheet = !!process.env.GOOGLE_SERVICE_ACCOUNT;
const client = hasSheet ? sheetsClient({ spreadsheetId: config.sheet.spreadsheetId, serviceAccount: env('GOOGLE_SERVICE_ACCOUNT') }) : null;
// 試跑模式照樣讀記錄（才看得出去重、上限是否正確），但不寫入
const store = (dryRun && !hasSheet) ? memoryStore() : sheetsStore({ ...config.sheet, client: client || undefined, serviceAccount: env('GOOGLE_SERVICE_ACCOUNT') });
const ai = makeAi({ apiKey: process.env.ANTHROPIC_API_KEY });
const now = new Date();

try {
  const summary = await runBatch({
    config, db, store, adapters, dryRun, now,
    log: (m) => notice(dryRun ? '試跑' : '訊息', m),
    scorer: makeScorer({ api: config.scoreApi, gapMs: config.scoreRequestGapMs }),
  });
  for (const [p, s] of Object.entries(summary)) {
    notice(`${p} 分數查詢`, `抓到 ${s.fetched} 則｜含 $ ${s.withDollar}｜核准 ${s.approved}｜回覆 ${s.replied}｜當日已回過 ${s.limited}｜算不出分數 ${s.unsupported}｜下批重試 ${s.retryLater}${s.capReached ? '｜⚠️ 已達每日上限' : ''}`);
  }

  // 一般留言 → 留言分頁
  const logRows = await store.load();
  const processedIds = new Set(logRows.map((r) => r.commentId));
  const botReplyIds = new Set(logRows.map((r) => r.replyId).filter(Boolean));
  for (const a of adapters) {
    const pcfg = config.platforms[a.name];
    if (!pcfg.inboxTab || (!hasSheet)) continue;
    const realLibrary = tableStore(client, { tab: config.libraryTab, columns: LIBRARY_COLUMNS });
    const inbox = dryRun ? memoryTable(INBOX_COLUMNS) : tableStore(client, { tab: pcfg.inboxTab, columns: INBOX_COLUMNS, setup: inboxSetup });
    const library = dryRun ? { load: () => realLibrary.load(), append: async () => {} } : realLibrary;
    const s = await syncInbox({
      adapter: a, comments: await a.fetchComments({ now }), db, inbox, library, ai, processedIds, botReplyIds, now,
      expireDays: pcfg.inboxExpireDays, log: (m) => notice('留言分頁', m),
    });
    notice(`${a.name} 留言分頁`, `新增 ${s.added}｜補上建議 ${s.backfilled}｜偵測到你已回覆 ${s.replied}｜逾期 ${s.expired}｜回覆庫命中 ${s.libraryUsed}｜AI 建議 ${s.aiUsed}${ai ? '' : '（未設定 AI 金鑰）'}｜存進回覆庫 ${s.learned}`);
    if (dryRun) {
      for (const r of inbox.rows) notice('試跑・留言分頁', `${r['類別']}｜${r['留言內容']}\n建議回覆：${r['建議回覆'] || '（無）'}`);
    }
  }
} catch (e) {
  console.log(`::error title=執行失敗::${String(e.message).replace(/\n/g, '%0A')}`);
  process.exit(1);
}

console.log(`代碼資料庫：${db.updated}｜美股 ${Object.keys(db.us).length}｜台股 ${Object.keys(db.tw).length}｜加密貨幣 ${Object.keys(db.crypto).length}`);

// GitHub「提示訊息」：會顯示在執行結果頁面上方，也能透過 API 讀取（執行紀錄本身不一定讀得到）
function notice(title, msg) {
  const esc = String(msg).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::notice title=${title}::${esc}`);
}
