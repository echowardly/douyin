/** 多模态消息内容片段（OpenAI chat/completions 风格，Grok 同样兼容）。 */
export type ContentPart =
  | { type: 'text'; text: string }
  /** url 可以是 https 链接或 data:image/...;base64,... */
  | { type: 'image'; url: string; detail?: 'low' | 'high' | 'auto' };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 覆盖默认模型 */
  model?: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  /** 发送一轮对话，返回助手文本。 */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
