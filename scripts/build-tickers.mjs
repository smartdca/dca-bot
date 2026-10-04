// 重建代碼資料庫 data/tickers-db.json（GitHub Actions 每週一次，也可手動執行）。
// 任何一個來源失敗：該區保留舊資料、其他區照常更新，最後讓工作顯示失敗，方便發現。

import { readFileSync, writeFileSync } from 'node:fs';
import { parseNasdaqListed, parseOtherListed, parseTwList, filterCoins } from './sources.mjs';

const DB_PATH = new URL('../data/tickers-db.json', import.meta.url);
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; DCAcafe-Bot)' };
const CRYPTO_TOP = 50;
// 黃金代幣：市值前 50 的篩選會排除它們（沿用每週精選規則），但 Henry 要求一律收錄。
// 這兩個 Yahoo 代碼已在網站驗證過可以算出 DCA Score（不在前 50 名額內，另外加）。
const GOLD_TOKENS = { PAXG: { y: 'PAXG-USD', n: 'PAX Gold' }, XAUT: { y: 'XAUT-USD', n: 'Tether Gold' } };
const YAHOO_GAP_MS = 2000;
const MIN = { us: 5000, tw: 1000, crypto: 30 }; // 低於這個數量 = 下載不完整，不採用

const old = JSON.parse(readFileSync(DB_PATH));
const next = { ...old };
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'json' ? res.json() : res.text();
}

async function section(key, build) {
  try {
    const data = await build();
    const n = Object.keys(data).length;
    if (n < MIN[key]) throw new Error(`只有 ${n} 筆，低於 ${MIN[key]}`);
    next[key] = sortKeys(data);
    console.log(`${key}：${n} 筆`);
  } catch (e) {
    failures.push(key);
    console.log(`❌ ${key} 更新失敗，保留舊資料（${Object.keys(old[key] || {}).length} 筆）：${e.message}`);
  }
}

await section('us', async () => ({
  ...parseOtherListed(await get('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt')),
  ...parseNasdaqListed(await get('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt')),
}));

await section('tw', async () => ({
  ...parseTwList(await get('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', 'json'), 'TWO'),
  ...parseTwList(await get('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', 'json'), 'TW'),
}));

await section('crypto', async () => {
  const coins = filterCoins(await get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1', 'json'));
  const out = {};
  for (const c of coins) {
    if (Object.keys(out).length >= CRYPTO_TOP) break;
    const y = `${c.sym}-USD`;
    await sleep(YAHOO_GAP_MS);
    try {
      // 必須在 Yahoo 查得到「同一個幣」（價格差 15% 以內），否則 DCA Score 算出來會是別的東西
      const meta = (await get(`https://query1.finance.yahoo.com/v8/finance/chart/${y}?range=5d&interval=1d`, 'json')).chart.result[0].meta;
      const yp = meta.regularMarketPrice || 0;
      if (meta.instrumentType !== 'CRYPTOCURRENCY' || !c.price || !yp || Math.abs(yp / c.price - 1) > 0.15) {
        console.log(`  略過 ${y}：Yahoo 對不上`);
        continue;
      }
    } catch {
      console.log(`  略過 ${y}：Yahoo 查不到`);
      continue;
    }
    out[c.sym] = { y, n: c.name };
  }
  return { ...out, ...GOLD_TOKENS };
});

next.updated = new Date().toISOString();
writeFileSync(DB_PATH, JSON.stringify(next, null, 0) + '\n');
console.log(`完成：美股 ${Object.keys(next.us).length}｜台股 ${Object.keys(next.tw).length}｜加密貨幣 ${Object.keys(next.crypto).length}`);
if (failures.length) {
  console.log(`⚠️ 失敗：${failures.join(', ')}`);
  process.exitCode = 1;
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}
