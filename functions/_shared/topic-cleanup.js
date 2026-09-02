// functions/_shared/topic-cleanup.js
import { TG } from './tg.js';

/**
 * 获取当前 UTC+8 的日期字符串 YYYY-MM-DD
 */
export function getUtc8DateString(date = new Date()) {
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().slice(0, 10);
}

/**
 * 计算距离下一个 UTC+8 08:00 (即 UTC 00:00:00) 的毫秒数
 */
export function getMsUntilNextUtc8EightAm() {
  const now = new Date();
  const nextUtcMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return Math.max(1000, nextUtcMidnight.getTime() - now.getTime());
}

/**
 * 执行清理被封禁用户话题的任务
 */
export async function cleanupBannedUserTopics({ db, settings, tg }) {
  const allSettings = settings || (await db.getAllSettings());
  const botToken = allSettings?.BOT_TOKEN;
  const groupId = parseInt(allSettings?.FORUM_GROUP_ID, 10);

  if (!botToken || !groupId) {
    console.warn('[topic-cleanup] BOT_TOKEN 或 FORUM_GROUP_ID 未配置，跳过清理');
    return { ok: false, reason: 'missing_config', count: 0 };
  }

  const tgClient = tg || new TG(botToken);
  let bannedUsers = [];
  try {
    bannedUsers = await db.getBlockedUsersWithThread();
  } catch (err) {
    console.error('[topic-cleanup] 查询被封禁用户失败:', err);
    return { ok: false, reason: 'db_error', count: 0 };
  }

  if (!bannedUsers || bannedUsers.length === 0) {
    console.log('[topic-cleanup] 当前没有需要删除话题的被封禁用户');
    return { ok: true, count: 0 };
  }

  console.log(`[topic-cleanup] 开始清理被封禁用户话题，共发现 ${bannedUsers.length} 个目标`);
  let deletedCount = 0;

  for (const user of bannedUsers) {
    const uid = user.user_id || user.id;
    const threadId = user.thread_id;
    if (!threadId) continue;

    try {
      // 1. 调用 TG API 删除话题 (deleteForumTopic)
      const res = await tgClient.deleteForumTopic({ chatId: groupId, threadId });
      if (!res.ok) {
        console.warn(`[topic-cleanup] TG 删除话题 ${threadId} 失败 (uid=${uid}):`, res.description);
        // 如果删除失败（例如权限不足），尝试降级关闭话题
        await tgClient.closeForumTopic({ chatId: groupId, threadId }).catch(() => {});
      } else {
        console.log(`[topic-cleanup] 成功删除用户 ${uid} 的话题 ${threadId}`);
      }
    } catch (e) {
      console.error(`[topic-cleanup] 调用 TG API 异常 (uid=${uid}, threadId=${threadId}):`, e);
    }

    // 2. 清理数据库中的 thread 绑定
    try {
      await db.clearUserThread(uid);
      deletedCount++;
    } catch (dbErr) {
      console.error(`[topic-cleanup] 清除 DB thread_id 失败 (uid=${uid}):`, dbErr);
    }

    // 3. 避免速率限制 (Telegram Bot API 限制)
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`[topic-cleanup] 清理完成，共处理 ${deletedCount} 个用户话题`);
  return { ok: true, count: deletedCount };
}

/**
 * 检查并执行每日自动清理（用于 webhook / 请求接收时的系统自驱动触发）
 */
export async function checkAndRunScheduledTopicCleanup(db, kv, settings) {
  if (!kv) return;
  const todayUtc8 = getUtc8DateString();
  const cacheKey = 'cron:last_topic_cleanup_date';

  try {
    const lastDate = await kv.get(cacheKey);
    if (lastDate === todayUtc8) {
      return;
    }

    // 尝试获取锁，防止多请求并发执行
    const lockKey = `lock:topic_cleanup:${todayUtc8}`;
    const acquired = await kv.get(lockKey);
    if (acquired) return;
    await kv.put(lockKey, '1', { expirationTtl: 300 }).catch(() => {});

    // 记录今日已执行
    await kv.put(cacheKey, todayUtc8, { expirationTtl: 86400 * 3 }).catch(() => {});

    // 执行清理
    const allSettings = settings || (await db.getAllSettings());
    if (allSettings.AUTO_DELETE_BANNED_TOPICS_ENABLED === 'false') {
      return;
    }
    await cleanupBannedUserTopics({ db, settings: allSettings, kv });
  } catch (err) {
    console.error('[topic-cleanup] 调度检查异常:', err);
  }
}

/**
 * 启动 Node.js 常驻进程定时器（每天 UTC+8 08:00 / UTC 00:00:00 精确执行）
 */
export function startTopicCleanupScheduler(db, kv) {
  let timer = null;

  async function runTask() {
    try {
      console.log('[scheduler] 到达设定时间 (UTC+8 08:00)，系统开始自动清理被封禁用户话题...');
      const settings = await db.getAllSettings();
      if (settings.AUTO_DELETE_BANNED_TOPICS_ENABLED !== 'false') {
        await cleanupBannedUserTopics({ db, settings, kv });
      }
      // 标记今天已执行
      const todayUtc8 = getUtc8DateString();
      if (kv) {
        await kv.put('cron:last_topic_cleanup_date', todayUtc8, { expirationTtl: 86400 * 3 }).catch(() => {});
      }
    } catch (e) {
      console.error('[scheduler] 执行自动清理任务失败:', e);
    } finally {
      scheduleNext();
    }
  }

  function scheduleNext() {
    const delay = getMsUntilNextUtc8EightAm();
    const hours = (delay / 3600000).toFixed(2);
    console.log(`[scheduler] 下次自动清理封禁用户话题将在 ${hours} 小时后触发 (每天 UTC+8 08:00)`);
    timer = setTimeout(runTask, delay);
    if (timer && timer.unref) {
      timer.unref(); // 不阻止进程退出
    }
  }

  // 启动时检查：若当天尚未执行清理则自动补跑一次
  setTimeout(async () => {
    try {
      const todayUtc8 = getUtc8DateString();
      const lastDate = kv ? await kv.get('cron:last_topic_cleanup_date') : null;
      if (lastDate !== todayUtc8) {
        const settings = await db.getAllSettings();
        if (settings.AUTO_DELETE_BANNED_TOPICS_ENABLED !== 'false') {
          console.log('[scheduler] 检测到今日尚未执行清理，正在执行启动补跑...');
          await cleanupBannedUserTopics({ db, settings, kv });
          if (kv) {
            await kv.put('cron:last_topic_cleanup_date', todayUtc8, { expirationTtl: 86400 * 3 }).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.warn('[scheduler] 启动清理补跑失败:', e.message);
    }
  }, 3000);

  scheduleNext();

  return () => {
    if (timer) clearTimeout(timer);
  };
}
