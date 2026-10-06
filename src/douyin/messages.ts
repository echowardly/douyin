import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { config } from '../config.js';
import { humanDelay } from './browser.js';

/**
 * 选择器来自 2026-10-06 真实私信页 probe（data/probe/2026-10-06T01-08-36-225Z-open）。
 * 抖音前端类名多为 CSS Modules 哈希拼接（如 conversationConversationItemtitle），
 * 优先保留 data-e2e；类名选择器在改版后可能失效，需重新 probe。
 */
export const SELECTORS = {
  /** 左侧会话列表每一项 */
  conversationItem: '[data-e2e="conversation-item"]',
  /** 会话项中的对方昵称 */
  conversationName: '.conversationConversationItemtitle',
  /** 会话项未读角标数字 */
  conversationUnread: '.ConversationItemUnReadCountdigitsNumberPop, .semi-badge-count',
  /** 右侧消息流中的单条消息容器（含头像/时间/内容） */
  messageItem: '.messageMessageBoxmessageBox',
  /** 单条消息的可点击内容区 */
  messageContent: '[data-e2e="msg-item-content"]',
  /** 「自己发送」标记（挂在 contentBox / columnBox 上） */
  messageFromSelf: '.messageMessageBoxisFromMe, .MessageBoxContentisFromMe',
  /** 输入区容器 */
  inputContainer: '[data-e2e="msg-input"]',
  /** 输入框（Slate contenteditable） */
  input: '[data-e2e="msg-input"] [contenteditable="true"], .messageEditorinputArea[contenteditable="true"]',
  /** 发送按钮（圆形上箭头；有内容时才可点） */
  sendButton: '.messageMsgInputpublishBtn, .e2e-send-msg-btn',
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
  /** 资源地址（CDN）或页面地址；视频分享卡片通常只有封面图，真实 play_addr 待作品页解析 */
  url: string;
  /** 作品 id（若能从卡片/接口解析到） */
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

/** 列出会话。选择器已按 2026-10-06 probe 验证。 */
export async function listConversations(page: Page): Promise<Conversation[]> {
  await openChat(page);
  await page.locator(SELECTORS.conversationItem).first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
  const items = page.locator(SELECTORS.conversationItem);
  const n = await items.count();
  if (n === 0) {
    console.warn('[messages] 未找到会话列表元素，SELECTORS.conversationItem 需要根据实际 DOM 更新（npm run probe）');
    return [];
  }
  const out: Conversation[] = [];
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    const name =
      (await item.locator(SELECTORS.conversationName).first().textContent().catch(() => null))?.trim() ?? '';
    const unreadText = await item.locator(SELECTORS.conversationUnread).first().textContent().catch(() => null);
    const unreadRaw = unreadText?.trim() ?? '';
    const unread = unreadRaw === '' ? 0 : Number(unreadRaw.replace(/\D/g, '')) || (unreadRaw ? 1 : 0);
    out.push({ id: name || `idx-${i}`, name, unread, index: i });
  }
  return out;
}

export async function openConversation(page: Page, conv: Conversation): Promise<void> {
  await page.locator(SELECTORS.conversationItem).nth(conv.index).click();
  await page.locator(SELECTORS.messageItem).first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
  await humanDelay();
}

type RawMsg = {
  index: number;
  timeLabel: string;
  fromSelf: boolean;
  text: string;
  imgs: string[];
  videos: string[];
  links: string[];
  hasShareAweme: boolean;
  hasPhotosTag: boolean;
  hasPlayIcon: boolean;
  hasEmojiSticker: boolean;
  hasUnsupported: boolean;
  hasFiltered: boolean;
  authorName: string;
  html: string;
};

/**
 * 读取当前打开会话的消息。
 * 依据 probe 得到的 DOM：`.messageMessageBoxmessageBox` + `isFromMe` + 各类 MessageItem* 卡片。
 * IM 接口（imapi.douyin.com）返回 protobuf，暂以 DOM 为主；后续可解码 protobuf 更稳。
 */
