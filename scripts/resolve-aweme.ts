/** 调试：不经私信页，直接解析作品（走「打开作品页嗅探」兜底）。用法：tsx scripts/resolve-aweme.ts <aweme_id> [video|note] */
import { isLoggedIn, launchSession } from '../src/douyin/browser.js';
import { resolveAweme } from '../src/douyin/aweme.js';

async function main() {
  const [id, hint = 'video'] = process.argv.slice(2);
  if (!id) throw new Error('用法: tsx scripts/resolve-aweme.ts <aweme_id> [video|note]');
  const session = await launchSession({ headless: true });
  try {
    if (!(await isLoggedIn(session.context))) throw new Error('not logged in');
    const a = await resolveAweme(session.context, id, hint as 'video' | 'note', { waitMs: 0 });
    if (!a) return console.log('未解析到');
    console.log(JSON.stringify({ ...a, videoUrls: a.videoUrls.length, images: a.images.length, coverUrls: a.coverUrls.length }, null, 2));
  } finally {
    await session.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
