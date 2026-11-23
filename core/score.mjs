// 呼叫 DCAcafé 的 /api/ticker-score。
//   · 同一批裡同一個代碼只查一次
//   · 每次請求之間至少間隔 gapMs（Proxy 每個 IP 每分鐘上限 30 次，這裡壓在 20 次以內）
//   · 結果三種：ok / unsupported（代碼算不出分數）/ error（暫時失敗，下一批再試）

// countApi（選填）：DCA Score 計數器的位址。有填，每算出一次分數就回報一次（自動、系統、bot）；
// 沒填就完全不回報。回報失敗一律吞掉，不影響機器人回覆。
export function makeScorer({ api, countApi, gapMs = 3000, fetchImpl = fetch, sleep = defaultSleep }) {
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

  async function report(symbol) {
    if (!countApi) return;
    try {
      await fetchImpl(countApi, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': 'DCAcafe-Bot' },
        body: JSON.stringify({ t: [symbol], src: 'auto', who: 'system', ch: 'bot' }),
      });
    } catch {
      /* 計數失敗不影響回覆 */
    }
  }

  return {
    async get(symbol) {
      if (!cache.has(symbol)) cache.set(symbol, await fetchOne(symbol));
      const r = cache.get(symbol);
      // 計數器：每一次「替某則回覆算出分數」記一次——同一批裡同一代碼被不同人問，各記一次（即使查詢用的是快取）
      if (r.status === 'ok') await report(symbol);
      return r;
    },
  };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
