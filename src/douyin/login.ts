import { config } from '../config.js';
import { isLoggedIn, launchSession } from './browser.js';

/**
 * 打开抖音网页版，等待用户手动扫码 / 验证码登录。
 * 必须有界面（HEADLESS=false）；在远程 box 上请打开桌面观看并扫码。
 */
export async function login(timeoutMs = 5 * 60_000): Promise<void> {
  const session = await launchSession({ headless: false });
  try {
    if (await isLoggedIn(session.context)) {
      console.log('[login] 已检测到登录态，无需重复登录。');
    } else {
      await session.page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
      console.log('[login] 请在打开的浏览器中点击「登录」并用抖音 App 扫码……');
      const deadline = Date.now() + timeoutMs;
      while (!(await isLoggedIn(session.context))) {
        if (Date.now() > deadline) throw new Error('登录超时，请重试 npm run login');
        await session.page.waitForTimeout(2000);
      }
      console.log('[login] 登录成功，登录态已保存到', config.douyin.profileDir);
    }
    // 打开私信页确认入口可用（URL 以实际探测为准）
    await session.page.goto(config.douyin.chatUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await session.page.waitForTimeout(3000);
    console.log('[login] 当前页面：', session.page.url());
  } finally {
    await session.close();
  }
}
