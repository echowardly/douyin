import type { BrowserContext } from 'playwright';
import { config } from '../config.js';
import { describeMedia, mediaToParts } from '../douyin/media.js';
import type { DouyinMessage } from '../douyin/messages.js';
import type { ChatMessage, LLMProvider } from '../providers/types.js';

const DEFAULT_SYSTEM = `你是在抖音私信里陪朋友聊天的人，正在回复对方发来的消息。
- 用自然、口语化的中文，简短（通常 1~3 句），像真人一样，不要用列表或 Markdown。
- 如果对方分享了视频/图集，结合内容描述给出有观点、有梗的回应。
- 不要暴露你是 AI 或机器人；不确定的内容不要编造。`;

const KIND_LABEL: Record<DouyinMessage['kind'], string> = {
  text: '文字',
  image: '图片',
  image_album: '图集',
  video: '视频',
  sticker: '表情',
  voice: '语音',
  link: '链接/卡片',
  unknown: '未知类型',
};

/** 把一条消息转成给回复模型的纯文本描述（媒体先经多模态模型理解）。 */
export async function renderMessage(provider: LLMProvider, context: BrowserContext, msg: DouyinMessage): Promise<string> {
  const head = `【${msg.fromSelf ? '我' : msg.senderName}·${KIND_LABEL[msg.kind]}】`;
  if (!msg.media.length) return `${head}${msg.text ?? '(无文字内容)'}`;
  const parts = await mediaToParts(context, msg);
  const desc = await describeMedia(provider, parts, msg.text ? `附带文字：${msg.text}` : undefined);
  return `${head}${msg.text ? msg.text + '\n' : ''}内容理解：${desc}`;
}

/**
 * 根据最近的会话上下文 + 新消息生成回复。
 * @param history 最近若干条（含自己发的），按时间顺序
 * @param incoming 需要回复的新消息（对方发的）
 */
export async function generateReply(
  provider: LLMProvider,
  context: BrowserContext,
  history: DouyinMessage[],
  incoming: DouyinMessage[],
): Promise<string> {
  const historyText = history
    .slice(-10)
    .map((m) => `【${m.fromSelf ? '我' : m.senderName}·${KIND_LABEL[m.kind]}】${m.text ?? ''}`)
    .join('\n');
  const incomingText = (await Promise.all(incoming.map((m) => renderMessage(provider, context, m)))).join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: config.reply.systemPrompt ?? DEFAULT_SYSTEM },
    {
      role: 'user',
      content: `最近聊天记录：\n${historyText || '(无)'}\n\n对方刚发来的新消息：\n${incomingText}\n\n请直接给出我要发送的回复内容。`,
    },
  ];
  return provider.chat(messages, { temperature: 0.8, maxTokens: 300 });
}
