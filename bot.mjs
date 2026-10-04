// 入口：GitHub Actions 每 30 分鐘執行一次。
// 紀錄只印統計數字，不印任何留言內容或使用者資料（試跑模式除外）。

import { readFileSync } from 'node:fs';
import { runBatch } from './core/run.mjs';
import { makeScorer } from './core/score.mjs';
import { sheetsStore, memoryStore } from './store/sheets.mjs';
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

// 試跑模式照樣讀記錄（才看得出去重、上限是否正確），但不寫入
const store = (dryRun && !process.env.GOOGLE_SERVICE_ACCOUNT)
  ? memoryStore()
  : sheetsStore({ ...config.sheet, serviceAccount: env('GOOGLE_SERVICE_ACCOUNT') });

const summary = await runBatch({
  config, db, store, adapters, dryRun,
  scorer: makeScorer({ api: config.scoreApi, gapMs: config.scoreRequestGapMs }),
});

console.log(`代碼資料庫：${db.updated}｜美股 ${Object.keys(db.us).length}｜台股 ${Object.keys(db.tw).length}｜加密貨幣 ${Object.keys(db.crypto).length}`);
for (const [p, s] of Object.entries(summary)) {
  console.log(`${p}：抓到 ${s.fetched} 則｜含 $ ${s.withDollar}｜回覆 ${s.replied}｜當日已回過 ${s.limited}｜算不出分數 ${s.unsupported}｜下批重試 ${s.retryLater}${s.capReached ? '｜⚠️ 已達每日上限' : ''}`);
}
