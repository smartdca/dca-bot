// YouTube 模組：只負責「抓留言」「核准」「回覆」，其他規則都在 core/。
//
// 額度（每天 10,000 點）：讀一頁留言 1 點、核准一則 50 點、回覆一則 50 點。
// 只讀 config 裡列出的影片；新增影片 = 把影片 ID 加進 config.json。
//
// holdAll（全部攔截模式，Henry 2026-10-05 定案）：
//   影片在 YouTube 設成「全部攔截」，所有留言先被扣住。Bot 同時讀「已公開」與「被攔截」的留言，
//   格式正確的 $ 查詢先核准再回覆（一則共 100 點），其他留言維持扣住，交給留言分頁由 Henry 處理。
//   YouTube 判定為「可能是垃圾」的留言（likelySpam）一律不讀。

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
    if (res.status === 204) return {};
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = d.error?.errors?.[0]?.reason || '';
      if (res.status === 403 && /quota/i.test(reason)) throw new QuotaError(reason);
      throw new Error(`YouTube ${res.status} ${reason}`.trim());
    }
    return d;
  }

  async function listThreads(videoId, moderationStatus, cutoff, out) {
    let pageToken = '';
    for (let page = 0; page < cfg.maxPagesPerVideo; page++) {
      const q = new URLSearchParams({ part: 'snippet,replies', videoId, maxResults: '100', textFormat: 'plainText' });
      if (moderationStatus !== 'published') q.set('moderationStatus', moderationStatus);
      if (pageToken) q.set('pageToken', pageToken);
      const d = await call(`/commentThreads?${q}`);
      let reachedOld = false;
      for (const th of d.items || []) {
        const top = th.snippet.topLevelComment;
        const held = moderationStatus === 'heldForReview';
        const replies = th.replies?.comments || [];
        if (Date.parse(top.snippet.publishedAt) >= cutoff) {
          const c = toComment(top, videoId, th.id, false, held);
          // 頻道自己在這串底下的回覆（用來偵測 Henry 有沒有回了）
          c.channelReplies = replies
            .filter((r) => r.snippet.authorChannelId?.value === cfg.channelId)
            .map((r) => ({ id: r.id, text: r.snippet.textOriginal ?? r.snippet.textDisplay ?? '', publishedAt: new Date(r.snippet.publishedAt) }));
          out.push(c);
        } else {
          reachedOld = true;
        }
        for (const r of replies) {
          if (Date.parse(r.snippet.publishedAt) >= cutoff) out.push(toComment(r, videoId, th.id, true, held));
        }
      }
      pageToken = d.nextPageToken;
      if (!pageToken || reachedOld) break;
    }
  }

  return {
    name: 'youtube',
    holdAll: !!cfg.holdAll,

    isOwnComment: (c) => c.authorId === cfg.channelId,

    async fetchComments({ now = new Date() } = {}) {
      const cutoff = now.getTime() - cfg.lookbackHours * 3600 * 1000;
      const out = [];
      for (const videoId of cfg.videoIds) {
        await listThreads(videoId, 'published', cutoff, out);
        if (cfg.holdAll) await listThreads(videoId, 'heldForReview', cutoff, out);
      }
      // 同一則留言可能同時出現在兩份清單（剛被核准），以先出現的為準
      const seen = new Set();
      return out.filter((c) => (seen.has(c.id) ? false : seen.add(c.id)));
    },

    async approve(comment) {
      const q = new URLSearchParams({ id: comment.id, moderationStatus: 'published' });
      await call(`/comments/setModerationStatus?${q}`, { method: 'POST' });
    },

    async reply({ target, text }) {
      const d = await call('/comments?part=snippet', {
        method: 'POST',
        body: JSON.stringify({ snippet: { parentId: target.threadId, textOriginal: text } }),
      });
      return d.id;
    },

    // 給留言分頁用的連結：被攔截的留言在一般頁面看不到，要從 Studio 的留言管理打開
    linkFor(c) {
      return c.held
        ? `https://studio.youtube.com/video/${c.videoId}/comments`
        : `https://www.youtube.com/watch?v=${c.videoId}&lc=${c.id}`;
    },
  };
}

function toComment(c, videoId, threadId, isReply, held) {
  const s = c.snippet;
  return {
    id: c.id,
    videoId,
    threadId,
    isReply,
    held,
    authorId: s.authorChannelId?.value || '',
    authorName: s.authorDisplayName || '',
    text: s.textOriginal ?? s.textDisplay ?? '',
    publishedAt: new Date(s.publishedAt),
  };
}
