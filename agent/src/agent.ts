/**
 * agent.ts — builds the Strands Triage Agent.
 *
 * One agent instance per invocation (see index.ts) so conversation state does
 * not leak between analyst sessions. Session persistence across HTTP calls is a
 * Phase 2 concern (AgentCore Memory) — see docs/agent-migration-plan.md.
 */
import { Agent, BedrockModel } from '@strands-agents/sdk';
import { SYSTEM_PROMPT } from './prompt.js';
import { tools } from './tools.js';

const MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const MODEL_REGION =
  process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

export function createAgent(): Agent {
  return new Agent({
    model: new BedrockModel({ modelId: MODEL_ID, region: MODEL_REGION }),
    systemPrompt: SYSTEM_PROMPT,
    tools,
    printer: false, // server context — no stdout streaming
  });
}
