// Google 授權（不靠任何套件）
//   · Service Account → 讀寫 Google Sheet
//   · OAuth Refresh Token → 以頻道身分讀留言、回覆

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function serviceAccountToken(saJson, scope, fetchImpl = fetch) {
  const sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  return exchange({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }, fetchImpl);
}

export async function refreshToken({ clientId, clientSecret, refreshToken }, fetchImpl = fetch) {
  return exchange({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }, fetchImpl);
}

async function exchange(params, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error(`Google token error ${res.status} ${d.error || ''}`.trim());
  return d.access_token;
}
