import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { config } from '../config.js';
import { humanDelay } from './browser.js';

/**
 * ⚠️ 以下所有选择器均为【占位符】，尚未在真实抖音网页版上验证。
 * 下一步：npm run login 后执行 npm run probe，抓取私信页 DOM / 网络请求，
 * 再把真实选择器填进 SELECTORS。抖音前端改版频繁，类名多为哈希，
 * 优先用 role / 文本 / data-e2e 属性定位。
 */
export const SELECTORS = {
  // TODO(probe): 左侧会话列表的每一项
  conversationItem: '[data-e2e="conversation-item"]',
  // TODO(probe): 会话项中的对方昵称
  conversationName: '[data-e2e="conversation-name"]',
  // TODO(probe): 会话项上的未读角标
  conversationUnread: '[data-e2e="conversation-unread"]',
  // TODO(probe): 右侧消息流中的单条消息
  messageItem: '[data-e2e="message-item"]',
  // TODO(probe): 输入框（多半是 contenteditable）
  input: '[contenteditable="true"]',
  // TODO(probe): 发送按钮（也可能直接回车发送）
  sendButton: '[data-e2e="send-button"]',
} as const;

export type MessageKind =
  | 'text'
  | 'image'
  | 'image_album' // 图集分享
  | 'video' // 视频分享 / 直接发送的视频
  | 'sticker' // 表情
  | 'voice'
  | 'link' // 链接 / 卡片
  | 'unknown';

export interface MediaRef {
  type: 'image' | 'video';
  /** 资源地址（CDN）或页面地址；视频分享卡片通常只有作品页链接 */
  url: string;
  /** 作品 id（若能从卡片解析到） */
  awemeId?: string;
}

export interface DouyinMessage {
  id: string;
  conversationId: string;
  senderName: string;
  fromSelf: boolean;
  kind: MessageKind;
  text?: string;
  media: MediaRef[];
  timestamp?: number;
  /** 原始 outerHTML 片段，便于调试解析 */
  rawHtml?: string;
}

export interface Conversation {
  id: string;
  name: string;
  unread: number;
  index: number;
}

export async function openChat(page: Page): Promise<void> {
  if (!page.url().startsWith(config.douyin.chatUrl)) {
    await page.goto(config.douyin.chatUrl, { waitUntil: 'domcontentloaded' });
    await humanDelay(2000, 1500);
  }
}

/** 列出会话。TODO(probe): 选择器未验证；找不到时返回空数组并告警。 */
export async function listConversations(page: Page): Promise<Conversation[]> {
  await openChat(page);
  const items = page.locator(SELECTORS.conversationItem);
  const n = await items.count();
  if (n === 0) {
    console.warn('[messages] 未找到会话列表元素，SELECTORS.conversationItem 需要根据实际 DOM 更新（npm run probe）');
    return [];
  }
  const out: Conversation[] = [];
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    const name = (await item.locator(SELECTORS.conversationName).first().textContent().catch(() => null))?.trim() ?? '';
    const unreadText = await item.locator(SELECTORS.conversationUnread).first().textContent().catch(() => null);
    out.push({ id: name || `idx-${i}`, name, unread: Number(unreadText?.trim()) || 0, index: i });
  }
  return out;
}

export async function openConversation(page: Page, conv: Conversation): Promise<void> {
  await page.locator(SELECTORS.conversationItem).nth(conv.index).click();
  await humanDelay();
}

/**
 * 读取当前打开会话的消息。
 * TODO(probe): 需要确定每条消息的 id、发送者、是否自己发送、以及各类型卡片的 DOM 结构。
 * 更稳妥的方案可能是监听 page.on('response') 中的私信接口 JSON，而不是解析 DOM。
 */
