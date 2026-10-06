import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BrowserContext } from 'playwright';
import { config } from '../config.js';
import type { ContentPart, LLMProvider } from '../providers/types.js';
import { resolveAweme, type ResolvedAweme } from './aweme.js';
import type { DouyinMessage, MediaRef } from './messages.js';
import { clipTranscript, transcribeVideoAudio } from './transcribe.js';

const run = promisify(execFile);
const REFERER = { referer: 'https://www.douyin.com/' };

export interface SavedMedia {
  ref: MediaRef;
  /** 本地文件路径；解析/下载失败时为空 */
  file?: string;
  mime?: string;
}

const mediaDir = () => path.join(config.dataDir, 'media');
const exists = (f: string) => fs.stat(f).then((s) => s.size > 0, () => false);
const extOf = (mime: string) =>
  mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('video') ? 'mp4' : 'jpg';

/**
 * 依次尝试候选地址（同一资源的多个 CDN），用带登录 cookie 的 context.request 下载。
 * @param dest 不带扩展名的目标路径；返回实际写入的文件
 */
async function fetchToFile(
  context: BrowserContext,
  candidates: string[],
  dest: string,
  opts: { maxBytes?: number; fallbackMime?: string; timeoutMs?: number } = {},
): Promise<{ file: string; mime: string }> {
  let lastErr = '无候选地址';
  for (const url of candidates) {
    try {
      const res = await context.request.get(url, { headers: REFERER, timeout: opts.timeoutMs ?? 120_000 });
      if (!res.ok()) {
        lastErr = `HTTP ${res.status()}`;
        continue;
      }
      const len = Number(res.headers()['content-length'] ?? 0);
      if (opts.maxBytes && len > opts.maxBytes) throw new Error(`体积 ${(len / 1e6).toFixed(1)}MB 超过上限`);
      const mime = (res.headers()['content-type'] ?? opts.fallbackMime ?? 'image/jpeg').split(';')[0]!.trim();
      const file = `${dest}.${extOf(mime)}`;
      await fs.writeFile(file, await res.body());
      return { file, mime };
    } catch (e) {
      lastErr = (e as Error).message;
      if (/超过上限/.test(lastErr)) break;
    }
  }
  throw new Error(`下载失败（${lastErr}）`);
}

/** 下载普通媒体（私信里直接发的图片/视频、封面等）。分享作品请走 resolveShare。 */
export async function downloadMedia(context: BrowserContext, ref: MediaRef): Promise<SavedMedia> {
  await fs.mkdir(mediaDir(), { recursive: true });
  if (ref.url.startsWith('blob:') || ref.url.startsWith('data:') || /douyin\.com\/(video|note)\//.test(ref.url)) {
    return { ref };
  }
  const dest = path.join(mediaDir(), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const { file, mime } = await fetchToFile(context, [ref.url], dest, {
    fallbackMime: ref.type === 'video' ? 'video/mp4' : 'image/jpeg',
  });
  return { ref, file, mime };
}

/** 用 ffmpeg 从视频中均匀抽取 N 帧（需要系统安装 ffmpeg/ffprobe）。已抽过则复用。 */
export async function extractVideoFrames(file: string, count = config.reply.videoFrameCount): Promise<string[]> {
  const outDir = `${file}.frames`;
  const cached = (await fs.readdir(outDir).catch(() => [] as string[])).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
  if (cached.length >= count) return cached.slice(0, count).map((f) => path.join(outDir, f));
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const duration = Math.max(Number(stdout.trim()) || 1, 0.5);
  await fs.mkdir(outDir, { recursive: true });
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = ((i + 0.5) * duration) / count;
    const out = path.join(outDir, `f${String(i).padStart(2, '0')}.jpg`);
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=768:-2', out]);
    frames.push(out);
  }
  return frames;
}

