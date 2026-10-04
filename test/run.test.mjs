import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from '../core/run.mjs';
import { QuotaError } from '../core/errors.mjs';
import { memoryStore } from '../store/sheets.mjs';
import { DB } from './fixtures.mjs';

const CHANNEL = 'UC_CHANNEL';
const config = {
  maxTickersPerReply: 5,
  perUserDailyReplies: 1,
  userDayTimeZone: 'Asia/Taipei',
  siteUrl: { zh: 'dcacafe.com/zh/', en: 'dcacafe.com' },
  platforms: { fake: { dailyReplyCap: 3, quotaTimeZone: 'America/Los_Angeles' } },
};
const NOW = new Date('2026-10-05T04:00:00Z');
let n = 0;
const c = (author, text, extra = {}) => ({
  id: `c${++n}`, videoId: 'V1', threadId: `t${n}`, isReply: false,
  authorId: author, authorName: `@${author}`, text, publishedAt: new Date(NOW - 3600e3 + n * 1000), ...extra,
});

function fakeAdapter(comments, { quotaAfter = Infinity } = {}) {
  const replies = [];
  return {
    name: 'fake', replies,
    isOwnComment: (x) => x.authorId === CHANNEL,
    fetchComments: async () => comments,
    reply: async ({ target, text }) => {
      if (replies.length >= quotaAfter) throw new QuotaError('quotaExceeded');
      replies.push({ threadId: target.threadId, text });
      return `r${replies.length}`;
    },
  };
}
const scorer = (map = {}) => ({ get: async (s) => map[s] ?? { status: 'ok', score: 50 } });

test('基本流程：合併同一人、忽略自己與無效代碼、回在最新那則', async () => {
  const comments = [
    c('amy', '$AAPL'),
    c('amy', '$TSLA, $AAPL 謝謝'),
    c('bob', '$APPL'),                 // 打錯：不回、不記錄
    c('cat', 'nice video AAPL'),       // 沒有 $：一般留言
    c(CHANNEL, '$AAPL'),               // 頻道自己
    c('dan', '$BTC', { isReply: true }),
  ];
  const store = memoryStore();
  const ad = fakeAdapter(comments);
  const s = await runBatch({ config, db: DB, store, adapters: [ad], scorer: scorer(), now: NOW });

  assert.equal(ad.replies.length, 2);
  assert.equal(ad.replies[0].threadId, comments[1].threadId, 'amy：回在最新那則');
  assert.match(ad.replies[0].text, /🟡 Apple Inc.（AAPL）50\n🟡 Tesla, Inc.（TSLA）50/);
  assert.match(ad.replies[1].text, /^@dan\n━+\n☕ DCAcafé｜Oct 5, 2026\n━+\n🟡 Bitcoin \(BTC-USD\) 50/, 'dan：英文、回覆串要 @');
  assert.equal(store.rows.length, 3, 'amy 兩則 + dan 一則');
  assert.ok(store.rows.every((r) => r.status === 'replied'));
  assert.deepEqual({ ...s.fake }, { fetched: 6, withDollar: 4, replied: 2, limited: 0, unsupported: 0, retryLater: 0, capReached: false });

  // 下一批：同樣的留言不會再回
  const ad2 = fakeAdapter(comments);
  await runBatch({ config, db: DB, store, adapters: [ad2], scorer: scorer(), now: NOW });
  assert.equal(ad2.replies.length, 0);
});

test('每人每天一則：當天第二則不回、記為 limit；隔天可以再回', async () => {
  const store = memoryStore();
  const first = [c('amy', '$AAPL')];
  await runBatch({ config, db: DB, store, adapters: [fakeAdapter(first)], scorer: scorer(), now: NOW });

  const second = [...first, c('amy', '$TSLA')];
  const ad = fakeAdapter(second);
  const s = await runBatch({ config, db: DB, store, adapters: [ad], scorer: scorer(), now: NOW });
  assert.equal(ad.replies.length, 0);
  assert.equal(s.fake.limited, 1);
  assert.equal(store.rows.at(-1).status, 'limit');

  const third = [...second, c('amy', '$NVDA')];
  const ad3 = fakeAdapter(third);
  await runBatch({ config, db: DB, store, adapters: [ad3], scorer: scorer(), now: new Date(NOW.getTime() + 24 * 3600e3) });
  assert.equal(ad3.replies.length, 1, '隔天（台北時間）可以再回');
});

