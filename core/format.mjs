// 組回覆文字。
//   · 顯示完整名稱 + 代碼 + 分數（整數，與網站快速查詢一致）
//   · 回覆裡不放 $，避免 Bot 的回覆被當成查詢
//   · 投資相關文案不使用「建議」

export function formatReply({ lang, mention, items, siteUrl }) {
  const zh = lang === 'zh';
  const lines = [];
  if (mention) lines.push(mention);
  lines.push('DCA Score');
  for (const it of items) {
    const label = zh ? `${it.name}（${it.symbol}）` : `${it.name} (${it.symbol})`;
    if (it.status === 'ok') {
      const s = Math.round(it.score);
      lines.push(zh ? `${label}：${s} 分` : `${label}: ${s}`);
    } else {
      lines.push(zh ? `${label}：暫時無法計算` : `${label}: not available right now`);
    }
  }
  lines.push('');
  lines.push(zh ? `即時查詢：${siteUrl.zh}` : `Check anytime: ${siteUrl.en}`);
  lines.push(zh ? '分數僅供資訊參考' : 'For information only. Not investment advice.');
  return lines.join('\n');
}
