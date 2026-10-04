// Google Sheet 存取。共用同一份試算表，用不同分頁：
//   BotLog       —— $ 查詢的處理記錄（去重、上限）
//   留言-YouTube —— 一般留言待辦清單（之後每個平台一個分頁：留言-X…）
//   回覆庫       —— 問題與 Henry 認可過的回覆
// 分頁不存在時自動建立並寫入標題列。

import { serviceAccountToken } from './google-auth.mjs';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export function sheetsClient({ spreadsheetId, serviceAccount, fetchImpl = fetch }) {
  let token;
  const auth = async () => (token ??= await serviceAccountToken(serviceAccount, 'https://www.googleapis.com/auth/spreadsheets', fetchImpl));
  let titles;

  async function call(path, init = {}) {
    const res = await fetchImpl(`${BASE}/${spreadsheetId}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await auth()}`, 'Content-Type': 'application/json' },
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`Sheets ${res.status}`); e.status = res.status; throw e; }
    return d;
  }
  const rangeOf = (tab, a1) => encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${a1}`);
  const colLetter = (n) => String.fromCharCode(64 + n); // 本專案欄位都少於 26 欄

  return {
    // setup(sheetId) 只在新建分頁時呼叫，用來加下拉選單等格式
    async ensureTab(tab, headers, setup) {
      if (!titles) {
        const meta = await call('?fields=sheets.properties(title,sheetId)');
        titles = new Map((meta.sheets || []).map((s) => [s.properties.title, s.properties.sheetId]));
      }
      if (titles.has(tab)) return;
      const r = await call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }] }) });
      const sheetId = r.replies?.[0]?.addSheet?.properties?.sheetId;
      titles.set(tab, sheetId);
      await call(`/values/${rangeOf(tab, 'A1')}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [headers] }) });
      if (setup && sheetId != null) await call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: setup(sheetId) }) });
    },
    async readRows(tab, ncols) {
      const d = await call(`/values/${rangeOf(tab, `A2:${colLetter(ncols)}`)}`);
      return (d.values || []).map((v, i) => ({ rowNumber: i + 2, values: Array.from({ length: ncols }, (_, k) => v[k] ?? '') }));
    },
    async append(tab, ncols, rows) {
      if (!rows.length) return;
      await call(`/values/${rangeOf(tab, `A:${colLetter(ncols)}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST', body: JSON.stringify({ values: rows }),
      });
    },
    // updates: [{ row, col, value }]，col 從 1 開始
    async updateCells(tab, updates) {
      if (!updates.length) return;
      await call('/values:batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data: updates.map((u) => ({ range: `'${tab}'!${colLetter(u.col)}${u.row}`, values: [[u.value]] })) }),
      });
    },
  };
}

// ── 物件化的分頁：欄位名稱 ↔ 欄位位置 ────────────────────────────────
export function tableStore(client, { tab, columns, headers = columns, setup }) {
  const n = columns.length;
  let ready = false;
  const ensure = async () => { if (!ready) { await client.ensureTab(tab, headers, setup); ready = true; } };
  return {
    columns,
    async load() {
      await ensure();
      return (await client.readRows(tab, n)).map((r) => ({ _row: r.rowNumber, ...Object.fromEntries(columns.map((k, i) => [k, r.values[i]])) }));
    },
    async append(objs) {
      await ensure();
      await client.append(tab, n, objs.map((o) => columns.map((k) => o[k] ?? '')));
    },
    // changes: [{ _row, field, value }]
    async update(changes) {
      await ensure();
      await client.updateCells(tab, changes.map((c) => ({ row: c._row, col: columns.indexOf(c.field) + 1, value: c.value })));
    },
  };
}

// BotLog（$ 查詢記錄）—— 維持原本的介面
export const COLUMNS = ['processedAt', 'platform', 'videoId', 'commentId', 'authorId', 'status', 'tickers', 'replyId', 'userDay', 'quotaDay'];

export function sheetsStore({ spreadsheetId, tab, serviceAccount, fetchImpl = fetch, client }) {
  const t = tableStore(client || sheetsClient({ spreadsheetId, serviceAccount, fetchImpl }), { tab, columns: COLUMNS });
  return {
    async load() { return (await t.load()).map(({ _row, ...rest }) => rest); },
    append: (rows) => t.append(rows),
  };
}

// 測試用
export function memoryStore(initial = []) {
  const rows = [...initial];
  return { rows, async load() { return [...rows]; }, async append(r) { rows.push(...r); } };
}

export function memoryTable(columns, initial = []) {
  const rows = initial.map((r, i) => ({ _row: i + 2, ...r }));
  return {
    columns, rows,
    async load() { return rows.map((r) => ({ ...r })); },
    async append(objs) { for (const o of objs) rows.push({ _row: rows.length + 2, ...Object.fromEntries(columns.map((k) => [k, o[k] ?? ''])) }); },
    async update(changes) { for (const c of changes) { const r = rows.find((x) => x._row === c._row); if (r) r[c.field] = c.value; } },
  };
}
