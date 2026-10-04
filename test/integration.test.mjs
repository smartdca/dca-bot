import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { youtubeAdapter } from '../platforms/youtube.mjs';
import { sheetsStore, COLUMNS } from '../store/sheets.mjs';
import { QuotaError } from '../core/errors.mjs';
import { parseNasdaqListed, parseOtherListed, parseTwList, filterCoins } from '../scripts/sources.mjs';

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

// ── YouTube ────────────────────────────────────────────────────────────
function ytThread(id, author, text, iso, replies = []) {
  const cm = (cid, a, t, when) => ({ id: cid, snippet: { authorChannelId: { value: a }, authorDisplayName: `@${a}`, textOriginal: t, publishedAt: when } });
  return { id, snippet: { topLevelComment: cm(id, author, text, iso) }, replies: replies.length ? { comments: replies.map((r) => cm(...r)) } : undefined };
}

test('YouTube：換 Token、分頁、只取時間範圍內、含回覆串', async () => {
  const calls = [];
  const now = new Date('2026-10-05T00:00:00Z');
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(init.body);
      assert.equal(p.get('grant_type'), 'refresh_token');
      assert.equal(p.get('refresh_token'), 'RT');
      return res(200, { access_token: 'AT' });
    }
    assert.equal(init.headers.Authorization, 'Bearer AT');
    const q = new URL(url).searchParams;
    if (!q.get('pageToken')) {
      return res(200, { nextPageToken: 'P2', items: [
        ytThread('t1', 'amy', '$AAPL', '2026-10-04T23:00:00Z', [['t1.r1', 'bob', '$TSLA', '2026-10-04T23:30:00Z']]),
      ] });
    }
    return res(200, { nextPageToken: 'P3', items: [ytThread('t2', 'cat', '$NVDA', '2026-09-01T00:00:00Z')] }); // 太舊 → 停止翻頁
  };
  const yt = youtubeAdapter({ cfg: { channelId: 'UC1', videoIds: ['V1'], lookbackHours: 72, maxPagesPerVideo: 5 }, credentials: { clientId: 'C', clientSecret: 'S', refreshToken: 'RT' }, fetchImpl });
  const list = await yt.fetchComments({ now });
  assert.deepEqual(list.map((c) => [c.id, c.threadId, c.isReply, c.authorId, c.text]), [
    ['t1', 't1', false, 'amy', '$AAPL'],
    ['t1.r1', 't1', true, 'bob', '$TSLA'],
  ]);
  assert.equal(calls.filter((c) => c.url.includes('commentThreads')).length, 2, '讀到太舊的就不再翻頁');
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1, 'Token 只換一次');
  assert.ok(yt.isOwnComment({ authorId: 'UC1' }));
});

test('YouTube：回覆內容與額度用完', async () => {
  let posted;
  let quota = false;
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('oauth2')) return res(200, { access_token: 'AT' });
    if (quota) return res(403, { error: { errors: [{ reason: 'quotaExceeded' }] } });
    posted = JSON.parse(init.body);
    return res(200, { id: 'NEW' });
  };
  const yt = youtubeAdapter({ cfg: { channelId: 'UC1', videoIds: [], lookbackHours: 72, maxPagesPerVideo: 1 }, credentials: {}, fetchImpl });
  assert.equal(await yt.reply({ target: { threadId: 't1' }, text: 'hi' }), 'NEW');
  assert.deepEqual(posted, { snippet: { parentId: 't1', textOriginal: 'hi' } });
  quota = true;
  await assert.rejects(yt.reply({ target: { threadId: 't1' }, text: 'hi' }), QuotaError);
});

// ── Google Sheet ───────────────────────────────────────────────────────
test('Sheet：Service Account 簽章正確、分頁不存在時自動建立、讀寫欄位對齊', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'bot@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const sheet = { BotLog: null };
  const log = [];
  const fetchImpl = async (url, init = {}) => {
    log.push(`${init.method || 'GET'} ${url.replace('https://sheets.googleapis.com/v4/spreadsheets/SID', '')}`);
    if (url.includes('oauth2')) {
      const jwt = new URLSearchParams(init.body).get('assertion');
      const [h, p, s] = jwt.split('.');
      assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, s, 'base64url'), 'JWT 簽章');
      const claims = JSON.parse(Buffer.from(p, 'base64url'));
      assert.equal(claims.iss, sa.client_email);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets');
      return res(200, { access_token: 'ST' });
    }
    if (url.endsWith('?fields=sheets.properties.title')) return res(200, { sheets: sheet.BotLog ? [{ properties: { title: 'BotLog' } }] : [] });
    if (url.endsWith(':batchUpdate')) { sheet.BotLog = []; return res(200, {}); }
    if (init.method === 'PUT') { sheet.BotLog.push(...JSON.parse(init.body).values); return res(200, {}); }
    if (url.includes(':append')) { sheet.BotLog.push(...JSON.parse(init.body).values); return res(200, {}); }
    return res(200, { values: sheet.BotLog.slice(1) });
  };
  const store = sheetsStore({ spreadsheetId: 'SID', tab: 'BotLog', serviceAccount: JSON.stringify(sa), fetchImpl });
  assert.deepEqual(await store.load(), []);
  assert.deepEqual(sheet.BotLog[0], COLUMNS, '自動寫入標題列');
  await store.append([{ commentId: 'c1', status: 'replied', replyId: 'r1', platform: 'youtube' }]);
  const rows = await store.load();
  assert.equal(rows[0].commentId, 'c1');
  assert.equal(rows[0].replyId, 'r1');
  assert.equal(rows[0].tickers, '');
  assert.equal(log.filter((l) => l.includes('batchUpdate')).length, 1, '分頁只建立一次');
});