export async function readMessages(page: Page, conv: Conversation): Promise<DouyinMessage[]> {
  const items = page.locator(SELECTORS.messageItem);
  const n = await items.count();
  const out: DouyinMessage[] = [];
  for (let i = 0; i < n; i++) {
    const el = items.nth(i);
    const raw = await el.evaluate((node) => {
      const imgs = Array.from(node.querySelectorAll('img')).map((x) => (x as HTMLImageElement).src);
      const videos = Array.from(node.querySelectorAll('video')).map((x) => (x as HTMLVideoElement).currentSrc || (x as HTMLVideoElement).src);
      const links = Array.from(node.querySelectorAll('a')).map((x) => (x as HTMLAnchorElement).href);
      return {
        id: (node as HTMLElement).dataset['id'] ?? '',
        text: (node as HTMLElement).innerText ?? '',
        imgs,
        videos,
        links,
        // TODO(probe): 判断“自己发送”的真实依据（左右对齐 / class / data 属性）
        fromSelf: (node as HTMLElement).className.includes('self'),
        html: (node as HTMLElement).outerHTML.slice(0, 4000),
      };
    });
    out.push(classify(conv, i, raw));
  }
  return out;
}

/** 依据卡片内容粗分消息类型。TODO(probe): 用真实卡片结构替换这些启发式规则。 */
function classify(
  conv: Conversation,
  i: number,
  r: { id: string; text: string; imgs: string[]; videos: string[]; links: string[]; fromSelf: boolean; html: string },
): DouyinMessage {
  const awemeLink = r.links.find((l) => /douyin\.com\/(video|note)\//.test(l));
  const awemeId = awemeLink?.match(/\/(video|note)\/(\d+)/)?.[2];
  let kind: MessageKind = 'unknown';
  const media: MediaRef[] = [];
  if (r.videos.length || awemeLink?.includes('/video/')) {
    kind = 'video';
    media.push(...(r.videos.length ? r.videos : [awemeLink!]).map((url) => ({ type: 'video' as const, url, awemeId })));
  } else if (awemeLink?.includes('/note/')) {
    kind = 'image_album';
    media.push({ type: 'image', url: awemeLink, awemeId });
    media.push(...r.imgs.map((url) => ({ type: 'image' as const, url, awemeId })));
  } else if (r.imgs.length && !r.text.trim()) {
    kind = r.imgs.length > 1 ? 'image_album' : 'image';
    media.push(...r.imgs.map((url) => ({ type: 'image' as const, url })));
  } else if (r.links.length) {
    kind = 'link';
  } else if (r.text.trim()) {
    kind = 'text';
  }
  return {
    id: r.id || `${conv.id}#${i}#${hash(r.html)}`,
    conversationId: conv.id,
    senderName: r.fromSelf ? '(me)' : conv.name,
    fromSelf: r.fromSelf,
    kind,
    text: r.text.trim() || undefined,
    media,
    rawHtml: r.html,
  };
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 在当前会话发送文本回复。TODO(probe): 确认输入框与发送方式（回车 / 按钮）。 */
export async function sendReply(page: Page, text: string): Promise<void> {
  const input = page.locator(SELECTORS.input).last();
  await input.click();
  await humanDelay(300, 300);
  await input.pressSequentially(text, { delay: 40 + Math.random() * 60 });
  await humanDelay(300, 400);
  const btn = page.locator(SELECTORS.sendButton);
  if (await btn.count()) await btn.first().click();
  else await page.keyboard.press('Enter');
}

/** 探测：保存私信页 HTML、截图、以及私信相关接口响应，用于确定真实选择器。 */
export async function probe(page: Page, waitMs = 30_000): Promise<string> {
  const dir = path.join(config.dataDir, 'probe', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  let n = 0;
  page.on('response', async (res) => {
    const url = res.url();
    if (!/im|message|conversation|chat/i.test(url)) return;
    const ct = res.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    const body = await res.text().catch(() => '');
    await fs.writeFile(path.join(dir, `resp-${String(++n).padStart(3, '0')}.json`), JSON.stringify({ url, body }, null, 2));
  });
  await page.goto(config.douyin.chatUrl, { waitUntil: 'domcontentloaded' });
  console.log(`[probe] 已打开私信页，${waitMs / 1000}s 内可手动点开会话，网络响应会被记录……`);
  await page.waitForTimeout(waitMs);
  await fs.writeFile(path.join(dir, 'page.html'), await page.content());
  await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: true });
  return dir;
}
