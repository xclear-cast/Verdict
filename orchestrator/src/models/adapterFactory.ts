import type { ProviderAdapter } from "@agent-hub/shared";
import { AnthropicAdapter } from "./anthropicAdapter.js";
import { MockAdapter } from "./mockAdapter.js";
import { OpenAiCompatibleAdapter } from "./openAiCompatibleAdapter.js";

export class AdapterFactory {
  private readonly openAiCompatible: OpenAiCompatibleAdapter;
  private readonly anthropic: AnthropicAdapter;
  private readonly mock: MockAdapter;

  constructor(timeoutMs: number) {
    this.openAiCompatible = new OpenAiCompatibleAdapter(timeoutMs);
    this.anthropic = new AnthropicAdapter(timeoutMs);
    this.mock = new MockAdapter();
  }

  resolve(provider: string): ProviderAdapter {
    const normalized = provider.toLowerCase();
    if (normalized === "mock") return this.mock;
    if (normalized === "anthropic") return this.anthropic;
    if (
      normalized === "openai" ||
      normalized === "openai-compatible" ||
      normalized === "groq" ||
      normalized === "mistral" ||
      normalized === "deepseek" ||
      normalized === "xai"
    ) {
      return this.openAiCompatible;
    }
    return this.openAiCompatible;
  }
}
