import fs from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';

export interface Session {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * 启动持久化 Chromium 上下文：登录态（cookie / localStorage）保存在 DOUYIN_PROFILE_DIR，
 * 扫码登录一次后，后续 once/watch 直接复用。
 */
export async function launchSession(opts: { headless?: boolean } = {}): Promise<Session> {
  await fs.mkdir(config.douyin.profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(config.douyin.profileDir, {
    headless: opts.headless ?? config.douyin.headless,
    viewport: { width: 1366, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, close: () => context.close() };
}

/** 抖音网页版登录后会写入 sessionid 类 cookie；以此粗略判断是否已登录。 */
export async function isLoggedIn(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies('https://www.douyin.com');
  return cookies.some((c) => /^(sessionid|sessionid_ss|sid_guard)$/.test(c.name) && c.value);
}

/** 带抖动的等待，降低机械化行为特征。 */
export const humanDelay = (base = 800, jitter = 700) =>
  new Promise((r) => setTimeout(r, base + Math.random() * jitter));
