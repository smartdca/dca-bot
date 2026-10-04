import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTokens, hasCJK } from '../core/parse.mjs';
import { resolveToken, resolveTokens } from '../core/resolve.mjs';
import { formatReply } from '../core/format.mjs';
import { makeScorer } from '../core/score.mjs';
import { dayIn } from '../core/dates.mjs';
import { DB } from './fixtures.mjs';


test('格式：$ 與逗號規則', () => {
  assert.deepEqual(extractTokens('$AAPL'), ['AAPL']);
  assert.deepEqual(extractTokens('$aapl, $tsla，$NVDA'), ['AAPL', 'TSLA', 'NVDA']);
  assert.deepEqual(extractTokens('$AAPL $TSLA'), ['AAPL'], '沒有分隔只取第一個');
  assert.deepEqual(extractTokens('$AAPL,TSLA'), ['AAPL'], '第二個沒有 $ 不算');
  assert.deepEqual(extractTokens('＄ａａｐｌ，＄ｔｓｌａ'), ['AAPL', 'TSLA'], '全形');
  assert.deepEqual(extractTokens('看看 $AAPL.'), ['AAPL'], '句尾標點');
  assert.deepEqual(extractTokens('$BRK-B'), ['BRK-B']);
  assert.deepEqual(extractTokens('$AAPL, $AAPL'), ['AAPL']);
  assert.deepEqual(extractTokens('我想問 $2330，$btc 謝謝'), ['2330', 'BTC']);
  assert.deepEqual(extractTokens('$AAPL、$TSLA'), ['AAPL'], '頓號目前不是分隔符號');
  assert.deepEqual(extractTokens('AAPL TSLA'), []);
  assert.deepEqual(extractTokens('只花了 $ 100'), []);
});

test('語言判斷', () => {
  assert.equal(hasCJK('$AAPL 謝謝'), true);
  assert.equal(hasCJK('$AAPL thanks'), false);
});

test('資料庫比對：嚴格、不推測、撞名以加密貨幣優先', () => {
  assert.equal(resolveToken('BTC', DB).symbol, 'BTC-USD');
  assert.equal(resolveToken('BTC-USD', DB).symbol, 'BTC-USD');
  assert.equal(resolveToken('ETH', DB).symbol, 'ETH-USD', '撞名：幣優先');
  assert.equal(resolveToken('SUI', DB).symbol, 'SUI', '不在前 50 的幣名 → 照美股');
  assert.equal(resolveToken('2330', DB).symbol, '2330.TW');
  assert.equal(resolveToken('2330.TW', DB).symbol, '2330.TW');
  assert.equal(resolveToken('2330.TWO', DB), null, '後綴寫錯');
  assert.equal(resolveToken('6488', DB).symbol, '6488.TWO');
  assert.equal(resolveToken('00631L', DB).symbol, '00631L.TW');
  assert.equal(resolveToken('BRK-B', DB).name, 'Berkshire Hathaway Inc. Class B');
  assert.equal(resolveToken('BRK.B', DB), null, '非 Yahoo 格式不收');
  assert.equal(resolveToken('APPL', DB), null, '打錯不推測');
  assert.equal(resolveToken('2331', DB), null);
});

test('每則最多 5 個、去重', () => {
  const r = resolveTokens(['AAPL', 'XXX', 'TSLA', 'AAPL', 'NVDA', 'MSFT', 'AMZN', 'GOOGL'], DB, 5);
  assert.deepEqual(r.map((x) => x.symbol), ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN']);
});

test('回覆文字', () => {
  const siteUrl = { zh: 'dcacafe.com/zh/', en: 'dcacafe.com' };
  const items = [
    { symbol: 'AAPL', name: 'Apple Inc.', status: 'ok', score: 72.4 },
    { symbol: '2330.TW', name: '台積電', status: 'ok', score: 59.6 },
    { symbol: 'TSLA', name: 'Tesla, Inc.', status: 'unsupported' },
  ];
  const zh = formatReply({ lang: 'zh', mention: '', items, siteUrl });
  assert.equal(zh, 'DCA Score\nApple Inc.（AAPL）：72 分\n台積電（2330.TW）：60 分\nTesla, Inc.（TSLA）：暫時無法計算\n\n即時查詢：dcacafe.com/zh/\n分數僅供資訊參考');
  const en = formatReply({ lang: 'en', mention: '@amy', items: items.slice(0, 1), siteUrl });
  assert.equal(en, '@amy\nDCA Score\nApple Inc. (AAPL): 72\n\nCheck anytime: dcacafe.com\nFor information only. Not investment advice.');
  assert.ok(!zh.includes('$') && !zh.includes('建議'));
});

test('查分數：同代碼只查一次、間隔、結果分類', async () => {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const t = new URL(url).searchParams.get('ticker');
    if (t === 'BAD') return { status: 400, ok: false, json: async () => ({ error: 'unsupported' }) };
    if (t === 'DOWN') return { status: 500, ok: false, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => ({ ticker: t, score: 61.2 }) };
  };
  const s = makeScorer({ api: 'https://x/api/ticker-score', gapMs: 3000, fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(await s.get('AAPL'), { status: 'ok', score: 61.2 });
  assert.deepEqual(await s.get('AAPL'), { status: 'ok', score: 61.2 });
  assert.deepEqual(await s.get('BAD'), { status: 'unsupported' });
  assert.deepEqual(await s.get('DOWN'), { status: 'error' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0], 'https://x/api/ticker-score?ticker=AAPL');
  assert.equal(sleeps.length, 2, '第 2、3 次請求前有等待');
});

test('日期：台北與美西', () => {
  const t = new Date('2026-10-04T17:30:00Z'); // 台北 10/5 01:30、美西 10/4 10:30
  assert.equal(dayIn('Asia/Taipei', t), '2026-10-05');
  assert.equal(dayIn('America/Los_Angeles', t), '2026-10-04');
});
