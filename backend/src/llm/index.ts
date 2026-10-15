import type { Config } from '../config.js'
import { AnthropicClassifier } from './anthropic.js'
import { FakeClassifier } from './fake.js'
import { GeminiClassifier } from './gemini.js'
import { OllamaClassifier } from './ollama.js'
import type { LlmClassifier } from './types.js'

export type { LlmClassifier } from './types.js'

export function createClassifier(config: Config): LlmClassifier {
  switch (config.LLM_PROVIDER) {
    case 'anthropic':
      return new AnthropicClassifier({
        apiKey: config.ANTHROPIC_API_KEY ?? '',
        model: config.ANTHROPIC_MODEL,
        timeoutMs: config.LLM_TIMEOUT_MS,
      })
    case 'gemini':
      return new GeminiClassifier({
        apiKey: config.GEMINI_API_KEY ?? '',
        model: config.GEMINI_MODEL,
        timeoutMs: config.LLM_TIMEOUT_MS,
      })
    case 'ollama':
      return new OllamaClassifier(config.OLLAMA_URL, config.OLLAMA_MODEL, fetch, config.LLM_TIMEOUT_MS)
    case 'fake':
      return new FakeClassifier()
  }
}
