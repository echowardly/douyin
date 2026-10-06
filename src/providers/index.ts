import { config } from '../config.js';
import { GrokProvider } from './grok.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { LLMProvider } from './types.js';

export * from './types.js';
export { GrokProvider, OpenAICompatibleProvider };

export function createProvider(kind: 'grok' | 'openai' = config.llm.provider): LLMProvider {
  const { timeoutMs } = config.llm;
  if (kind === 'grok') {
    const c = config.llm.grok;
    if (!c.apiKey) throw new Error('PROVIDER=grok 但未设置 GROK_API_KEY');
    return new GrokProvider({ apiKey: c.apiKey, baseUrl: c.baseUrl, model: c.model, timeoutMs });
  }
  const c = config.llm.openai;
  if (!c.apiKey) throw new Error('PROVIDER=openai 但未设置 OPENAI_API_KEY');
  return new OpenAICompatibleProvider({ name: 'openai', apiKey: c.apiKey, baseUrl: c.baseUrl, model: c.model, timeoutMs });
}
