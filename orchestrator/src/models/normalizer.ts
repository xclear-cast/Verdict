import { providerResponseSchema, type AdapterResponse, type AgentCallContext } from "@agent-hub/shared";

function extractJsonCandidate(raw: string): string {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return raw.slice(start, end + 1);
  }
  return raw.trim();
}

export function normalizeProviderPayload(rawText: string, context: AgentCallContext): AdapterResponse {
  const candidate = extractJsonCandidate(rawText);
  const parsed = JSON.parse(candidate);
  const normalized = providerResponseSchema.parse(parsed);

  const patchProposal = normalized.patchProposal
    ? {
        ...normalized.patchProposal,
        taskId: context.taskId
      }
    : undefined;

  return {
    message: normalized.message,
    verdict: normalized.verdict,
    risks: normalized.risks,
    focusContext: normalized.focusContext,
    patchProposal,
    rawText
  };
}
