// 一批處理流程（與平台無關）。
//
//   各平台抓新留言 → 只看有 $ 的 → 查資料庫 → 依「人＋影片」合併 →
//   檢查每人每日／平台每日上限 → 查分數 → 回覆 → 寫記錄
//
// 記錄（BotLog）每一列 = 一則處理過的留言：
//   processedAt | platform | videoId | commentId | authorId | status | tickers | replyId | userDay | quotaDay
//   status：replied（已回）／limit（當天已回過，不再回）／unsupported（代碼對，但算不出分數）
// 打錯或查不到的代碼不記錄（Henry 定案）。

import { extractTokens, hasCJK } from './parse.mjs';
import { resolveTokens } from './resolve.mjs';
import { formatReply } from './format.mjs';
import { dayIn } from './dates.mjs';
import { QuotaError } from './errors.mjs';

export async function runBatch({ config, db, store, adapters, scorer, now = new Date(), dryRun = false, log = console.log }) {
  const rows = await store.load();
  const processed = new Set(rows.map((r) => r.commentId));
  const userDay = dayIn(config.userDayTimeZone, now);
  const summary = {};

  for (const adapter of adapters) {
    const pcfg = config.platforms[adapter.name];
    const quotaDay = dayIn(pcfg.quotaTimeZone || 'UTC', now);
    const stats = { fetched: 0, withDollar: 0, replied: 0, limited: 0, unsupported: 0, retryLater: 0, capReached: false };
    summary[adapter.name] = stats;

    const comments = await adapter.fetchComments({ now });
    stats.fetched = comments.length;

    // 只看還沒處理、不是頻道自己、有 $ 代碼且資料庫查得到的留言
    const candidates = [];
    for (const c of comments) {
      if (processed.has(c.id) || adapter.isOwnComment(c)) continue;
      const tokens = extractTokens(c.text);
      if (!tokens.length) continue;
      stats.withDollar++;
      candidates.push({ ...c, tokens });
    }

    // 同一個人在同一支影片的留言合併成一則回覆
    const groups = new Map();
    for (const c of candidates.sort((a, b) => a.publishedAt - b.publishedAt)) {
      const key = `${c.videoId}|${c.authorId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const repliesToday = (pred) =>
      new Set(rows.filter((r) => r.platform === adapter.name && r.status === 'replied' && pred(r)).map((r) => r.replyId)).size;

    for (const group of groups.values()) {
      const items = resolveTokens(group.flatMap((c) => c.tokens), db, config.maxTickersPerReply);
      if (!items.length) continue; // 全部是無效代碼：不回、不記錄

      if (repliesToday((r) => r.quotaDay === quotaDay) >= pcfg.dailyReplyCap) {
        stats.capReached = true; // 剩下的留到額度重置後
        break;
      }

      const target = group[group.length - 1]; // 回在最新那則底下
      const base = { platform: adapter.name, videoId: target.videoId, authorId: target.authorId, userDay, quotaDay };
      const mkRows = (status, replyId = '') =>
        group.map((c) => ({ ...base, processedAt: now.toISOString(), commentId: c.id, status, replyId, tickers: items.map((i) => i.symbol).join(',') }));

      const isTester = (config.testAuthorIds || []).includes(target.authorId); // 測試帳號不受每人每日上限
      if (!isTester && repliesToday((r) => r.authorId === target.authorId && r.userDay === userDay) >= config.perUserDailyReplies) {
        stats.limited += group.length;
        await persist(mkRows('limit'));
        continue;
      }

      for (const it of items) Object.assign(it, await scorer.get(it.symbol));
      const ok = items.filter((i) => i.status === 'ok');
      if (!ok.length) {
        if (items.some((i) => i.status === 'error')) { stats.retryLater++; continue; } // 暫時失敗，下一批再試
        stats.unsupported++;
        await persist(mkRows('unsupported'));
        continue;
      }

      const lang = group.some((c) => hasCJK(c.text)) ? 'zh' : 'en';
      const text = formatReply({ lang, mention: target.isReply ? target.authorName : '', items, siteUrl: config.siteUrl });

      if (dryRun) {
        log(`${adapter.name}｜留言者 ID：${target.authorId}\n原文：${group.map((c) => c.text).join(' / ')}\n讀到的代碼：${group.flatMap((c) => c.tokens).join(', ')}｜有效：${items.map((i) => i.symbol).join(', ')}\n---\n${text}`);
        stats.replied++;
        continue;
      }

      let replyId;
      try {
        replyId = await adapter.reply({ target, text });
      } catch (e) {
        if (e instanceof QuotaError) { stats.capReached = true; break; }
        stats.retryLater++;
        log(`${adapter.name}: reply failed (${e.message})`);
        continue;
      }
      stats.replied++;
      await persist(mkRows('replied', replyId)); // 每回一則立刻記錄，避免中途失敗造成重複回覆
    }
  }

  return summary;

  async function persist(newRows) {
    if (dryRun) return;
    rows.push(...newRows);
    for (const r of newRows) processed.add(r.commentId);
    await store.append(newRows);
  }
}
