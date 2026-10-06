import { config } from '../src/config.js';
import { isLoggedIn, launchSession } from '../src/douyin/browser.js';
import { listConversations, openConversation, readMessages } from '../src/douyin/messages.js';

async function main() {
  const session = await launchSession({ headless: true });
  try {
    if (!(await isLoggedIn(session.context))) throw new Error('not logged in');
    const convs = await listConversations(session.page);
    console.log('conversations:', convs);
    if (!convs.length) return;
    const target =
      convs.find((c) => config.douyin.ownerName && c.name.includes(config.douyin.ownerName.slice(0, 4))) ?? convs[0]!;
    await openConversation(session.page, target);
    const msgs = await readMessages(session.page, target);
    console.log(`messages (${msgs.length}):`);
    for (const m of msgs) {
      console.log(
        JSON.stringify({
          id: m.id,
          fromSelf: m.fromSelf,
          kind: m.kind,
          text: m.text?.slice(0, 80),
          media: m.media.map((x) => ({ type: x.type, url: x.url.slice(0, 80) })),
        }),
      );
    }
  } finally {
    await session.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
