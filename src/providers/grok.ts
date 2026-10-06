import { OpenAICompatibleProvider } from './openai-compatible.js';

export interface GrokOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * xAI Grok。官方 API (https://api.x.ai/v1) 兼容 OpenAI chat/completions 协议，
 * 支持 image_url 图片输入。视频需先抽帧（见 douyin/media.ts）。
 * 单独成类，便于以后接入 Grok 专有能力（如 Live Search、原生视频理解）。
 */
export class GrokProvider extends OpenAICompatibleProvider {
  constructor(o: GrokOptions) {
    super({
      name: 'grok',
      apiKey: o.apiKey,
      baseUrl: o.baseUrl ?? 'https://api.x.ai/v1',
      model: o.model ?? 'grok-4',
      timeoutMs: o.timeoutMs,
    });
  }
}
