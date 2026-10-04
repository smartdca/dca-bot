// 呼叫 DCAcafé 的 /api/ticker-score。
//   · 同一批裡同一個代碼只查一次
//   · 每次請求之間至少間隔 gapMs（Proxy 每個 IP 每分鐘上限 30 次，這裡壓在 20 次以內）
//   · 結果三種：ok / unsupported（代碼算不出分數）/ error（暫時失敗，下一批再試）

export function makeScorer({ api, gapMs = 3000, fetchImpl = fetch, sleep = defaultSleep }) {
  const cache = new Map();
  let last = 0;

  async function fetchOne(symbol) {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetchImpl(`${api}?ticker=${encodeURIComponent(symbol)}`, {
        headers: { 'User-Agent': 'DCAcafe-Bot' },
      });
      if (res.status === 400) return { status: 'unsupported' };
      if (!res.ok) return { status: 'error' };
      const d = await res.json();
      if (typeof d.score !== 'number') return { status: 'error' };
      return { status: 'ok', score: d.score };
    } catch {
      return { status: 'error' };
    }
  }

  return {
    async get(symbol) {
      if (!cache.has(symbol)) cache.set(symbol, await fetchOne(symbol));
      return cache.get(symbol);
    },
  };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
