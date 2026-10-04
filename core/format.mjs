// 回覆格式 —— 要調整回覆的文字、符號、顏色，只改這個檔案。
//
// 規則（Henry 定案）：
//   · 上下用橫線區隔（不畫完整的框：留言字型寬度不一、手機會換行，直線對不齊）
//   · 分數前加顏色圓點，門檻與網站快速查詢相同：60 以上綠、20–59 黃、20 以下紅
//   · 中文版數字後面不加「分」
//   · 完整名稱 + 代碼 + 分數（整數）
//   · 回覆裡不放 $（避免被當成查詢）
//   · 每則附短版警語；完整版放在影片說明欄與置頂留言

const DIVIDER = '━━━━━━━━━━━━';
const TITLE = '☕ DCA Score';

const TEXT = {
  zh: {
    row: (name, symbol, score) => `${name}（${symbol}）${score}`,
    unavailable: (name, symbol) => `${name}（${symbol}）暫時無法計算`,
    link: (url) => `即時查詢 ▸ ${url}`,
    disclaimer: '僅供參考，非投資建議',
  },
  en: {
    row: (name, symbol, score) => `${name} (${symbol}) ${score}`,
    unavailable: (name, symbol) => `${name} (${symbol}) not available right now`,
    link: (url) => `Check anytime ▸ ${url}`,
    disclaimer: 'For reference only. Not investment advice.',
  },
};

export function scoreDot(score) {
  if (score >= 60) return '🟢';
  if (score >= 20) return '🟡';
  return '🔴';
}

export function formatReply({ lang, mention, items, siteUrl }) {
  const t = TEXT[lang === 'zh' ? 'zh' : 'en'];
  const lines = [];
  if (mention) lines.push(mention);
  lines.push(DIVIDER, TITLE, DIVIDER);
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
