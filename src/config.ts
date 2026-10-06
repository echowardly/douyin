import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const emptyToUndef = (v: unknown) => (v === '' ? undefined : v);

const EnvSchema = z.object({
  DOUYIN_TARGET_USERS: z.string().default('self'),
  DOUYIN_OWNER_NAME: z.preprocess(emptyToUndef, z.string().optional()),
  DOUYIN_CHAT_URL: z.string().url().default('https://www.douyin.com/chat'),
  DOUYIN_PROFILE_DIR: z.string().default('.douyin-profile'),
  HEADLESS: bool,
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  DRY_RUN: bool,
  DATA_DIR: z.string().default('data'),

  PROVIDER: z.enum(['grok', 'openai']).default('grok'),
  GROK_API_KEY: z.preprocess(emptyToUndef, z.string().optional()),
  GROK_BASE_URL: z.string().url().default('https://api.x.ai/v1'),
  GROK_MODEL: z.string().default('grok-4'),
  OPENAI_API_KEY: z.preprocess(emptyToUndef, z.string().optional()),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o'),

  REPLY_SYSTEM_PROMPT: z.preprocess(emptyToUndef, z.string().optional()),
  VIDEO_FRAME_COUNT: z.coerce.number().int().min(1).max(32).default(6),
  ALBUM_MAX_IMAGES: z.coerce.number().int().min(1).max(35).default(9),
  VIDEO_MAX_MB: z.coerce.number().positive().default(80),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
});

const env = EnvSchema.parse(process.env);

export const config = {
  douyin: {
    targetUsers: env.DOUYIN_TARGET_USERS.split(',').map((s) => s.trim()).filter(Boolean),
    ownerName: env.DOUYIN_OWNER_NAME,
    chatUrl: env.DOUYIN_CHAT_URL,
    profileDir: path.resolve(env.DOUYIN_PROFILE_DIR),
    headless: env.HEADLESS ?? false,
    pollIntervalMs: env.POLL_INTERVAL_MS,
  },
  dryRun: env.DRY_RUN ?? true,
  dataDir: path.resolve(env.DATA_DIR),
  llm: {
    provider: env.PROVIDER,
    grok: { apiKey: env.GROK_API_KEY, baseUrl: env.GROK_BASE_URL, model: env.GROK_MODEL },
    openai: { apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, model: env.OPENAI_MODEL },
    timeoutMs: env.LLM_TIMEOUT_MS,
  },
  reply: {
    systemPrompt: env.REPLY_SYSTEM_PROMPT,
    videoFrameCount: env.VIDEO_FRAME_COUNT,
    /** 图集最多取几张原图喂给多模态模型 */
    albumMaxImages: env.ALBUM_MAX_IMAGES,
    /** 分享视频下载体积上限（MB），超出则只用封面 */
    videoMaxMb: env.VIDEO_MAX_MB,
  },
} as const;

export type AppConfig = typeof config;

/** 把 "self" 解析成主人昵称；其余原样返回。 */
export function resolvedTargets(): string[] {
  return config.douyin.targetUsers.flatMap((t) =>
    t.toLowerCase() === 'self' ? (config.douyin.ownerName ? [config.douyin.ownerName] : []) : [t],
  );
}
