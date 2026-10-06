import type { DouyinMessage } from '../douyin/messages.js';

export interface ReplyWindow {
  /** 本轮需要回复的对方消息：自己最后一次发言之后、未处理过的 */
  incoming: DouyinMessage[];
  /** 仅供参考的纯文本上下文：窗口之前的最后几条（不下载/理解媒体） */
  context: DouyinMessage[];
  /** 自己最后一条消息的下标；-1 表示可见范围内没有自己的发言 */
  lastSelfIndex: number;
}

/**
 * 只回复「我上次发言之后」的消息，更早的历史一律不读不回。
 * - 找到可见消息里最后一条 fromSelf，取它之后的对方消息；
 * - 再用 seen 去重（同一窗口内已回复过的不再回）；
 * - 可见范围内没有自己的发言时（全新会话 / 自己的消息被滚出），最多取最后 maxIncoming 条，避免一口气处理大段历史。
 */
export function selectReplyWindow(
  msgs: DouyinMessage[],
  isSeen: (id: string) => boolean,
  opts: { maxIncoming: number; contextSize: number },
): ReplyWindow {
  let lastSelfIndex = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].fromSelf) {
      lastSelfIndex = i;
      break;
    }
  }
  const tail = msgs.slice(lastSelfIndex + 1).filter((m) => !m.fromSelf);
  const incoming = tail.filter((m) => !isSeen(m.id)).slice(-Math.max(1, opts.maxIncoming));
  const firstIncoming = incoming.length ? msgs.indexOf(incoming[0]) : msgs.length;
  const context = opts.contextSize > 0 ? msgs.slice(0, firstIncoming).slice(-opts.contextSize) : [];
  return { incoming, context, lastSelfIndex };
}
