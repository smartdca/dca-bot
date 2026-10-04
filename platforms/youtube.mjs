// YouTube 模組：只負責「抓留言」與「回覆」，其他規則都在 core/。
//
// 額度（每天 10,000 點）：讀一頁留言 1 點、回覆一則 50 點。
// 只讀 config 裡列出的影片；新增影片 = 把影片 ID 加進 config.json。

import { refreshToken } from '../store/google-auth.mjs';
import { QuotaError } from '../core/errors.mjs';

const API = 'https://www.googleapis.com/youtube/v3';

export function youtubeAdapter({ cfg, credentials, fetchImpl = fetch }) {
  let token;
  const auth = async () => (token ??= await refreshToken(credentials, fetchImpl));

  async function call(path, init = {}) {
    const res = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await auth()}`, 'Content-Type': 'application/json' },
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = d.error?.errors?.[0]?.reason || '';
      if (res.status === 403 && /quota/i.test(reason)) throw new QuotaError(reason);
      throw new Error(`YouTube ${res.status} ${reason}`.trim());
    }
    return d;
  }

  return {
    name: 'youtube',

    isOwnComment: (c) => c.authorId === cfg.channelId,

    async fetchComments({ now = new Date() } = {}) {
      const cutoff = now.getTime() - cfg.lookbackHours * 3600 * 1000;
      const out = [];
      for (const videoId of cfg.videoIds) {
        let pageToken = '';
        for (let page = 0; page < cfg.maxPagesPerVideo; page++) {
          const q = new URLSearchParams({ part: 'snippet,replies', videoId, order: 'time', maxResults: '100', textFormat: 'plainText' });
          if (pageToken) q.set('pageToken', pageToken);
          const d = await call(`/commentThreads?${q}`);
          let reachedOld = false;
          for (const th of d.items || []) {
            const top = th.snippet.topLevelComment;
            const topTime = Date.parse(top.snippet.publishedAt);
            if (topTime >= cutoff) out.push(toComment(top, videoId, th.id, false));
            else reachedOld = true;
            for (const r of th.replies?.comments || []) {
              if (Date.parse(r.snippet.publishedAt) >= cutoff) out.push(toComment(r, videoId, th.id, true));
            }
          }
          pageToken = d.nextPageToken;
          if (!pageToken || reachedOld) break;
        }
      }
      return out;
    },

    async reply({ target, text }) {
      const d = await call('/comments?part=snippet', {
        method: 'POST',
        body: JSON.stringify({ snippet: { parentId: target.threadId, textOriginal: text } }),
      });
      return d.id;
    },
  };
}

function toComment(c, videoId, threadId, isReply) {
  const s = c.snippet;
  return {
    id: c.id,
    videoId,
    threadId,
    isReply,
    authorId: s.authorChannelId?.value || '',
    authorName: s.authorDisplayName || '',
    text: s.textOriginal ?? s.textDisplay ?? '',
    publishedAt: new Date(s.publishedAt),
  };
}
