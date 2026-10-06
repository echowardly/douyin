import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { ProviderError } from '../providers/types.js';

const run = promisify(execFile);

export interface TranscriptResult {
  text: string;
  language?: string;
  durationSec?: number;
  /** 本地缓存的转写文本路径 */
  file?: string;
  /** 跳过原因（无音轨 / 无语音 / 未启用 / 失败） */
  skipped?: string;
}

const exists = (f: string) => fs.stat(f).then((s) => s.size > 0, () => false);

/** 探测视频是否有音频流；无则跳过。 */
export async function hasAudioStream(videoFile: string): Promise<boolean> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      videoFile,
    ]);
    return /audio/.test(stdout);
  } catch {
    return false;
  }
}

/**
 * 用 ffmpeg 抽出单声道 mp3（默认 16kHz / 64kbps）。
 * 已存在则复用；TRANSCRIBE_MAX_SECONDS>0 时截断。
 */
export async function extractAudioTrack(
  videoFile: string,
  destMp3?: string,
): Promise<{ file: string; skipped?: string }> {
  const out = destMp3 ?? `${videoFile.replace(/\.\w+$/, '')}.audio.mp3`;
  if (await exists(out)) return { file: out };
  if (!(await hasAudioStream(videoFile))) return { file: out, skipped: '视频无音轨' };

  const args = ['-y', '-v', 'error', '-i', videoFile];
  const maxSec = config.reply.transcribeMaxSeconds;
  if (maxSec > 0) args.push('-t', String(maxSec));
  args.push('-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', out);
  await run('ffmpeg', args);
  if (!(await exists(out))) return { file: out, skipped: '音轨抽取失败（空文件）' };
  return { file: out };
}

function resolveSttCreds():
  | { kind: 'grok'; apiKey: string; baseUrl: string; model: string }
  | { kind: 'openai'; apiKey: string; baseUrl: string; model: string }
  | null {
  const pref = config.reply.transcribeProvider;
  const grokKey = config.llm.grok.apiKey;
  const openaiKey = config.llm.openai.apiKey;
  const grok = grokKey
    ? {
        kind: 'grok' as const,
        apiKey: grokKey,
        baseUrl: config.llm.grok.baseUrl,
        model: config.reply.transcribeModel || 'grok-voice-transcribe-2.0',
      }
    : null;
  const openai = openaiKey
    ? {
        kind: 'openai' as const,
        apiKey: openaiKey,
        baseUrl: config.llm.openai.baseUrl,
        model: config.reply.transcribeModel || 'whisper-1',
      }
    : null;

  if (pref === 'grok') return grok;
  if (pref === 'openai') return openai;
  // auto：有 Grok key 优先（本项目默认 PROVIDER=grok），否则 OpenAI Whisper
  return grok ?? openai;
}

async function callGrokStt(
  apiKey: string,
  baseUrl: string,
  model: string,
  audioFile: string,
): Promise<{ text: string; language?: string; durationSec?: number }> {
  const buf = await fs.readFile(audioFile);
  const form = new FormData();
  form.append('model', model);
  const lang = config.reply.transcribeLanguage;
  if (lang) {
    form.append('language', lang);
    form.append('format', 'true');
  }
  // file 必须放在最后（xAI 文档要求）
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(audioFile));

  const url = `${baseUrl.replace(/\/+$/, '')}/stt`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(config.llm.timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new ProviderError(`grok-stt HTTP ${res.status}`, res.status, raw.slice(0, 2000));
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ProviderError('grok-stt 返回了非 JSON', res.status, raw.slice(0, 2000));
  }
  const text = typeof json?.text === 'string' ? json.text.trim() : '';
  return {
    text,
    language: typeof json?.language === 'string' ? json.language : undefined,
    durationSec: typeof json?.duration === 'number' ? json.duration : undefined,
  };
}

