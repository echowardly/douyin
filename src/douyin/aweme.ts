import type { BrowserContext, Page, Response } from 'playwright';

/**
 * 私信分享卡片 → 作品详情（真实视频 play_addr / 图集原图）。
 *
 * 2026-10-06 probe（data/probe/*-aweme）结论：
 * - 卡片 DOM 本身不带链接；React fiber 上 `props.message.parsedContent.itemId` 就是 aweme_id。
 * - 打开会话时，私信页自己会请求
 *   `www-hj.douyin.com/aweme/v1/web/multi/aweme/detail/?aweme_ids=[...]&origin_type=chat`
 *   （已带 a_bogus / msToken 签名），返回完整 aweme_details：
 *   视频 `video.bit_rate[].play_addr.url_list`（多码率 mp4/dash）、图集 `images[].url_list`。
 * - 直接拿签名 URL 用 context.request（带 cookie + referer）即可下载 mp4（206 video/mp4）。
 * 所以主路径是「被动嗅探」页面已有的接口响应。未命中时兜底：在已打开的 douyin.com 页面里
 * 直接 fetch `/aweme/v1/web/aweme/detail/?aweme_id=`——页面内的 bdms SDK 会自动补 a_bogus 签名
 * （作品页本身走 RSC `__pace_f` 内嵌数据，不会请求 detail 接口，所以不能只靠打开作品页嗅探）。
 */

export interface AwemeImage {
  urls: string[];
  width?: number;
  height?: number;
  /** 实况图（live photo）自带的短视频 */
  videoUrls?: string[];
}

export interface ResolvedAweme {
  id: string;
  kind: 'video' | 'album';
  desc: string;
  author?: string;
  durationMs?: number;
  coverUrls: string[];
  /** 视频候选地址，已按「体积小优先」排好（只用于理解，没必要拉 4K） */
  videoUrls: string[];
  videoBytes?: number;
  images: AwemeImage[];
  musicTitle?: string;
}

const DETAIL_RE = /\/aweme\/v1\/web\/(multi\/)?aweme\/detail\//;

const cache = new Map<string, ResolvedAweme>();
const filtered = new Map<string, number>();
const waiters = new Map<string, Array<(a: ResolvedAweme) => void>>();
const installed = new WeakSet<BrowserContext>();

type Json = Record<string, any>;

const urls = (x: Json | undefined): string[] => ((x?.url_list as string[] | undefined) ?? []).filter(Boolean);

export function normalizeAweme(a: Json): ResolvedAweme {
  const v: Json = a.video ?? {};
  const images: AwemeImage[] = ((a.images as Json[] | undefined) ?? []).map((im) => ({
    urls: urls(im),
    width: im.width,
    height: im.height,
    videoUrls: im.video ? urls(im.video.play_addr) : undefined,
  }));
  // 选码率：mp4、非 bytevc1 优先，体积从小到大；最后补 play_addr
  const rates = ((v.bit_rate as Json[] | undefined) ?? [])
    .filter((b) => (b.format ?? 'mp4') === 'mp4' && urls(b.play_addr).length)
    .sort((x, y) => (x.is_bytevc1 ?? 0) - (y.is_bytevc1 ?? 0) || (x.play_addr?.data_size ?? Infinity) - (y.play_addr?.data_size ?? Infinity));
  const videoUrls = images.length
    ? []
    : [...new Set([...rates.flatMap((b) => urls(b.play_addr)), ...urls(v.play_addr_h264), ...urls(v.play_addr)])].filter(
        (u) => !/\.mp3(\?|$)/.test(u),
      );
  return {
    id: String(a.aweme_id),
    kind: images.length ? 'album' : 'video',
    desc: String(a.desc ?? ''),
    author: a.author?.nickname,
    durationMs: v.duration || undefined,
    coverUrls: [...urls(v.cover), ...urls(v.origin_cover)],
    videoUrls,
    videoBytes: rates[0]?.play_addr?.data_size ?? v.play_addr?.data_size,
    images,
    musicTitle: a.music?.title,
  };
}