export async function readMessages(page: Page, conv: Conversation): Promise<DouyinMessage[]> {
  const raws = await page.evaluate((sel) => {
    const boxes = Array.from(document.querySelectorAll(sel.messageItem));
    return boxes.map((node, index) => {
      const el = node as HTMLElement;
      const fromSelf = Boolean(el.querySelector(sel.messageFromSelf));
      const content = (el.querySelector(sel.messageContent) as HTMLElement | null) ?? el;
      const timeLabel = (el.querySelector('.MessageBoxTimetimeLayout') as HTMLElement | null)?.innerText?.trim() ?? '';
      const textEl = content.querySelector('.TextMessageTexttextInnerContent, .MessageItemTextbubbleTextContent');
      let text = (textEl as HTMLElement | null)?.innerText?.trim() ?? '';
      // 文本气泡里的 emoji 用 title="[哈欠]"；无纯文字时拼 title
      if (!text) {
        const titles = Array.from(content.querySelectorAll('.TextMessageTextemoji img[title]'))
          .map((img) => (img as HTMLImageElement).title)
          .filter(Boolean);
        if (titles.length) text = titles.join('');
      }
      if (!text) {
        const filtered = content.querySelector('.FilteredFilteredMessagefiltered') as HTMLElement | null;
        if (filtered) text = filtered.innerText?.trim() ?? '';
      }
      if (!text) {
        const unsup = content.querySelector('.MessageItemUnsuportunsupport') as HTMLElement | null;
        if (unsup) text = unsup.innerText?.trim() ?? '';
      }
      const imgs = Array.from(content.querySelectorAll('img'))
        .map((x) => (x as HTMLImageElement).src)
        .filter((u) => u && !u.startsWith('data:') && !/avatar|aweme-avatar|flame_icon|emoji/i.test(u));
      // 分享卡片封面（优先）
      const cover = (content.querySelector('img.MessageItemShareAwemeawemeContainer') as HTMLImageElement | null)?.src;
      const sticker = (content.querySelector('.MessageItemEmojiimage') as HTMLImageElement | null)?.src;
      const videos = Array.from(content.querySelectorAll('video')).map(
        (x) => (x as HTMLVideoElement).currentSrc || (x as HTMLVideoElement).src,
      );
      const links = Array.from(content.querySelectorAll('a')).map((x) => (x as HTMLAnchorElement).href);
      const authorName =
        (content.querySelector('.MessageItemShareAwemeauthorName') as HTMLElement | null)?.innerText?.trim() ?? '';
      return {
        index,
        timeLabel,
        fromSelf,
        text,
        imgs: cover ? [cover, ...imgs.filter((u) => u !== cover)] : imgs,
        videos,
        links,
        hasShareAweme: Boolean(content.querySelector('.MessageItemShareAwemecontainer')),
        hasPhotosTag: Boolean(content.querySelector('.MessageItemShareAwemephotosTag')),
        hasPlayIcon: Boolean(content.querySelector('.MessageItemShareAwemeplayIcon')),
        hasEmojiSticker: Boolean(content.querySelector('.MessageItemEmojiemojiBox')),
        hasUnsupported: Boolean(content.querySelector('.MessageItemUnsuportunsupport')),
        hasFiltered: Boolean(content.querySelector('.FilteredFilteredMessagefiltered')),
        authorName,
        html: el.outerHTML.slice(0, 4000),
      };
    });
  }, {
    messageItem: SELECTORS.messageItem,
    messageContent: SELECTORS.messageContent,
    messageFromSelf: SELECTORS.messageFromSelf,
  });

  return (raws as RawMsg[]).map((r) => classify(conv, r));
}

