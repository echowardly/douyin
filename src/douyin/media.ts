import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BrowserContext } from 'playwright';
import { config } from '../config.js';
import type { ContentPart, LLMProvider } from '../providers/types.js';
import type { DouyinMessage, MediaRef } from './messages.js';

const run = promisify(execFile);

export interface SavedMedia {
  ref: MediaRef;
  /** 本地文件路径；视频分享卡片若只有作品页链接则可能为空 */
  file?: string;
  mime?: string;
}

/**
 * 用浏览器上下文（带登录 cookie）下载媒体。
 * TODO(probe): 视频分享卡片多半只给作品页链接，需要打开作品页并拦截
 * 视频流（page.on('response') 中 video/mp4）或从页面 JSON 中取 play_addr。
 */
export async function downloadMedia(context: BrowserContext, ref: MediaRef): Promise<SavedMedia> {
  const dir = path.join(config.dataDir, 'media');
  await fs.mkdir(dir, { recursive: true });
  if (ref.url.startsWith('blob:') || /douyin\.com\/(video|note)\//.test(ref.url)) {
    // TODO: 打开作品页解析真实资源地址
    return { ref };
  }
  const res = await context.request.get(ref.url, { headers: { referer: 'https://www.douyin.com/' } });
  if (!res.ok()) throw new Error(`下载失败 ${res.status()} ${ref.url}`);
  const mime = res.headers()['content-type'] ?? (ref.type === 'video' ? 'video/mp4' : 'image/jpeg');
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('video') ? 'mp4' : 'jpg';
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  await fs.writeFile(file, await res.body());
  return { ref, file, mime };
}

/** 用 ffmpeg 从视频中均匀抽取 N 帧（需要系统安装 ffmpeg/ffprobe）。 */
export async function extractVideoFrames(file: string, count = config.reply.videoFrameCount): Promise<string[]> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const duration = Math.max(Number(stdout.trim()) || 1, 0.5);
  const outDir = `${file}.frames`;
  await fs.mkdir(outDir, { recursive: true });
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = ((i + 0.5) * duration) / count;
    const out = path.join(outDir, `f${i}.jpg`);
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=768:-2', out]);
    frames.push(out);
  }
  return frames;
}

async function toDataUrl(file: string, mime = 'image/jpeg'): Promise<string> {
  return `data:${mime};base64,${(await fs.readFile(file)).toString('base64')}`;
}

/** 把一条消息里的媒体转换为多模态输入片段（图片 / 视频关键帧）。 */
export async function mediaToParts(context: BrowserContext, msg: DouyinMessage): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  for (const ref of msg.media) {
    try {
      const saved = await downloadMedia(context, ref);
      if (!saved.file) {
        parts.push({ type: 'text', text: `[${ref.type === 'video' ? '视频' : '图集'}分享：${ref.url}（尚未能解析出媒体文件）]` });
        continue;
      }
      if (ref.type === 'image') {
        parts.push({ type: 'image', url: await toDataUrl(saved.file, saved.mime) });
      } else {
        const frames = await extractVideoFrames(saved.file);
        parts.push({ type: 'text', text: `[视频关键帧 ×${frames.length}，按时间顺序]` });
        for (const f of frames) parts.push({ type: 'image', url: await toDataUrl(f), detail: 'low' });
        // TODO: 音轨转写（Whisper 等）可显著提升理解，后续接入
      }
    } catch (e) {
      parts.push({ type: 'text', text: `[媒体处理失败：${(e as Error).message}]` });
    }
  }
  return parts;
}

/** 让模型先单独描述媒体内容（可缓存、可记录），再交给回复生成。 */
export async function describeMedia(provider: LLMProvider, parts: ContentPart[], hint?: string): Promise<string> {
  if (!parts.some((p) => p.type === 'image')) return parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  return provider.chat(
    [
      { role: 'system', content: '你是内容理解助手。请用中文简洁客观地描述图片/视频关键帧的内容、人物、场景、文字（OCR）、情绪与看点，不超过 200 字。' },
      { role: 'user', content: [...(hint ? [{ type: 'text' as const, text: hint }] : []), ...parts] },
    ],
    { temperature: 0.2 },
  );
}
