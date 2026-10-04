// BotLog 記錄存在共用的 Google Sheet。分頁不存在時自動建立並寫入標題列。

import { serviceAccountToken } from './google-auth.mjs';

export const COLUMNS = ['processedAt', 'platform', 'videoId', 'commentId', 'authorId', 'status', 'tickers', 'replyId', 'userDay', 'quotaDay'];
const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export function sheetsStore({ spreadsheetId, tab, serviceAccount, fetchImpl = fetch }) {
  let token;
  const auth = async () => (token ??= await serviceAccountToken(serviceAccount, 'https://www.googleapis.com/auth/spreadsheets', fetchImpl));

  async function call(path, init = {}) {
    const res = await fetchImpl(`${BASE}/${spreadsheetId}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await auth()}`, 'Content-Type': 'application/json' },
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`Sheets ${res.status}`); e.status = res.status; throw e; }
    return d;
  }

  async function ensureTab() {
    const meta = await call('?fields=sheets.properties.title');
    if (meta.sheets?.some((s) => s.properties.title === tab)) return;
    await call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) });
    await call(`/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [COLUMNS] }) });
  }

  return {
    async load() {
      await ensureTab();
      const d = await call(`/values/${encodeURIComponent(`${tab}!A2:J`)}`);
      return (d.values || []).map((v) => Object.fromEntries(COLUMNS.map((k, i) => [k, v[i] ?? ''])));
    },
    async append(rows) {
      if (!rows.length) return;
      await call(`/values/${encodeURIComponent(`${tab}!A:J`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: JSON.stringify({ values: rows.map((r) => COLUMNS.map((k) => r[k] ?? '')) }),
      });
    },
  };
}

// 測試用
export function memoryStore(initial = []) {
  const rows = [...initial];
  return { rows, async load() { return [...rows]; }, async append(r) { rows.push(...r); } };
}
