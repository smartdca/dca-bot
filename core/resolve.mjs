// 代碼 → 資料庫裡的正式代碼與完整名稱。查不到就回 null（不推測）。
//
// 資料庫格式（data/tickers-db.json，由 scripts/build-tickers.mjs 每週產生）：
//   us:     { "AAPL": "Apple Inc.", "BRK-B": "...", ... }        Yahoo 格式
//   tw:     { "2330": { y: "2330.TW", n: "台積電" }, ... }         y = Yahoo 代碼（.TW 上市／.TWO 上櫃）
//   crypto: { "BTC":  { y: "BTC-USD", n: "Bitcoin" }, ... }       市值前 50
//
// 比對順序 = 撞名時的優先順序：加密貨幣 → 台股 → 美股
//   · 加密貨幣可省略 -USD（$BTC = $BTC-USD）
//   · 台股可省略 .TW/.TWO（$2330 = $2330.TW），但如果有寫後綴就必須寫對

export function resolveToken(tok, db) {
  const crypto = db.crypto || {};
  const tw = db.tw || {};
  const us = db.us || {};

  const base = tok.endsWith('-USD') ? tok.slice(0, -4) : tok;
  if (crypto[base]) return { symbol: crypto[base].y, name: crypto[base].n, market: 'crypto' };

  const twCode = tok.replace(/\.(TW|TWO)$/, '');
  if (/^\d/.test(twCode) && tw[twCode]) {
    const e = tw[twCode];
    if (tok === twCode || tok === e.y) return { symbol: e.y, name: e.n, market: 'tw' };
    return null; // 例如 $2330.TWO（後綴寫錯）
  }

  if (us[tok]) return { symbol: tok, name: us[tok], market: 'us' };
  return null;
}

// 一則（或同一人的多則）留言的代碼 → 有效資產清單：去重、保留順序、最多 max 個
export function resolveTokens(tokens, db, max) {
  const out = [];
  const seen = new Set();
  for (const tok of tokens) {
    const r = resolveToken(tok, db);
    if (!r || seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}