/** 统一转成长边 ≤1024 的 jpg（webp/超大图对多模态接口不友好）。失败时原样返回。 */
async function toModelJpeg(file: string): Promise<{ file: string; mime: string }> {
  // 小 jpg（如 ffmpeg 抽出的 768px 关键帧）直接用
  if (/\.jpe?g$/i.test(file) && (await fs.stat(file)).size < 1_500_000) return { file, mime: 'image/jpeg' };
  const out = file.replace(/\.\w+$/, '') + '.model.jpg';
  if (await exists(out)) return { file: out, mime: 'image/jpeg' };
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vf', "scale='min(1024,iw)':-2", '-q:v', '4', out]);
    return { file: out, mime: 'image/jpeg' };
  } catch {
    return { file, mime: file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
  }
}

async function toDataUrl(file: string, mime = 'image/jpeg'): Promise<string> {
  return `data:${mime};base64,${(await fs.readFile(file)).toString('base64')}`;
}

async function imagePart(file: string, detail?: 'low' | 'high' | 'auto'): Promise<ContentPart> {
  const j = await toModelJpeg(file);
  return { type: 'image', url: await toDataUrl(j.file, j.mime), ...(detail ? { detail } : {}) };
}

function shareHeader(a: ResolvedAweme): string {
  const meta =
    a.kind === 'video'
      ? `视频 ${a.durationMs ? Math.round(a.durationMs / 1000) + ' 秒' : ''}`
      : `图集 ${a.images.length} 张`;
  return `[分享作品 ${a.id}｜${meta.trim()}｜作者 @${a.author ?? '未知'}${a.musicTitle ? `｜配乐 ${a.musicTitle}` : ''}]\n作品文案：${a.desc || '(无)'}`;
}


/** 视频关键帧之后追加音轨转写文本片段（无语音则注明 skip）。 */
async function appendTranscriptParts(parts: ContentPart[], videoFile: string): Promise<void> {
  const tr = await transcribeVideoAudio(videoFile);
  if (tr.skipped) {
    parts.push({ type: 'text', text: `[音轨转写：跳过（${tr.skipped}）]` });
    return;
  }
  if (!tr.text) {
    parts.push({ type: 'text', text: '[音轨转写：空]' });
    return;
  }
  const clipped = clipTranscript(tr.text);
  const meta = [
    tr.language ? `语言 ${tr.language}` : '',
    tr.durationSec != null ? `${tr.durationSec}s` : '',
  ]
    .filter(Boolean)
    .join('，');
  parts.push({
    type: 'text',
    text: `[音轨转写${meta ? `｜${meta}` : ''}]\n${clipped}`,
  });
}

/**
 * 分享卡片 → 真实内容：视频下载最小码率 mp4 并抽关键帧；图集下载前 N 张原图。
 * 文件落在 data/media/aweme-<id>/，重复消息直接复用。
 */