test('平台每日上限：超過的留到下一批，不記錄', async () => {
  const store = memoryStore();
  const comments = ['a', 'b', 'c', 'd', 'e'].map((u) => c(u, '$AAPL'));
  const ad = fakeAdapter(comments);
  const s = await runBatch({ config, db: DB, store, adapters: [ad], scorer: scorer(), now: NOW });
  assert.equal(ad.replies.length, 3);
  assert.equal(s.fake.capReached, true);
  assert.equal(store.rows.length, 3, 'd、e 沒有記錄，額度重置後會被處理');

  const nextDay = new Date(NOW.getTime() + 24 * 3600e3);
  const ad2 = fakeAdapter(comments);
  await runBatch({ config, db: DB, store, adapters: [ad2], scorer: scorer(), now: nextDay });
  assert.equal(ad2.replies.length, 2);
});

test('YouTube 回報額度用完：立即停止，未回的不記錄', async () => {
  const store = memoryStore();
  const comments = ['a', 'b', 'c'].map((u) => c(u, '$AAPL'));
  const ad = fakeAdapter(comments, { quotaAfter: 1 });
  const s = await runBatch({ config, db: DB, store, adapters: [ad], scorer: scorer(), now: NOW });
  assert.equal(ad.replies.length, 1);
  assert.equal(s.fake.capReached, true);
  assert.equal(store.rows.length, 1);
});

test('分數失敗：部分失敗照回並標示；全部暫時失敗下批重試；全部算不出則記錄不回', async () => {
  const store = memoryStore();
  const comments = [c('amy', '$AAPL, $TSLA'), c('bob', '$NVDA'), c('cat', '$MSFT')];
  const ad = fakeAdapter(comments);
  const s = await runBatch({
    config, db: DB, store, adapters: [ad], now: NOW,
    scorer: scorer({ TSLA: { status: 'unsupported' }, NVDA: { status: 'error' }, MSFT: { status: 'unsupported' } }),
  });
  assert.equal(ad.replies.length, 1);
  assert.match(ad.replies[0].text, /⚪ Tesla, Inc. \(TSLA\) not available right now/);
  assert.equal(s.fake.retryLater, 1, 'bob 下批重試');
  assert.equal(s.fake.unsupported, 1);
  assert.deepEqual(store.rows.map((r) => r.status), ['replied', 'unsupported']);
});

test('試跑模式：不回覆、不寫記錄', async () => {
  const store = memoryStore();
  const ad = fakeAdapter([c('amy', '$AAPL')]);
  const logs = [];
  await runBatch({ config, db: DB, store, adapters: [ad], scorer: scorer(), now: NOW, dryRun: true, log: (m) => logs.push(m) });
  assert.equal(ad.replies.length, 0);
  assert.equal(store.rows.length, 0);
  assert.match(logs[0], /AAPL/);
});

test('測試帳號不受每人每日上限（但仍受平台上限）', async () => {
  const store = memoryStore();
  const cfg = { ...config, testAuthorIds: ['tester'] };
  const first = [c('tester', '$AAPL')];
  await runBatch({ config: cfg, db: DB, store, adapters: [fakeAdapter(first)], scorer: scorer(), now: NOW });
  const ad = fakeAdapter([...first, c('tester', '$TSLA')]);
  await runBatch({ config: cfg, db: DB, store, adapters: [ad], scorer: scorer(), now: NOW });
  assert.equal(ad.replies.length, 1, '同一天第二則照樣回');
});