async function callOpenAiWhisper(
  apiKey: string,
  baseUrl: string,
  model: string,
  audioFile: string,
): Promise<{ text: string; language?: string; durationSec?: number }> {
  const buf = await fs.readFile(audioFile);
  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  const lang = config.reply.transcribeLanguage;
  if (lang) form.append('language', lang);
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(audioFile));

  const url = `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(config.llm.timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new ProviderError(`openai-whisper HTTP ${res.status}`, res.status, raw.slice(0, 2000));
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    // 某些代理只回纯文本
    return { text: raw.trim() };
  }
  const text = typeof json?.text === 'string' ? json.text.trim() : '';
  return {
    text,
    language: typeof json?.language === 'string' ? json.language : undefined,
    durationSec: typeof json?.duration === 'number' ? json.duration : undefined,
  };
}

/**
 * 视频 → 抽音轨 → Grok STT（优先）或 OpenAI Whisper 转写。
 * 结果缓存为 `<video>.transcript.txt`；无语音/失败时返回 skipped。
 */
export async function transcribeVideoAudio(videoFile: string): Promise<TranscriptResult> {
  if (!config.reply.transcribeEnabled) return { text: '', skipped: 'TRANSCRIBE_ENABLED=false' };

  const cacheTxt = `${videoFile.replace(/\.\w+$/, '')}.transcript.txt`;
  const cacheMeta = `${videoFile.replace(/\.\w+$/, '')}.transcript.json`;
  if (await exists(cacheTxt)) {
    const text = (await fs.readFile(cacheTxt, 'utf8')).trim();
    let meta: { language?: string; durationSec?: number; skipped?: string } = {};
    try {
      meta = JSON.parse(await fs.readFile(cacheMeta, 'utf8'));
    } catch {
      /* ignore */
    }
    if (meta.skipped) return { text: '', file: cacheTxt, skipped: meta.skipped, ...meta };
    return { text, file: cacheTxt, language: meta.language, durationSec: meta.durationSec };
  }

  const audio = await extractAudioTrack(videoFile);
  if (audio.skipped) {
    await fs.writeFile(cacheMeta, JSON.stringify({ skipped: audio.skipped }, null, 2));
    await fs.writeFile(cacheTxt, '');
    return { text: '', file: cacheTxt, skipped: audio.skipped };
  }

  const creds = resolveSttCreds();
  if (!creds) {
    const skipped = '未配置转写密钥（需 GROK_API_KEY 或 OPENAI_API_KEY）';
    await fs.writeFile(cacheMeta, JSON.stringify({ skipped }, null, 2));
    await fs.writeFile(cacheTxt, '');
    return { text: '', file: cacheTxt, skipped };
  }

  try {
    const result =
      creds.kind === 'grok'
        ? await callGrokStt(creds.apiKey, creds.baseUrl, creds.model, audio.file)
        : await callOpenAiWhisper(creds.apiKey, creds.baseUrl, creds.model, audio.file);

    const text = result.text.trim();
    if (!text || text.length < 2) {
      const skipped = '音轨无明显语音（可能仅 BGM）';
      await fs.writeFile(cacheMeta, JSON.stringify({ skipped, language: result.language, durationSec: result.durationSec }, null, 2));
      await fs.writeFile(cacheTxt, '');
      return { text: '', file: cacheTxt, skipped, language: result.language, durationSec: result.durationSec };
    }

    await fs.writeFile(cacheTxt, text);
    await fs.writeFile(
      cacheMeta,
      JSON.stringify(
        {
          provider: creds.kind,
          model: creds.model,
          language: result.language,
          durationSec: result.durationSec,
          chars: text.length,
        },
        null,
        2,
      ),
    );
    console.log(
      `[transcribe] ${creds.kind}/${creds.model} → ${text.length} 字` +
        (result.language ? `（${result.language}` : '') +
        (result.durationSec != null ? `${result.language ? ', ' : '（'}${result.durationSec}s` : '') +
        (result.language || result.durationSec != null ? '）' : '') +
        `：${text.replace(/\s+/g, ' ').slice(0, 80)}…`,
    );
    return { text, file: cacheTxt, language: result.language, durationSec: result.durationSec };
  } catch (e) {
    const skipped = `转写失败：${(e as Error).message}`;
    console.warn(`[transcribe] ${skipped}`);
    // 失败不写空缓存，下次可重试
    return { text: '', skipped };
  }
}

/** 截断过长转写，避免撑爆描述/回复 prompt。 */
export function clipTranscript(text: string, maxChars = 3000): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}…（转写过长已截断）`;
}
