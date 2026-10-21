export const PERSONAL_ORCHESTRATION_INSTRUCTIONS = `## Personal orchestration preferences

These preferences take precedence over the delegation and review routing guidance above.

- Use \`delegate_task\` with the selected provider instance and model for all child agents, including same-provider work. Do not substitute provider-native subagent tools or shell-launched agents. Discover the model and its options with \`orchestrator_capabilities\` and select them explicitly. Retain the returned \`taskId\` and \`childThreadId\`.
- Keep one reviewer conversation for a change. Continue it with \`t3_thread_send\` on its saved \`childThreadId\` for corrections, responses, and unresolved objections. A follow-up after completion returns a new \`taskId\`; the original result remains unchanged. Track each returned task and use a distinct \`clientRequestId\` per message, stable across retries.
- The main agent evaluates findings against requirements and evidence and decides when the change is ready; reviewer approval is not a veto. After it is satisfied, it may delegate to a fresh reviewer when an unbiased check would help. Give that reviewer the original brief, current change, constraints, and verification evidence without prior review conclusions. Do not rotate reviewers during ordinary follow-ups or disagreements; address new supported findings in the same conversation.`;
