import type { AgentCallContext, AgentConfig, AgentMessage, Stage } from "@agent-hub/shared";

function stageIntent(stage: Stage): string {
  switch (stage) {
    case "discover":
      return "Collect only the minimal code context and identify the exact files needed.";
    case "plan":
      return "Produce a precise implementation approach, risks, and constraints.";
    case "patch":
      return "Provide safe code-edit operations. Prioritize find/replace and rewrite fallback.";
    case "verify":
      return "Analyze verification outcomes and provide only bug-fixing guidance.";
    case "finalize":
      return "Decide release readiness based on consensus and verification evidence.";
    default:
      return "Evaluate the current stage.";
  }
}

export function buildAgentMessages(agent: AgentConfig, context: AgentCallContext): AgentMessage[] {
  const recentTurns = context.recentTurns
    .slice(-8)
    .map(
      (turn) =>
        `[${turn.stage}][attempt:${turn.attempt}][round:${turn.round}] ${turn.agentId}/${turn.provider}: verdict=${turn.verdict}; message=${turn.message}`
    )
    .join("\n");

  const constraints = context.constraints.length
    ? context.constraints.map((constraint, index) => `${index + 1}. ${constraint}`).join("\n")
    : "none";

  const verificationContext = context.latestVerification
    ? JSON.stringify(context.latestVerification)
    : "none";
  const patchContext = context.latestPatchProposal ? JSON.stringify(context.latestPatchProposal) : "none";

  const finalRoundRule = context.criticalOnly
    ? "Final round mode: raise only critical functional bugs or security issues. Ignore style-only comments."
    : "Normal mode: identify important implementation and safety issues.";

  const systemPrompt = [
    `You are agent "${agent.id}" using role "${agent.role}".`,
    stageIntent(context.stage),
    finalRoundRule,
    "Output STRICT JSON object only, no markdown and no extra text.",
    "JSON shape:",
    `{"message":"string","verdict":"approve|revise|reject","risks":["string"],"focusContext":{"filePath":"string","startLine":1,"endLine":2},"patchProposal":{"taskId":"${context.taskId}","stage":"patch","summary":"string","unifiedDiff":"string","touchedFiles":["string"],"confidence":0.7,"editOperations":[{"op":"replace","path":"src/file.ts","find":"old","replace":"new"}]}}`,
    "If no focusContext, omit it.",
    "Include patchProposal only when the stage is patch, or stage is verify and a fix is required.",
    "When in verify stage, use verification stderr/stdout to create precise fixes."
  ].join("\n");

  const userPrompt = [
    `taskId: ${context.taskId}`,
    `workspacePath: ${context.workspacePath}`,
    `stage: ${context.stage}`,
    `attempt: ${context.attempt}`,
    `round: ${context.round}`,
    `userGoal: ${context.userGoal}`,
    "constraints:",
    constraints,
    "latestPatchProposal:",
    patchContext,
    "latestVerification:",
    verificationContext,
    "recentTurns:",
    recentTurns || "none"
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
}
