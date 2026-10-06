import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { isLoggedIn, launchSession, humanDelay } from '../src/douyin/browser.js';

async function main() {
  const dir = path.join(config.dataDir, 'probe', new Date().toISOString().replace(/[:.]/g, '-') + '-open');
  await fs.mkdir(dir, { recursive: true });
  const session = await launchSession({ headless: true });
  try {
    if (!(await isLoggedIn(session.context))) throw new Error('not logged in');
    let n = 0;
    session.page.on('response', async (res) => {
      const url = res.url();
      if (!/im|message|conversation|chat|msg|inbox|stranger/i.test(url)) return;
      const ct = res.headers()['content-type'] ?? '';
      if (!/json|octet|protobuf|text/.test(ct)) return;
      const body = await res.text().catch(() => '');
      if (!body || body.length < 2) return;
      await fs.writeFile(
        path.join(dir, `resp-${String(++n).padStart(3, '0')}.json`),
        JSON.stringify({ url, ct, body: body.slice(0, 500_000) }, null, 2),
      );
    });
    await session.page.goto(config.douyin.chatUrl, { waitUntil: 'domcontentloaded' });
    await humanDelay(3000, 1000);
    await fs.writeFile(path.join(dir, 'list.html'), await session.page.content());
    await session.page.screenshot({ path: path.join(dir, 'list.png'), fullPage: true });

    const items = session.page.locator('[data-e2e="conversation-item"]');
    const count = await items.count();
    console.log('conversation items:', count);
    if (count > 0) {
      await items.first().click();
      await humanDelay(5000, 1500);
      await fs.writeFile(path.join(dir, 'chat.html'), await session.page.content());
      await session.page.screenshot({ path: path.join(dir, 'chat.png'), fullPage: true });

      const info = await session.page.evaluate(() => {
        const allE2e = [...new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((el) => el.getAttribute('data-e2e')))];
        const ces = Array.from(document.querySelectorAll('[contenteditable]')).map((el) => ({
          class: (el as HTMLElement).className?.toString?.().slice(0, 200),
          role: el.getAttribute('role'),
          placeholder: el.getAttribute('data-placeholder') || el.getAttribute('placeholder'),
          text: ((el as HTMLElement).innerText || '').slice(0, 80),
        }));
        const classHits: Record<string, number> = {};
        document.querySelectorAll('*').forEach((el) => {
          const c = (el as HTMLElement).className?.toString?.() || '';
          if (/message|Message|bubble|Bubble|chatItem|ChatItem|msgItem|MsgItem|sendBtn|SendBtn|editor|Editor|inputBox|InputBox|RichText|richText|im-saas/i.test(c)) {
            const key = c.slice(0, 180);
            classHits[key] = (classHits[key] || 0) + 1;
          }
        });
        const sendLike = Array.from(document.querySelectorAll('button, div[role="button"], span'))
          .filter((el) => /发送|Send/.test((el as HTMLElement).innerText || ''))
          .slice(0, 10)
          .map((el) => ({
            tag: el.tagName,
            class: (el as HTMLElement).className?.toString?.().slice(0, 200),
            text: ((el as HTMLElement).innerText || '').slice(0, 40),
            e2e: el.getAttribute('data-e2e'),
          }));
        return { allE2e, ces, classHits, sendLike };
      });
      await fs.writeFile(path.join(dir, 'dom-info.json'), JSON.stringify(info, null, 2));
      console.log('e2e:', info.allE2e);
      console.log('contenteditable:', info.ces.length, JSON.stringify(info.ces, null, 2));
      console.log('sendLike:', JSON.stringify(info.sendLike, null, 2));
      console.log('classHits sample:', Object.entries(info.classHits).slice(0, 60));
    }
    console.log('saved to', dir);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
