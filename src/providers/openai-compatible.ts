import { ChatMessage, ChatOptions, ContentPart, LLMProvider, ProviderError } from './types.js';

export interface OpenAICompatibleOptions {
  name?: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

function toWire(content: string | ContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: p.url, detail: p.detail ?? 'auto' } },
  );
}

/** 任意兼容 OpenAI `/chat/completions` 的接口（OpenAI、代理、vLLM、OneAPI 等）。 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.name = opts.name ?? 'openai';
    this.model = opts.model;
  }

  async chat(messages: ChatMessage[], o: ChatOptions = {}): Promise<string> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
        ...this.opts.extraHeaders,
      },
      body: JSON.stringify({
        model: o.model ?? this.model,
        messages: messages.map((m) => ({ role: m.role, content: toWire(m.content) })),
        temperature: o.temperature ?? 0.7,
        ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 90_000),
    });
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`${this.name} HTTP ${res.status}`, res.status, text.slice(0, 2000));
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError(`${this.name} 返回了非 JSON 响应`, res.status, text.slice(0, 2000));
    }
    const out = json?.choices?.[0]?.message?.content;
    if (typeof out === 'string') return out.trim();
    if (Array.isArray(out)) return out.map((p: any) => p?.text ?? '').join('').trim();
    throw new ProviderError(`${this.name} 响应中没有 choices[0].message.content`, res.status, text.slice(0, 2000));
  }
}
