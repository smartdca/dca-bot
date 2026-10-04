import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from '../core/run.mjs';
import { QuotaError } from '../core/errors.mjs';
import { syncInbox, isFormatError, STATUS, INBOX_COLUMNS } from '../core/inbox.mjs';
import { similarity, findAnswer, LIBRARY_COLUMNS } from '../core/library.mjs';
import { makeAi, parseSuggestion } from '../core/ai.mjs';
import { youtubeAdapter } from '../platforms/youtube.mjs';
import { memoryStore, memoryTable, tableStore } from '../store/sheets.mjs';
import { DB } from './fixtures.mjs';

const CH = 'UC_CH';
const NOW = new Date('2026-10-05T04:00:00Z');
const config = {
  maxTickersPerReply: 5, perUserDailyReplies: 1, userDayTimeZone: 'Asia/Taipei',
  siteUrl: { zh: 'dcacafe.com/zh/', en: 'dcacafe.com' },
  platforms: { fake: { dailyReplyCap: 85, quotaTimeZone: 'America/Los_Angeles' } },
};
let n = 0;
const c = (author, text, extra = {}) => ({
  id: `c${++n}`, videoId: 'V1', threadId: `t${n}`, isReply: false, held: true,
  authorId: author, authorName: `@${author}`, text, publishedAt: new Date(NOW - 3600e3 + n * 1000), ...extra,
});
function fake(comments, { approveFails, replyFails } = {}) {
  const log = [];
  return {
    name: 'fake', log,
    isOwnComment: (x) => x.authorId === CH,
    fetchComments: async () => comments,
    linkFor: (x) => `link/${x.id}`,
    approve: async (x) => { if (approveFails) throw approveFails; log.push(`approve ${x.id}`); },
    reply: async ({ target }) => { if (replyFails) throw replyFails; log.push(`reply ${target.threadId}`); return `r${log.length}`; },
  };
}
const scorer = { get: async () => ({ status: 'ok', score: 50 }) };

// ── 全部攔截模式 ─────────────────────────────────────────────────────
test('攔截模式：$ 查詢先核准再回覆；一般留言不碰', async () => {
  const comments = [c('amy', '$AAPL'), c('bob', '謝謝分享'), c('cat', '$TSLA', { held: false })];
  const ad = fake(comments);
  const s = await runBatch({ config, db: DB, store: memoryStore(), adapters: [ad], scorer, now: NOW });
  assert.deepEqual(ad.log, [`approve ${comments[0].id}`, `reply ${comments[0].threadId}`, `reply ${comments[2].threadId}`]);
  assert.equal(s.fake.approved, 1);
  assert.equal(s.fake.replied, 2);
});

test('攔截模式：同一人多則只核准要回覆的那一則', async () => {
  const comments = [c('amy', '$AAPL'), c('amy', '$TSLA')];
  const ad = fake(comments);
  await runBatch({ config, db: DB, store: memoryStore(), adapters: [ad], scorer, now: NOW });
  assert.deepEqual(ad.log, [`approve ${comments[1].id}`, `reply ${comments[1].threadId}`]);
});

test('攔截模式：核准時額度用完 → 停止、不記錄', async () => {
  const store = memoryStore();
  const ad = fake([c('amy', '$AAPL')], { approveFails: new QuotaError('quotaExceeded') });
  const s = await runBatch({ config, db: DB, store, adapters: [ad], scorer, now: NOW });
  assert.equal(s.fake.capReached, true);
  assert.equal(store.rows.length, 0);
});

test('攔截模式：核准成功但回覆失敗 → 下一批（已公開）直接補回覆、不重複核准', async () => {
  const store = memoryStore();
  const cm = c('amy', '$AAPL');
  const ad1 = fake([cm], { replyFails: new Error('boom') });
  await runBatch({ config, db: DB, store, adapters: [ad1], scorer, now: NOW, log: () => {} });
  assert.equal(store.rows.length, 0);
  const ad2 = fake([{ ...cm, held: false }]);
  await runBatch({ config, db: DB, store, adapters: [ad2], scorer, now: NOW });
  assert.deepEqual(ad2.log, [`reply ${cm.threadId}`]);
});

