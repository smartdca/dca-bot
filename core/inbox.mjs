// 留言分頁（一般留言待辦清單）。每個平台一個分頁：留言-YouTube、之後 留言-X…
//
// Bot 每批做的事：
//   1. 新的一般留言（不是有效的 $ 查詢）→ 分類＋建議回覆 → 加到分頁，狀態「待處理」
//        建議回覆的來源順序：固定說明（格式錯誤）→ 回覆庫 → AI → 都沒有就留空
//   2. 偵測 Henry 在 YouTube 回覆了沒有 → 狀態改「已回覆」，並把「問題＋他的回覆」存進回覆庫
//   3. 超過 expireDays 還沒處理 → 狀態改「逾期略過」
// Henry 只需要：打開分頁 → 篩選「待處理」→ 點連結到 YouTube 回覆。他手動改的狀態 Bot 不會覆蓋。
// 寫進 Sheet 不花 YouTube 額度；Henry 在 YouTube 手動回覆也不花。

import { extractTokens, hasCJK } from './parse.mjs';
import { resolveToken, resolveTokens } from './resolve.mjs';
import { findAnswer } from './library.mjs';

export const INBOX_COLUMNS = ['狀態', '時間', '留言者', '留言內容', '類別', '建議回覆', '連結', '影片', '留言ID', '串ID', 'UTC'];
export const STATUS = { todo: '待處理', done: '已回覆', skip: '略過', expired: '逾期略過' };

const SUSPICIOUS = /(https?:\/\/|www\.|t\.me\/|telegram|whatsapp|wechat|微信|line\s*id|加我|加賴|私訊|私信|帶單|老師|保證獲利|穩賺|飆股|\+?\d[\d\s-]{8,}\d)/i;

const FORMAT_HELP = {
  zh: '查詢 DCA Score 請在代碼前加上 $，多個代碼用逗號分隔，例如：$AAPL, $2330, $BTC',
  en: 'To get a DCA Score, add $ before each ticker and separate them with commas, e.g. $AAPL, $2330, $BTC',
};

// 判斷「看起來是想查分數，但格式不對」
export function isFormatError(text, db) {
  const tokens = extractTokens(text);
  if (tokens.length) return resolveTokens(tokens, db, 1).length === 0; // 有 $ 但代碼都不對（打錯）
  const t = String(text).normalize('NFKC').trim();
  if (t.length > 40) return false;
  const words = t.match(/[A-Za-z0-9][A-Za-z0-9.\-]*/g) || [];
  return words.length > 0 && words.every((w) => resolveToken(w.toUpperCase(), db)); // 沒加 $ 的代碼
}

const taipeiTime = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);

export async function syncInbox({ adapter, comments, db, inbox, library, ai, processedIds, botReplyIds, now = new Date(), expireDays = 7, maxAiPerRun = 20, log = () => {} }) {
  const stats = { added: 0, replied: 0, expired: 0, aiUsed: 0, libraryUsed: 0, learned: 0 };
  const rows = await inbox.load();
  const lib = await library.load();
  const known = new Set(rows.map((r) => r['留言ID']));

  // ── 1. 新留言進分頁 ──
  const newRows = [];
  for (const c of comments.sort((a, b) => a.publishedAt - b.publishedAt)) {
    if (known.has(c.id) || processedIds.has(c.id) || adapter.isOwnComment(c)) continue;
    if (resolveTokens(extractTokens(c.text), db, 1).length) continue; // 有效的 $ 查詢歸 Bot 處理，不進分頁
    if (now - c.publishedAt > expireDays * 86400e3) continue;

    const lang = hasCJK(c.text) ? 'zh' : 'en';
    let category = '';
    let suggestion = '';
    if (SUSPICIOUS.test(c.text)) {
      category = '可疑';
    } else if (isFormatError(c.text, db)) {
      category = '格式錯誤';
      suggestion = FORMAT_HELP[lang];
    } else {
      const hit = findAnswer(lib, c.text, { lang });
      if (hit) {
        category = hit['類別'] || '問題';
        suggestion = hit['回覆'];
        stats.libraryUsed++;
      } else if (ai) {
        if (stats.aiUsed >= maxAiPerRun) continue; // 這批 AI 額度用完，下一批再處理
        stats.aiUsed++;
        try {
          const s = await ai.suggest(c.text);
          category = s?.category || '未分類';
          suggestion = s?.reply || '';
        } catch (e) {
          log(`AI 建議失敗：${e.message}`);
          category = '未分類';
        }
      } else {
        category = '未分類';
      }
    }
    newRows.push({
      '狀態': STATUS.todo, '時間': taipeiTime(c.publishedAt), '留言者': c.authorName, '留言內容': c.text,
      '類別': category, '建議回覆': suggestion, '連結': adapter.linkFor(c), '影片': c.videoId,
      '留言ID': c.id, '串ID': c.threadId, 'UTC': c.publishedAt.toISOString(),
    });
  }
  await inbox.append(newRows);
  stats.added = newRows.length;

  // ── 2. 偵測 Henry 回覆了沒有／3. 逾期 ──
  const channelRepliesByThread = new Map();
  for (const c of comments) if (c.channelReplies?.length) channelRepliesByThread.set(c.threadId, c.channelReplies);

  const changes = [];
  const learned = [];
  for (const r of rows) {
    if (r['狀態'] !== STATUS.todo) continue; // Henry 手動改過的不動
    const since = Date.parse(r['UTC']);
    const henry = (channelRepliesByThread.get(r['串ID']) || []).find(
      (x) => x.publishedAt.getTime() > since && !botReplyIds.has(x.id) && !x.text.startsWith('━'),
    );
    if (henry) {
      changes.push({ _row: r._row, field: '狀態', value: STATUS.done });
      stats.replied++;
      if (r['類別'] !== '可疑' && !findAnswer([...lib, ...learned], r['留言內容'], { threshold: 0.9 })) {
        learned.push({ '問題': r['留言內容'], '回覆': henry.text, '類別': r['類別'], '語言': hasCJK(r['留言內容']) ? 'zh' : 'en', '來源': '自動（你的回覆）', '建立時間': taipeiTime(now) });
      }
    } else if (now - since > expireDays * 86400e3) {
      changes.push({ _row: r._row, field: '狀態', value: STATUS.expired });
      stats.expired++;
    }
  }
  await inbox.update(changes);
  await library.append(learned);
  stats.learned = learned.length;
  return stats;
}

// 新建分頁時：「狀態」欄做成下拉選單
export function inboxSetup(sheetId) {
  return [{
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
      rule: { condition: { type: 'ONE_OF_LIST', values: Object.values(STATUS).map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false },
    },
  }];
}
