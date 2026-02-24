import type { AgentCallContext, AgentConfig, AgentMessage, AdapterResponse, ProviderAdapter } from "@agent-hub/shared";
import { normalizeProviderPayload } from "./normalizer.js";

function resolveApiKey(agent: AgentConfig): string | undefined {
  if (agent.apiKeyEnv && process.env[agent.apiKeyEnv]) {
    return process.env[agent.apiKeyEnv];
  }
  return process.env.ANTHROPIC_API_KEY;
}

function toAnthropicMessages(messages: AgentMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    }));
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerName = "anthropic";

  constructor(private readonly timeoutMs: number) {}

  async invoke(agent: AgentConfig, messages: AgentMessage[], context: AgentCallContext): Promise<AdapterResponse> {
    const apiKey = resolveApiKey(agent);
    if (!apiKey) {
      throw new Error(`API_KEY_MISSING:${agent.id}`);
    }

    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const payload = {
      model: agent.model,
      max_tokens: agent.maxTokens ?? 1600,
      temperature: agent.temperature ?? 0.2,
      system,
      messages: toAnthropicMessages(messages)
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(agent.baseUrl ?? "https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`ANTHROPIC_ERROR:${response.status}:${body}`);
      }
      const json = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const rawText = (json.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");

      return normalizeProviderPayload(rawText, context);
    } finally {
      clearTimeout(timeout);
    }
  }
}