// ── YouTube：讀被攔截的留言、核准 ─────────────────────────────────────
test('YouTube：同時讀已公開與被攔截、記錄頻道自己的回覆、核准呼叫正確', async () => {
  const calls = [];
  const cm = (id, a, t, when) => ({ id, snippet: { authorChannelId: { value: a }, authorDisplayName: `@${a}`, textOriginal: t, publishedAt: when } });
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    const ok = (b) => ({ status: 200, ok: true, json: async () => b });
    if (url.includes('oauth2')) return ok({ access_token: 'T' });
    if (url.includes('setModerationStatus')) return { status: 204, ok: true, json: async () => ({}) };
    const q = new URL(url).searchParams;
    if (q.get('moderationStatus') === 'heldForReview') {
      return ok({ items: [{ id: 'h1', snippet: { topLevelComment: cm('h1', 'amy', '$AAPL', '2026-10-05T03:00:00Z') } }] });
    }
    return ok({ items: [{ id: 'p1', snippet: { topLevelComment: cm('p1', 'bob', '請問怎麼用？', '2026-10-05T02:00:00Z') },
      replies: { comments: [cm('p1.r', CH, '你好，在代碼前加 $ 就可以', '2026-10-05T02:30:00Z')] } }] });
  };
  const yt = youtubeAdapter({ cfg: { channelId: CH, videoIds: ['V1'], holdAll: true, lookbackHours: 168, maxPagesPerVideo: 2 }, credentials: {}, fetchImpl });
  const list = await yt.fetchComments({ now: NOW });
  const p1 = list.find((x) => x.id === 'p1');
  const h1 = list.find((x) => x.id === 'h1');
  assert.equal(p1.held, false);
  assert.equal(h1.held, true);
  assert.equal(p1.channelReplies[0].text, '你好，在代碼前加 $ 就可以');
  assert.ok(list.find((x) => x.id === 'p1.r').isReply);
  assert.equal(yt.linkFor(h1), 'https://studio.youtube.com/video/V1/comments');
  assert.equal(yt.linkFor(p1), 'https://www.youtube.com/watch?v=V1&lc=p1');
  await yt.approve(h1);
  assert.ok(calls.at(-1).startsWith('POST https://www.googleapis.com/youtube/v3/comments/setModerationStatus?id=h1&moderationStatus=published'));
  assert.equal(calls.filter((x) => x.includes('commentThreads')).length, 2);
});

// ── 留言分頁 ──────────────────────────────────────────────────────────
const fakeAdapter = { isOwnComment: (x) => x.authorId === CH, linkFor: (x) => `link/${x.id}` };
const aiStub = (category = '問題', reply = 'AI 回答') => {
  const calls = [];
  return { calls, suggest: async (t) => { calls.push(t); return { category, reply }; } };
};

test('格式錯誤判斷', () => {
  assert.equal(isFormatError('AAPL', DB), true, '沒加 $');
  assert.equal(isFormatError('aapl, tsla', DB), true);
  assert.equal(isFormatError('$APPL', DB), true, '有 $ 但打錯');
  assert.equal(isFormatError('I love this video', DB), false);
  assert.equal(isFormatError('謝謝分享', DB), false);
});

