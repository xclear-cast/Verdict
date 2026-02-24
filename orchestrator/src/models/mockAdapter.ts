import type { AdapterResponse, AgentCallContext, AgentConfig, AgentMessage, ProviderAdapter } from "@agent-hub/shared";

export class MockAdapter implements ProviderAdapter {
  readonly providerName = "mock";

  async invoke(agent: AgentConfig, _messages: AgentMessage[], context: AgentCallContext): Promise<AdapterResponse> {
    const isDriver = agent.role === "driver";
    const shouldApprove = context.round >= 2;
    const verdict: AdapterResponse["verdict"] = shouldApprove ? "approve" : "revise";

    const patchProposal =
      isDriver && (context.stage === "patch" || (context.stage === "verify" && context.latestVerification && !context.latestVerification.passed))
        ? {
            taskId: context.taskId,
            stage: "patch" as const,
            summary: "Mock proposal",
            confidence: 0.62,
            touchedFiles: ["README.md"],
            unifiedDiff: undefined,
            editOperations: [
              {
                op: "append" as const,
                path: "README.md",
                content: `\n[Mock:${new Date().toISOString()}] ${context.userGoal}\n`
              }
            ]
          }
        : undefined;

    return {
      message: `${agent.id} (${agent.provider}) stage=${context.stage} round=${context.round}`,
      verdict,
      risks: shouldApprove ? [] : ["Need one more refinement pass."],
      focusContext: { filePath: "README.md", startLine: 1, endLine: 1 },
      patchProposal,
      rawText: JSON.stringify({
        message: `${agent.id} mock response`,
        verdict,
        risks: shouldApprove ? [] : ["Need one more refinement pass."]
      })
    };
  }
}