// ── 代碼資料庫來源 ─────────────────────────────────────────────────────
test('美股：Nasdaq 清單', () => {
  const txt = [
    'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
    'AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N',
    'GOOGL|Alphabet Inc. - Class A Common Stock|Q|N|N|100|N|N',
    'GOOG|Alphabet Inc. - Class C Capital Stock|Q|N|N|100|N|N',
    'QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N',
    'AACG|ATA Creativity Global - American Depositary Shares, each representing two common shares|S|N|N|100|N|N',
    'AACIU|Armada Acquisition Corp. III - Units|G|N|N|100|N|N',
    'AACIW|Armada Acquisition Corp. III - Warrant|G|N|N|100|N|N',
    'ZXZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N',
    'File Creation Time: 1004202614:00|||||||',
  ].join('\n');
  assert.deepEqual(parseNasdaqListed(txt), {
    AAPL: 'Apple Inc.', GOOGL: 'Alphabet Inc. Class A', GOOG: 'Alphabet Inc. Class C', QQQ: 'Invesco QQQ Trust, Series 1', AACG: 'ATA Creativity Global',
  });
});

test('美股：NYSE 等其他交易所清單', () => {
  const txt = [
    'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
    'A|Agilent Technologies, Inc. Common Stock|N|A|N|100|N|A',
    'AA|Alcoa Corporation Common Stock |N|AA|N|100|N|AA',
    'BRK.B|Berkshire Hathaway Inc. New Common Stock|N|BRK.B|N|100|N|BRK.B',
    'TSM|Taiwan Semiconductor Manufacturing Company Ltd.|N|TSM|N|100|N|TSM',
    'VOO|Vanguard S&P 500 ETF|P|VOO|Y|100|N|VOO',
    'ABR$D|Arbor Realty Trust 6.375% Series D Cumulative Redeemable Preferred Stock|N|ABRpD|N|100|N|ABR-D',
    'XYZ.U|XYZ Acquisition Corp Units|N|XYZ.U|N|100|N|XYZ=',
    'XYZ.WS|XYZ Acquisition Corp Warrants|N|XYZ.WS|N|100|N|XYZ+',
  ].join('\n');
  assert.deepEqual(parseOtherListed(txt), {
    A: 'Agilent Technologies, Inc.', AA: 'Alcoa Corporation', 'BRK-B': 'Berkshire Hathaway Inc.',
    TSM: 'Taiwan Semiconductor Manufacturing Company Ltd.', VOO: 'Vanguard S&P 500 ETF',
  });
});

test('台股：上市與上櫃', () => {
  const twse = [
    { Code: '2330', Name: '台積電' }, { Code: '0050', Name: '元大台灣50' }, { Code: '00631L', Name: '元大台灣50正2' },
    { Code: '00400A', Name: '主動國泰動能高息' }, { Code: '030001', Name: '某權證' }, { Code: '9103', Name: '美德醫療-DR' },
  ];
  assert.deepEqual(Object.keys(parseTwList(twse, 'TW')).sort(), ['00400A', '0050', '00631L', '2330', '9103']);
  assert.deepEqual(parseTwList([{ SecuritiesCompanyCode: '6488', CompanyName: '環球晶' }], 'TWO'), { 6488: { y: '6488.TWO', n: '環球晶' } });
});

test('加密貨幣：排除穩定幣、黃金代幣、包裝幣', () => {
  const coins = [
    { symbol: 'btc', name: 'Bitcoin', current_price: 120000 },
    { symbol: 'usdt', name: 'Tether', current_price: 1 },
    { symbol: 'xaut', name: 'Tether Gold', current_price: 3800 },
    { symbol: 'wbtc', name: 'Wrapped Bitcoin', current_price: 120000 },
    { symbol: 'steth', name: 'Lido Staked Ether', current_price: 4000 },
    { symbol: 'eth', name: 'Ethereum', current_price: 4000 },
    { symbol: 'xyzusd', name: 'XYZ USD', current_price: 1.0 },
  ];
  assert.deepEqual(filterCoins(coins).map((c) => c.sym), ['BTC', 'ETH']);
});