async function shareToParts(context: BrowserContext, ref: MediaRef): Promise<ContentPart[]> {
  const id = ref.awemeId!;
  const a = await resolveAweme(context, id, ref.share === 'album' ? 'note' : 'video');
  if (!a) throw new Error(`作品 ${id} 未能解析出详情`);
  const dir = path.join(mediaDir(), `aweme-${id}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(a, null, 2));
  const parts: ContentPart[] = [{ type: 'text', text: shareHeader(a) }];

  if (a.kind === 'video') {
    let video = path.join(dir, 'video.mp4');
    if (!(await exists(video))) {
      const maxBytes = config.reply.videoMaxMb * 1e6;
      if (a.videoBytes && a.videoBytes > maxBytes) throw new Error(`视频最小码率也有 ${(a.videoBytes / 1e6).toFixed(1)}MB，超过 VIDEO_MAX_MB`);
      video = (await fetchToFile(context, a.videoUrls, path.join(dir, 'video'), { maxBytes, fallbackMime: 'video/mp4' })).file;
    }
    const frames = await extractVideoFrames(video);
    console.log(`[media] 作品 ${id}：真实视频 ${path.relative(process.cwd(), video)} → 关键帧 ×${frames.length}`);
    parts.push({ type: 'text', text: `[视频关键帧 ×${frames.length}，按时间顺序，取自原视频]` });
    for (const f of frames) parts.push(await imagePart(f, 'low'));
    await appendTranscriptParts(parts, video);
  } else {
    const picks = a.images.slice(0, config.reply.albumMaxImages);
    let ok = 0;
    for (const [i, im] of picks.entries()) {
      const base = path.join(dir, `img-${String(i + 1).padStart(2, '0')}`);
      const hit = (await fs.readdir(dir)).find((f) => f.startsWith(path.basename(base) + '.') && !f.includes('.model.'));
      try {
        const file = hit ? path.join(dir, hit) : (await fetchToFile(context, im.urls, base)).file;
        parts.push({ type: 'text', text: `[图集第 ${i + 1}/${a.images.length} 张]` });
        parts.push(await imagePart(file));
        ok++;
      } catch (e) {
        parts.push({ type: 'text', text: `[图集第 ${i + 1} 张下载失败：${(e as Error).message}]` });
      }
    }
    if (!ok) throw new Error('图集原图全部下载失败');
    console.log(`[media] 作品 ${id}：图集原图 ${ok}/${a.images.length} 张 → ${path.relative(process.cwd(), dir)}/`);
  }
  return parts;
}

/** 把一条消息里的媒体转换为多模态输入片段（图片 / 视频关键帧 / 图集原图）。 */
export async function mediaToParts(context: BrowserContext, msg: DouyinMessage): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  for (const ref of msg.media) {
    if (ref.share && ref.awemeId) {
      try {
        parts.push(...(await shareToParts(context, ref)));
        continue;
      } catch (e) {
        console.warn(`[media] 分享作品 ${ref.awemeId} 解析失败，退回封面：${(e as Error).message}`);
        parts.push({ type: 'text', text: `[分享${ref.share === 'album' ? '图集' : '视频'}：未能获取原内容（${(e as Error).message}），以下仅为封面]` });
        if (!ref.cover || ref.cover.startsWith('data:')) continue;
        ref.url = ref.cover;
        ref.type = 'image';
      }
    }
    try {
      const saved = await downloadMedia(context, ref);
      if (!saved.file) {
        parts.push({ type: 'text', text: `[${ref.type === 'video' ? '视频' : '图片'}：${ref.url}（未能解析出媒体文件）]` });
        continue;
      }
      if (ref.type === 'image') {
        parts.push(await imagePart(saved.file));
      } else {
        const frames = await extractVideoFrames(saved.file);
        parts.push({ type: 'text', text: `[视频关键帧 ×${frames.length}，按时间顺序]` });
        for (const f of frames) parts.push(await imagePart(f, 'low'));
        await appendTranscriptParts(parts, saved.file);
      }
    } catch (e) {
      parts.push({ type: 'text', text: `[媒体处理失败：${(e as Error).message}]` });
    }
  }
  return parts;
}

/** 让模型先单独描述媒体内容（可缓存、可记录），再交给回复生成。 */
export async function describeMedia(provider: LLMProvider, parts: ContentPart[], hint?: string): Promise<string> {
  const images = parts.filter((p) => p.type === 'image').length;
  const text = parts.map((p) => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
  if (!images) return text;
  const tags = parts.flatMap((p) => (p.type === 'text' ? (p.text.match(/^\[(视频关键帧[^\]]*|图集第[^\]]*|分享作品[^｜\]]*|音轨转写[^\]]*)/) ?? []).slice(1) : []));
  const hasTranscript = parts.some((p) => p.type === 'text' && p.text.startsWith('[音轨转写'));
  console.log(`[describe] 图片输入 ×${images}${hasTranscript ? ' + 音轨转写' : ''}（${[...new Set(tags.map((t) => t.replace(/第 \d+\/(\d+) 张/, '共 $1 张')))].join('；') || '普通图片'}）`);
  const desc = await provider.chat(
    [
      {
        role: 'system',
        content:
          '你是内容理解助手。输入可能是抖音分享作品的文案 + 视频关键帧（按时间顺序）或图集原图，以及「音轨转写」里的旁白/对白原文。请用中文简洁客观地描述内容、主题、人物、场景、画面文字（OCR 要点）、台词要点、情绪与看点，不超过 280 字；有转写时优先引用关键对白，不要编造转写里没有的话。',
      },
      { role: 'user', content: [...(hint ? [{ type: 'text' as const, text: hint }] : []), ...parts] },
    ],
    { temperature: 0.2 },
  );
  console.log(`[describe] → ${desc.replace(/\s+/g, ' ').slice(0, 160)}…`);
  return desc;
}
