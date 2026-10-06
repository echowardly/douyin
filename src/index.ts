import { config, resolvedTargets } from './config.js';
import { generateReply } from './agent/reply.js';
import { selectReplyWindow } from './agent/window.js';
import { isLoggedIn, launchSession, type Session } from './douyin/browser.js';
import { login } from './douyin/login.js';
import { listConversations, openConversation, probe, readMessages, sendReply } from './douyin/messages.js';
import { createProvider, type LLMProvider } from './providers/index.js';
import { SeenStore } from './state.js';

function isTarget(name: string, targets: string[]): boolean {
  return targets.some((t) => name === t || name.includes(t));
}

/** 跑一轮：扫描目标会话 → 读取新消息 → 生成并发送回复。 */
async function runOnce(session: Session, provider: LLMProvider, seen: SeenStore): Promise<void> {
  const targets = resolvedTargets();
  if (!targets.length) {
    console.warn('[once] 没有可用的目标用户：DOUYIN_TARGET_USERS=self 时请设置 DOUYIN_OWNER_NAME');
    return;
  }
  const allConvs = await listConversations(session.page);
  const convs = allConvs.filter((c) => isTarget(c.name, targets));
  console.log(`[once] 会话 ${allConvs.length}，命中目标 ${convs.length}（${convs.map((c) => c.name).join(', ') || '无'}）dryRun=${config.dryRun}`);
  let replied = 0;
  for (const conv of convs) {
    await openConversation(session.page, conv);
    const msgs = await readMessages(session.page, conv);
    // 只看「我上次发言之后」的对方消息；更早的历史不读、不下载媒体、不回复
    const { incoming: fresh, context, lastSelfIndex } = selectReplyWindow(msgs, (id) => seen.has(id), {
      maxIncoming: config.reply.maxIncoming,
      contextSize: config.reply.contextMessages,
    });
    if (!fresh.length) continue;
    console.log(
      `[once] ${conv.name}: ${fresh.length} 条新消息 (${fresh.map((m) => m.kind).join(', ')})` +
        (lastSelfIndex < 0 ? `（可见范围内无我的发言，仅取最近 ${config.reply.maxIncoming} 条）` : ''),
    );
    const reply = await generateReply(provider, session.context, context, fresh);
    if (config.dryRun) {
      console.log(`[dry-run] 回复 ${conv.name} → ${reply}`);
      // dry-run 不写入 seen，避免正式跑时跳过这些消息
    } else {
      await sendReply(session.page, reply);
      console.log(`[sent] ${conv.name} ← ${reply}`);
      fresh.forEach((m) => seen.add(m.id));
      await seen.save();
    }
    replied += 1;
  }
  console.log(`[once] 本轮完成：处理会话 ${replied}/${convs.length}`);
}

async function withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const session = await launchSession();
  try {
    if (!(await isLoggedIn(session.context))) throw new Error('未登录，请先运行 npm run login');
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'help';
  switch (cmd) {
    case 'login':
      return login();
    case 'probe':
      return withSession(async (s) => console.log('[probe] 已保存到', await probe(s.page)));
    case 'once': {
      const provider = createProvider();
      const seen = await new SeenStore().load();
      return withSession((s) => runOnce(s, provider, seen));
    }
    case 'watch': {
      const provider = createProvider();
      const seen = await new SeenStore().load();
      console.log(`[watch] provider=${provider.name}/${provider.model} dryRun=${config.dryRun} style=${config.reply.style} targets=${resolvedTargets().join(',') || '(未配置)'}`);
      return withSession(async (s) => {
        let stop = false;
        process.once('SIGINT', () => (stop = true));
        while (!stop) {
          await runOnce(s, provider, seen).catch((e) => console.error('[watch] 本轮出错：', e));
          const wait = config.douyin.pollIntervalMs * (0.7 + Math.random() * 0.6);
          await s.page.waitForTimeout(wait);
        }
      });
    }
    default:
      console.log(`用法: tsx src/index.ts <login|probe|once|watch>
  login  打开浏览器扫码登录，保存登录态
  probe  打开私信页，保存 DOM/截图/接口响应到 data/probe/ 用于确定选择器
  once   扫描一次目标会话并回复
  watch  持续轮询并自动回复（Ctrl+C 退出）`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