test('留言分頁：分類順序（可疑 → 格式錯誤 → 回覆庫 → AI），有效 $ 與頻道自己不進分頁', async () => {
  const inbox = memoryTable(INBOX_COLUMNS);
  const library = memoryTable(LIBRARY_COLUMNS, [{ '問題': 'DCA Score 怎麼計算的？', '回覆': '綜合五個指標喔', '類別': '問題', '語言': 'zh' }]);
  const ai = aiStub('建議', '謝謝你的建議！');
  const comments = [
    c('a', '加我 telegram 帶你賺'),
    c('b', 'AAPL'),
    c('c', 'DCA Score 是怎麼計算的'),
    c('d', '希望可以加入日股'),
    c('e', '$AAPL, $TSLA'),
    c(CH, '置頂說明'),
  ];
  const s = await syncInbox({ adapter: fakeAdapter, comments, db: DB, inbox, library, ai, processedIds: new Set(), botReplyIds: new Set(), now: NOW });
  assert.deepEqual(inbox.rows.map((r) => [r['留言內容'], r['類別'], r['建議回覆'], r['狀態']]), [
    ['加我 telegram 帶你賺', '可疑', '', '待處理'],
    ['AAPL', '格式錯誤', 'To get a DCA Score, add $ before each ticker and separate them with commas, e.g. $AAPL, $2330, $BTC', '待處理'],
    ['DCA Score 是怎麼計算的', '問題', '綜合五個指標喔', '待處理'],
    ['希望可以加入日股', '建議', '謝謝你的建議！', '待處理'],
  ]);
  assert.deepEqual(ai.calls, ['希望可以加入日股'], 'AI 只用在回覆庫找不到的');
  assert.equal(s.libraryUsed, 1);
  assert.equal(inbox.rows[0]['連結'], `link/${comments[0].id}`);
  assert.match(inbox.rows[0]['時間'], /^2026-10-05 \d\d:\d\d$/);

  // 再跑一次不會重複加
  await syncInbox({ adapter: fakeAdapter, comments, db: DB, inbox, library, ai, processedIds: new Set(), botReplyIds: new Set(), now: NOW });
  assert.equal(inbox.rows.length, 4);
});

test('留言分頁：沒有 AI 金鑰／AI 失敗／超過每批 AI 上限', async () => {
  const comments = [c('a', '這個網站好用嗎'), c('b', '另一個問題'), c('c', '第三個問題')];
  const inbox1 = memoryTable(INBOX_COLUMNS);
  await syncInbox({ adapter: fakeAdapter, comments, db: DB, inbox: inbox1, library: memoryTable(LIBRARY_COLUMNS), ai: null, processedIds: new Set(), botReplyIds: new Set(), now: NOW });
  assert.ok(inbox1.rows.every((r) => r['類別'] === '未分類' && r['建議回覆'] === ''));

  const inbox2 = memoryTable(INBOX_COLUMNS);
  const broken = { suggest: async () => { throw new Error('down'); } };
  await syncInbox({ adapter: fakeAdapter, comments, db: DB, inbox: inbox2, library: memoryTable(LIBRARY_COLUMNS), ai: broken, processedIds: new Set(), botReplyIds: new Set(), now: NOW });
  assert.equal(inbox2.rows.length, 3, 'AI 壞掉留言照樣進分頁');

  const inbox3 = memoryTable(INBOX_COLUMNS);
  const s = await syncInbox({ adapter: fakeAdapter, comments, db: DB, inbox: inbox3, library: memoryTable(LIBRARY_COLUMNS), ai: aiStub(), processedIds: new Set(), botReplyIds: new Set(), now: NOW, maxAiPerRun: 2 });
  assert.equal(inbox3.rows.length, 2, '第三則留到下一批');
  assert.equal(s.aiUsed, 2);
});

