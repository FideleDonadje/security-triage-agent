import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import {
  BedrockAgentClient,
  PrepareAgentCommand,
  GetAgentCommand,
} from '@aws-sdk/client-bedrock-agent';

const client = new BedrockAgentClient({});

interface Props {
  agentId: string;
}

export async function handler(event: CloudFormationCustomResourceEvent) {
  console.log(JSON.stringify(event));

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: (event as unknown as { PhysicalResourceId: string }).PhysicalResourceId };
  }

  const { agentId } = event.ResourceProperties as unknown as Props;

  // Prepare the agent so the DRAFT reflects the latest configuration
  console.log(`Preparing agent ${agentId}`);
  await client.send(new PrepareAgentCommand({ agentId }));
  await waitUntilPrepared(agentId);
  console.log('Agent prepared successfully');

  return { PhysicalResourceId: `${agentId}-prepare` };
}

async function waitUntilPrepared(agentId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {          // up to 5 minutes
    await sleep(5_000);
    const { agent } = await client.send(new GetAgentCommand({ agentId }));
    const status = agent!.agentStatus!;
    console.log(`Agent status: ${status}`);
    if (status === 'PREPARED') return;
    if (status !== 'PREPARING') throw new Error(`Unexpected agent status: ${status}`);
  }
  throw new Error('Timed out waiting for agent PREPARED status');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