/** 依据卡片内容粗分消息类型（规则来自 2026-10-06 真实 DOM）。 */
function classify(conv: Conversation, r: RawMsg): DouyinMessage {
  const awemeLink = r.links.find((l) => /douyin\.com\/(video|note)\//.test(l));
  const awemeId = awemeLink?.match(/\/(video|note)\/(\d+)/)?.[2];
  let kind: MessageKind = 'unknown';
  const media: MediaRef[] = [];

  if (r.hasShareAweme) {
    // 图集带 photosTag（即便也有 playIcon）；纯视频只有 playIcon。封面先当 image 喂多模态。
    kind = r.hasPhotosTag ? 'image_album' : 'video';
    const cover = r.imgs[0];
    if (cover) {
      // 封面按 image 下载，避免把 jpeg 封面当 mp4 抽帧失败
      media.push({ type: 'image', url: cover, awemeId });
    }
    if (awemeLink) media.push({ type: kind === 'image_album' ? 'image' : 'video', url: awemeLink, awemeId });
    if (r.authorName && !r.text) r.text = `分享了@${r.authorName}的作品`;
    else if (r.authorName) r.text = `${r.text}（@${r.authorName}）`;
  } else if (r.videos.length || awemeLink?.includes('/video/')) {
    kind = 'video';
    media.push(...(r.videos.length ? r.videos : [awemeLink!]).map((url) => ({ type: 'video' as const, url, awemeId })));
  } else if (awemeLink?.includes('/note/')) {
    kind = 'image_album';
    media.push({ type: 'image', url: awemeLink, awemeId });
    media.push(...r.imgs.map((url) => ({ type: 'image' as const, url, awemeId })));
  } else if (r.hasEmojiSticker) {
    kind = 'sticker';
    if (r.imgs[0] || r.imgs.length === 0) {
      const stickerImg = r.imgs[0];
      // sticker src 可能被 avatar 过滤掉了，从 html 里不再二次取；有则作为 image
      if (stickerImg) media.push({ type: 'image', url: stickerImg });
    }
  } else if (r.imgs.length && !r.text.trim()) {
    kind = r.imgs.length > 1 ? 'image_album' : 'image';
    media.push(...r.imgs.map((url) => ({ type: 'image' as const, url })));
  } else if (r.hasUnsupported || r.hasFiltered) {
    kind = 'unknown';
  } else if (r.links.length && !r.text.trim()) {
    kind = 'link';
  } else if (r.text.trim()) {
    kind = 'text';
  }

  // sticker：上面 imgs 过滤掉了 emoji CDN，补抓
  if (kind === 'sticker' && !media.length) {
    const m = r.html.match(/MessageItemEmojiimage[^>]*src="([^"]+)"/);
    if (m?.[1]) media.push({ type: 'image', url: m[1].replace(/&amp;/g, '&') });
  }

  const idSeed = [conv.id, r.fromSelf ? 'me' : 'them', kind, r.timeLabel, r.text, media[0]?.url ?? '', r.index].join('|');
  return {
    id: `${conv.id}#${hash(idSeed)}`,
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

/** 在当前会话发送文本回复。输入框为 Slate contenteditable；优先点发送按钮，否则回车。 */
export async function sendReply(page: Page, text: string): Promise<void> {
  const input = page.locator(SELECTORS.input).last();
  await input.click();
  await humanDelay(300, 300);
  // Slate 编辑器：先全选清空再输入，避免残留零宽字符
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await input.pressSequentially(text, { delay: 40 + Math.random() * 60 });
  await humanDelay(300, 400);
  const btn = page.locator(SELECTORS.sendButton);
  if (await btn.count()) await btn.first().click();
  else await page.keyboard.press('Enter');
}

/** 探测：保存私信页 HTML、截图、以及私信相关接口响应；会自动点开第一个会话以抓消息 DOM。 */
export async function probe(page: Page, waitMs = 20_000): Promise<string> {
  const dir = path.join(config.dataDir, 'probe', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  let n = 0;
  page.on('response', async (res) => {
    const url = res.url();
    if (!/im|message|conversation|chat|msg|inbox|stranger|aweme\/detail/i.test(url)) return;
    const ct = res.headers()['content-type'] ?? '';
    if (!/json|protobuf|octet|text/.test(ct)) return;
    const body = await res.text().catch(() => '');
    if (!body || body.length < 2) return;
    await fs.writeFile(
      path.join(dir, `resp-${String(++n).padStart(3, '0')}.json`),
      JSON.stringify({ url, ct, body: body.slice(0, 500_000) }, null, 2),
    );
  });
  await page.goto(config.douyin.chatUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(2500, 1000);
  await fs.writeFile(path.join(dir, 'list.html'), await page.content());
  await page.screenshot({ path: path.join(dir, 'list.png'), fullPage: true });

  const items = page.locator(SELECTORS.conversationItem);
  const count = await items.count();
  console.log(`[probe] 会话数=${count}，将自动点开第一个并等待 ${waitMs / 1000}s……`);
  if (count > 0) {
    await items.first().click();
    await humanDelay(3000, 1000);
  }
  await page.waitForTimeout(waitMs);
  await fs.writeFile(path.join(dir, 'page.html'), await page.content());
  await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: true });
  // 结构化 DOM 摘要，方便下次改选择器
  const summary = await page.evaluate((sel) => {
    const e2e = [...new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((el) => el.getAttribute('data-e2e')))];
    return {
      e2e,
      conversations: document.querySelectorAll(sel.conversationItem).length,
      messages: document.querySelectorAll(sel.messageItem).length,
      inputs: document.querySelectorAll(sel.input).length,
      sendButtons: document.querySelectorAll(sel.sendButton).length,
    };
  }, SELECTORS);
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('[probe] summary', summary);
  return dir;
}
