// 從留言文字取出 $代碼。
//
// 規則（與 Henry 定案）：
//   · 代碼前一定要有 $（全形 ＄ 也算）
//   · 多個代碼要用逗號分隔（全形 ， 也算）；沒有分隔時只取第一個
//   · 大小寫不拘
//   · 不推測、不修正拼字 —— 這裡只負責「切出來」，對不對由 resolve.mjs 查資料庫決定
//
// NFKC 正規化會把全形 ＄ ， Ａ １ 轉成半形，所以後面只需要處理半形。

const TOKEN = /\$([A-Za-z0-9][A-Za-z0-9.\-]*)/y;
const SEPARATOR = /\s*,\s*(?=\$)/y;

export function extractTokens(text) {
  const t = String(text || '').normalize('NFKC');
  const start = t.search(/\$[A-Za-z0-9]/);
  if (start < 0) return [];

  const out = [];
  let pos = start;
  for (;;) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(t);
    if (!m) break;
    const tok = m[1].replace(/[.\-]+$/, '').toUpperCase(); // 句尾的「.」「-」不算代碼的一部分
    if (tok && !out.includes(tok)) out.push(tok);
    pos = TOKEN.lastIndex;
    SEPARATOR.lastIndex = pos;
    if (!SEPARATOR.exec(t)) break;
    pos = SEPARATOR.lastIndex;
  }
  return out;
}

// 有沒有中文（決定回覆語言）
export function hasCJK(text) {
  return /[㐀-鿿豈-﫿]/.test(String(text || ''));
}
