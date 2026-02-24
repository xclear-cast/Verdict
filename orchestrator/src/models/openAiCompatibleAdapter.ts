import type { AgentCallContext, AgentConfig, AgentMessage, AdapterResponse, ProviderAdapter } from "@agent-hub/shared";
import { normalizeProviderPayload } from "./normalizer.js";

function resolveApiKey(agent: AgentConfig): string | undefined {
  if (agent.apiKeyEnv && process.env[agent.apiKeyEnv]) {
    return process.env[agent.apiKeyEnv];
  }
  if (agent.provider.toLowerCase() === "gemini") {
    return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  }
  return process.env.OPENAI_API_KEY;
}

function resolveBaseUrl(agent: AgentConfig): string {
  if (agent.baseUrl) return agent.baseUrl;
  if (agent.provider.toLowerCase() === "gemini") {
    return "https://generativelanguage.googleapis.com/v1beta/openai";
  }
  return "https://api.openai.com/v1";
}

function normalizeContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly providerName = "openai-compatible";

  constructor(private readonly timeoutMs: number) {}

  async invoke(agent: AgentConfig, messages: AgentMessage[], context: AgentCallContext): Promise<AdapterResponse> {
    const apiKey = resolveApiKey(agent);
    if (!apiKey) {
      throw new Error(`API_KEY_MISSING:${agent.id}`);
    }

    const url = `${resolveBaseUrl(agent)}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: agent.model,
          messages,
          temperature: agent.temperature ?? 0.2,
          max_tokens: agent.maxTokens ?? 1600,
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OPENAI_COMPATIBLE_ERROR:${response.status}:${body}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: unknown;
          };
        }>;
      };
      const rawText = normalizeContent(payload.choices?.[0]?.message?.content);
      return normalizeProviderPayload(rawText, context);
    } finally {
      clearTimeout(timeout);
    }
  }
}