function ingest(body: Json): number {
  const list: Json[] = body.aweme_details ?? (body.aweme_detail ? [body.aweme_detail] : []);
  for (const a of list) {
    if (!a?.aweme_id) continue;
    const r = normalizeAweme(a);
    cache.set(r.id, r);
    waiters.get(r.id)?.forEach((fn) => fn(r));
    waiters.delete(r.id);
  }
  for (const f of (body.filter_list as Json[] | undefined) ?? []) if (f?.aweme_id) filtered.set(String(f.aweme_id), f.reason);
  return list.length;
}

async function onResponse(res: Response): Promise<void> {
  if (!DETAIL_RE.test(res.url()) || !res.ok()) return;
  try {
    const n = ingest(await res.json());
    if (n) console.log(`[aweme] 嗅探到作品详情 ×${n}（缓存 ${cache.size}）`);
  } catch {
    /* 非 JSON / 已被丢弃 */
  }
}

/** 在浏览器上下文上被动嗅探 aweme/detail 接口（所有页面）。launchSession 时调用一次即可。 */
export function installAwemeSniffer(context: BrowserContext): void {
  if (installed.has(context)) return;
  installed.add(context);
  context.on('response', (res) => void onResponse(res));
}

export function getCachedAweme(id: string): ResolvedAweme | undefined {
  return cache.get(id);
}

function waitFor(id: string, ms: number): Promise<ResolvedAweme | undefined> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      const list = waiters.get(id);
      if (list) waiters.set(id, list.filter((fn) => fn !== done));
      resolve(undefined);
    }, ms);
    const done = (a: ResolvedAweme) => {
      clearTimeout(t);
      resolve(a);
    };
    waiters.set(id, [...(waiters.get(id) ?? []), done]);
  });
}

/**
 * 解析作品：缓存（私信页嗅探）→ 短暂等待 → 兜底打开作品页嗅探。
 * @param hint 'video' | 'note'，决定兜底打开的作品页路径
 */
export async function resolveAweme(
  context: BrowserContext,
  id: string,
  hint: 'video' | 'note' = 'video',
  opts: { waitMs?: number; pageTimeoutMs?: number } = {},
): Promise<ResolvedAweme | undefined> {
  installAwemeSniffer(context);
  const quick = await waitFor(id, opts.waitMs ?? 1500);
  if (quick) return quick;
  if (filtered.has(id)) {
    console.warn(`[aweme] ${id} 被接口过滤（reason=${filtered.get(id)}，可能已删除/私密）`);
    return undefined;
  }
  // 兜底 1：在现有 douyin.com 页面里发签名请求（不导航，不影响私信页状态）
  const host = context.pages().find((p) => /^https:\/\/www\.douyin\.com\//.test(p.url()));
  if (host) {
    const r = await fetchDetailInPage(host, id);
    if (r) return r;
  }
  // 兜底 2：新开作品页（加载签名 SDK）后再请求
  const page = await context.newPage();
  try {
    console.log(`[aweme] 缓存未命中，打开作品页兜底：/${hint}/${id}`);
    await page.goto(`https://www.douyin.com/${hint}/${id}`, { waitUntil: 'domcontentloaded', timeout: opts.pageTimeoutMs ?? 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return (await fetchDetailInPage(page, id)) ?? cache.get(id);
  } finally {
    await page.close().catch(() => {});
  }
}

/** 在页面上下文里调用作品详情接口（复用页面 cookie 与 bdms 签名）。 */
async function fetchDetailInPage(page: Page, id: string): Promise<ResolvedAweme | undefined> {
  const url = `/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${id}&pc_client_type=1&version_code=170400&version_name=17.4.0`;
  try {
    // 字符串形式 evaluate：避免 tsx 注入 __name 到浏览器端
    const text = (await page.evaluate(
      `fetch(${JSON.stringify(url)}, { credentials: 'include' }).then((r) => r.ok ? r.text() : '')`,
    )) as string;
    if (text) ingest(JSON.parse(text));
  } catch (e) {
    console.warn(`[aweme] 页面内请求详情失败：${(e as Error).message}`);
  }
  return cache.get(id);
}

/** 测试/调试用：清空缓存，强制走兜底。 */
export function clearAwemeCache(): void {
  cache.clear();
  filtered.clear();
}
