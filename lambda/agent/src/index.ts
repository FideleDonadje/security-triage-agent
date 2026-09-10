/**
 * index.ts — HTTP entrypoint for AgentCore Runtime.
 *
 * AgentCore Runtime requires the container to expose exactly two endpoints:
 *   GET  /ping         → health check
 *   POST /invocations  → run the agent, return the reply
 *
 * The API Lambda (lambda/api/chat.ts) calls this via bedrock-agentcore
 * InvokeAgentRuntime; the request body is the analyst's message. Streaming and
 * session persistence are Phase 2 — see docs/agent-migration-plan.md.
 */
import express from 'express';
import { createAgent } from './agent.js';

const PORT = Number(process.env.PORT ?? 8080);

const app = express();

app.get('/ping', (_req, res) => {
  res.json({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) });
});

app.post('/invocations', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const prompt = Buffer.isBuffer(req.body)
    ? req.body.toString('utf-8').trim()
    : String(req.body ?? '').trim();

  if (!prompt) {
    res.status(400).json({ error: 'Empty prompt' });
    return;
  }

  try {
    const agent = createAgent();
    const result = await agent.invoke(prompt);
    const reply = result.toString().trim() || 'The agent returned an empty response.';
    res.json({ reply });
  } catch (err) {
    console.error('Agent invocation failed:', err);
    const message = err instanceof Error ? err.message : 'Agent error';
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`security-triage-agent listening on :${PORT}`);
});
