// 回覆庫：問題 ↔ Henry 認可過的回覆。
// 新留言先在這裡找相似的問題，找到就直接用（不花錢）；找不到才請 AI 寫建議。
// Henry 在 YouTube 回覆後，Bot 會把「問題＋他實際的回覆」自動存進來，回覆庫越用越完整。
//
// 相似度：去掉標點空白後，用「兩個字一組」的重疊比例（Jaccard）。中英文都適用、不用額外費用。

export const LIBRARY_COLUMNS = ['問題', '回覆', '類別', '語言', '來源', '建立時間'];

export function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(s) {
  const out = new Set();
  if (s.length === 1) out.add(s);
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

export function similarity(a, b) {
  const A = bigrams(normalize(a));
  const B = bigrams(normalize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function findAnswer(library, text, { threshold = 0.6, lang } = {}) {
  let best = null;
  for (const e of library) {
    if (!e['回覆'] || (lang && e['語言'] && e['語言'] !== lang)) continue;
    const s = similarity(text, e['問題']);
    if (s >= threshold && (!best || s > best.score)) best = { score: s, entry: e };
  }
  return best?.entry || null;
}
