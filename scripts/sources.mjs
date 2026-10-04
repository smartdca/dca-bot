// 各官方來源的解析規則（純函式，方便用範例資料測試）。

// ── 美股：Nasdaq Trader 每日公布的全市場代碼檔 ──────────────────────────
//   nasdaqlisted.txt：Nasdaq 上市
//   otherlisted.txt ：NYSE、NYSE American、NYSE Arca、Cboe 等
// 排除：測試代碼、權證、認股權、單位、優先股、債券類 —— 這些算不出 DCA Score。
// 代碼一律轉成 Yahoo 格式（BRK.B → BRK-B），與網站一致。

// 注意：不能排除 "Depositary Shares"，ADR（例如台積電 TSM）也是這樣寫的；優先股的名稱裡一定有 Preferred。
const EXCLUDE_NAME = /\b(warrants?|rights?|units?|preferred|notes? due|debentures?|subordinated|when issued)\b/i;
const VALID_SYMBOL = /^[A-Z][A-Z0-9-]{0,9}$/;

function parsePipe(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l && !l.startsWith('File Creation Time'));
  const head = lines.shift().split('|');
  return lines.map((l) => {
    const v = l.split('|');
    return Object.fromEntries(head.map((h, i) => [h.trim(), (v[i] ?? '').trim()]));
  });
}

export function parseNasdaqListed(text) {
  const out = {};
  for (const r of parsePipe(text)) {
    const sym = r['Symbol'];
    const full = r['Security Name'];
    if (!sym || r['Test Issue'] === 'Y' || r['NextShares'] === 'Y') continue;
    if (EXCLUDE_NAME.test(full) || !VALID_SYMBOL.test(sym)) continue;
    const [main, detail = ''] = full.split(' - ');
    const cls = detail.match(/\bClass [A-Z]\b/);
    out[sym] = (cls ? `${main.trim()} ${cls[0]}` : main.trim());
  }
  return out;
}

export function parseOtherListed(text) {
  const out = {};
  for (const r of parsePipe(text)) {
    let sym = r['ACT Symbol'];
    const full = r['Security Name'];
    if (!sym || r['Test Issue'] === 'Y' || EXCLUDE_NAME.test(full)) continue;
    if (/[$+=^#*!~]/.test(sym)) continue;           // 優先股、權證等特殊標記
    if (sym.includes('.')) {
      if (!/^[A-Z]+\.[A-Z]$/.test(sym) || /\.[UWR]$/.test(sym)) continue; // 只收股票類別（BRK.B），不收單位／權證
      sym = sym.replace('.', '-');
    }
    if (!VALID_SYMBOL.test(sym)) continue;
    out[sym] = full.replace(/\s+(New\s+)?(Common Stock|Ordinary Shares|Common Shares)\s*$/i, '').trim();
  }
  return out;
}

// ── 台股：證交所（上市）＋櫃買中心（上櫃）公開資料 ─────────────────────
// 只收一般股票（4 位數）與 ETF（00 開頭），排除權證等。
const TW_CODE = /^(\d{4}|00\d{2,4}[A-Z]?)$/;

export function parseTwList(records, suffix) {
  const out = {};
  for (const r of records || []) {
    const code = String(r.Code ?? r.SecuritiesCompanyCode ?? '').trim();
    const name = String(r.Name ?? r.CompanyName ?? '').trim();
    if (!TW_CODE.test(code) || !name) continue;
    out[code] = { y: `${code}.${suffix}`, n: name };
  }
  return out;
}

// ── 加密貨幣：CoinGecko 市值排名 ──────────────────────────────────────────
// 排除規則與網站「每週精選」完全相同（scripts/update_picks.py）。
export const STABLECOIN_SYMBOLS = new Set(['USDT', 'USDC', 'USDE', 'DAI', 'USD1', 'USDG', 'PYUSD', 'RLUSD', 'USDD', 'U',
  'TUSD', 'FDUSD', 'USDS', 'EURC', 'USD0', 'USDTB', 'BUSD', 'GUSD', 'USDP',
  'FRAX', 'LUSD', 'USDX', 'USDF', 'BFUSD', 'SUSDE', 'SUSDS']);
export const GOLD_TOKEN_SYMBOLS = new Set(['XAUT', 'PAXG', 'KAU']);
const DERIVATIVE_NAME_WORDS = ['wrapped', 'staked', 'bridged', 'restaked', 'binance-peg', 'liquid staking', 'stakewise', 'coinbase wrapped'];

export function filterCoins(coins) {
  const out = [];
  for (const c of coins || []) {
    const sym = String(c.symbol || '').toUpperCase();
    const name = String(c.name || '');
    const lname = name.toLowerCase();
    const price = c.current_price || 0;
    if (STABLECOIN_SYMBOLS.has(sym) || GOLD_TOKEN_SYMBOLS.has(sym)) continue;
    if (DERIVATIVE_NAME_WORDS.some((w) => lname.includes(w))) continue;
    if (price >= 0.97 && price <= 1.03 && (lname.includes('usd') || sym.toLowerCase().includes('usd') || lname.includes('dollar'))) continue;
    if (lname.includes('gold')) continue;
    if (!/^[A-Z0-9]{1,10}$/.test(sym)) continue;
    out.push({ sym, name, price });
  }
  return out;
}
