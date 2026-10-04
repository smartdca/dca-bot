// 回覆格式 —— 要調整回覆的文字、符號、顏色，只改這個檔案。
//
// 規則（Henry 定案）：
//   · 上下用橫線區隔（不畫完整的框：留言字型寬度不一、手機會換行，直線對不齊）
//   · 分數前加顏色圓點，門檻與網站快速查詢相同：60 以上綠、20–59 黃、20 以下紅
//   · 中文版數字後面不加「分」
//   · 完整名稱 + 代碼 + 分數（整數）
//   · 回覆裡不放 $（避免被當成查詢）
//   · 每則附短版警語；完整版放在影片說明欄與置頂留言
//   · 標題附上查詢日期（分數是當下的快照）：時區與網站計算相同（UTC），中英文統一格式 Oct 5, 2026

const DIVIDER = '━━━━━━━━━━━━';
const TITLE = (date) => `☕ DCAcafé｜${date}`;

export function formatDate(d) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

const TEXT = {
  zh: {
    row: (name, symbol, score) => `${name}（${symbol}）${score}`,
    unavailable: (name, symbol) => `${name}（${symbol}）暫時無法計算`,
    link: (url) => `查詢最新分數 ▸ ${url}`,
    disclaimer: 'DCA Score 僅供參考，非投資建議',
  },
  en: {
    row: (name, symbol, score) => `${name} (${symbol}) ${score}`,
    unavailable: (name, symbol) => `${name} (${symbol}) not available right now`,
    link: (url) => `Latest DCA Score ▸ ${url}`,
    disclaimer: 'DCA Score is for reference only. Not investment advice.',
  },
};

export function scoreDot(score) {
  if (score >= 60) return '🟢';
  if (score >= 20) return '🟡';
  return '🔴';
}

export function formatReply({ lang, mention, items, siteUrl, date = new Date() }) {
  const t = TEXT[lang === 'zh' ? 'zh' : 'en'];
  const lines = [];
  if (mention) lines.push(mention);
  lines.push(DIVIDER, TITLE(formatDate(date)), DIVIDER);
  for (const it of items) {
    if (it.status === 'ok') {
      const s = Math.round(it.score);
      lines.push(`${scoreDot(it.score)} ${t.row(it.name, it.symbol, s)}`); // 顏色用原始分數判斷，與網站一致
    } else {
      lines.push(`⚪ ${t.unavailable(it.name, it.symbol)}`);
    }
  }
  lines.push(DIVIDER, t.link(lang === 'zh' ? siteUrl.zh : siteUrl.en), t.disclaimer);
  return lines.join('\n');
}
