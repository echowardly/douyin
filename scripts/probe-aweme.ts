/**
 * 探测私信分享卡片 → aweme_id / 真实媒体地址：
 * 1) 拦截会话打开时页面自己请求的 multi/aweme/detail（origin_type=chat）
 * 2) 尝试从分享卡片 DOM 的 React fiber props 里找 aweme id
 * 3) 用带 cookie 的 context.request 试下载 play_addr（Range 前 1MB）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { isLoggedIn, launchSession, humanDelay } from '../src/douyin/browser.js';
import { listConversations, openConversation } from '../src/douyin/messages.js';

async function main() {
  const dir = path.join(config.dataDir, 'probe', new Date().toISOString().replace(/[:.]/g, '-') + '-aweme');
  await fs.mkdir(dir, { recursive: true });
  const session = await launchSession({ headless: true });
  const details: any[] = [];
  try {
    if (!(await isLoggedIn(session.context))) throw new Error('not logged in');
    session.page.on('response', async (res) => {
      if (!/aweme\/detail|multi\/aweme/.test(res.url())) return;
      const body = await res.text().catch(() => '');
      await fs.writeFile(path.join(dir, `detail-${details.length}.json`), JSON.stringify({ url: res.url(), body }, null, 2));
      try { details.push(JSON.parse(body)); } catch {}
      console.log('[detail]', res.status(), res.url().slice(0, 120));
    });
    const convs = await listConversations(session.page);
    const target = convs.find((c) => config.douyin.ownerName && c.name.includes(config.douyin.ownerName.slice(0, 4))) ?? convs[0]!;
    await openConversation(session.page, target);
    await humanDelay(4000, 500);

    const fiber = await session.page.evaluate(`(() => {
      const out = [];
      document.querySelectorAll('.MessageItemShareAwemecontainer').forEach((el) => {
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactProps'));
        const hits = [];
        let f = key ? el[key] : null;
        for (let depth = 0; f && depth < 25; depth++, f = f.return) {
          const p = f.memoizedProps;
          if (!p || typeof p !== 'object') continue;
          const seen = new WeakSet();
          const walk = (o, pth, d) => {
            if (!o || typeof o !== 'object' || d > 4 || seen.has(o)) return;
            seen.add(o);
            for (const k of Object.keys(o)) {
              if (k === 'children' || k.startsWith('_')) continue;
              const v = o[k];
              if ((typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') && /aweme_?id|itemId|item_id|awemeId/i.test(k))
                hits.push(\`\${depth}:\${pth}.\${k}=\${String(v)}\`);
              else if (typeof v === 'object') walk(v, \`\${pth}.\${k}\`, d + 1);
            }
          };
          walk(p, 'props', 0);
          if (hits.length > 3) break;
        }
        out.push({ cover: el.querySelector('img')?.src?.slice(0, 100), hits: [...new Set(hits)].slice(0, 8) });
      });
      return out;
    })()`) as any;
    console.log('[fiber]', JSON.stringify(fiber, null, 2));

    const all = details.flatMap((d) => d.aweme_details ?? []);
    console.log('[details]', all.map((a: any) => `${a.aweme_id} type=${a.aweme_type} imgs=${a.images?.length ?? 0} dur=${a.video?.duration}`));
    const vid = all.find((a: any) => !a.images?.length && a.video?.play_addr?.url_list?.length);
    if (vid) {
      for (const u of vid.video.play_addr.url_list) {
        const res = await session.context.request.get(u, { headers: { referer: 'https://www.douyin.com/', range: 'bytes=0-1048575' } }).catch((e) => e);
        if (res instanceof Error) { console.log('[dl] err', res.message); continue; }
        console.log('[dl]', res.status(), res.headers()['content-type'], res.headers()['content-range'], u.slice(0, 80));
        if (res.ok()) break;
      }
    }
  } finally {
    await session.close();
  }
  console.log('saved', dir);
}
main().catch((e) => { console.error(e); process.exit(1); });