test('留言分頁：偵測 Henry 回覆 → 已回覆＋存進回覆庫；Bot 自己的回覆不算；逾期；手動狀態不覆蓋', async () => {
  const q = c('a', '回測可以選台股嗎？');
  const old = c('b', '很久以前的問題', { publishedAt: new Date(NOW - 8 * 86400e3) });
  const botOnly = c('d', '另一個問題');
  const inbox = memoryTable(INBOX_COLUMNS, [
    { '狀態': STATUS.todo, '留言內容': q.text, '類別': '問題', '留言ID': q.id, '串ID': q.threadId, 'UTC': q.publishedAt.toISOString() },
    { '狀態': STATUS.todo, '留言內容': old.text, '類別': '問題', '留言ID': old.id, '串ID': old.threadId, 'UTC': old.publishedAt.toISOString() },
    { '狀態': STATUS.skip, '留言內容': '手動略過的', '類別': '閒聊', '留言ID': 'x', '串ID': 'tx', 'UTC': old.publishedAt.toISOString() },
    { '狀態': STATUS.todo, '留言內容': botOnly.text, '類別': '問題', '留言ID': botOnly.id, '串ID': botOnly.threadId, 'UTC': botOnly.publishedAt.toISOString() },
  ]);
  const later = new Date(NOW.getTime() - 60e3);
  const comments = [
    { ...q, channelReplies: [{ id: 'henry1', text: '可以喔，輸入 2330.TW 就行', publishedAt: later }] },
    { ...botOnly, channelReplies: [{ id: 'bot1', text: '━━━━\n☕ DCAcafé', publishedAt: later }] },
  ];
  const library = memoryTable(LIBRARY_COLUMNS);
  const s = await syncInbox({ adapter: fakeAdapter, comments, db: DB, inbox, library, ai: null, processedIds: new Set([q.id, botOnly.id]), botReplyIds: new Set(['bot1']), now: NOW });
  assert.deepEqual(inbox.rows.map((r) => r['狀態']), [STATUS.done, STATUS.expired, STATUS.skip, STATUS.todo]);
  assert.equal(s.replied, 1);
  assert.equal(s.expired, 1);
  assert.deepEqual([library.rows[0]['問題'], library.rows[0]['回覆'], library.rows[0]['語言'], library.rows[0]['來源']],
    ['回測可以選台股嗎？', '可以喔，輸入 2330.TW 就行', 'zh', '自動（你的回覆）']);
});

// ── 回覆庫比對、AI 解析、分頁存取 ─────────────────────────────────────
test('回覆庫：相似度比對', () => {
  assert.ok(similarity('DCA Score 怎麼計算的？', 'DCA Score是怎麼計算的') > 0.6);
  assert.ok(similarity('DCA Score 怎麼計算的？', '可以加入日股嗎') < 0.2);
  const lib = [{ '問題': 'How is the DCA Score calculated?', '回覆': 'It combines...', '語言': 'en' }];
  assert.ok(findAnswer(lib, 'how is DCA score calculated', { lang: 'en' }));
  assert.equal(findAnswer(lib, 'how is DCA score calculated', { lang: 'zh' }), null, '語言不同不套用');
});

test('AI：請求格式與回應解析', async () => {
  let sent;
  const ai = makeAi({ apiKey: 'K', fetchImpl: async (url, init) => { sent = { url, init }; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"category":"問題","reply":"你好"}' }] }) }; } });
  assert.deepEqual(await ai.suggest('請問'), { category: '問題', reply: '你好' });
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.headers['x-api-key'], 'K');
  assert.equal(JSON.parse(sent.init.body).model, 'claude-haiku-4-5-20251001');
  assert.equal(makeAi({ apiKey: '' }), null);
  assert.deepEqual(parseSuggestion('好的：{"category":"可疑","reply":"不該有"}'), { category: '可疑', reply: '' });
  assert.equal(parseSuggestion('沒有 JSON'), null);
});

test('分頁存取：新建時套用下拉選單、欄位對應、更新儲存格', async () => {
  const calls = [];
  const client = {
    ensureTab: async (tab, headers, setup) => calls.push(['ensure', tab, headers.length, setup ? setup(9)[0].setDataValidation.range.sheetId : null]),
    readRows: async () => [{ rowNumber: 2, values: ['待處理', 't', 'a', 'x', '', '', '', '', 'id1', 'th1', 'u'] }],
    append: async (tab, n, rows) => calls.push(['append', tab, n, rows[0][8]]),
    updateCells: async (tab, u) => calls.push(['update', tab, u]),
  };
  const { inboxSetup } = await import('../core/inbox.mjs');
  const t = tableStore(client, { tab: '留言-YouTube', columns: INBOX_COLUMNS, setup: inboxSetup });
  const rows = await t.load();
  assert.equal(rows[0]['留言ID'], 'id1');
  await t.append([{ '留言ID': 'id2' }]);
  await t.update([{ _row: 2, field: '狀態', value: '已回覆' }]);
  assert.deepEqual(calls, [
    ['ensure', '留言-YouTube', 11, 9],
    ['append', '留言-YouTube', 11, 'id2'],
    ['update', '留言-YouTube', [{ row: 2, col: 1, value: '已回覆' }]],
  ]);
});
