/**
 * tools.ts — the 13 Triage Agent tools as Strands tools.
 *
 * Every tool is a thin proxy: it forwards `{ tool, input }` to the existing
 * `agent-tools` Lambda (unchanged business logic, its own IAM role) and returns
 * the string body. This preserves the two-role split from architecture.md §1:
 * the agent runtime identity never touches AWS security services directly.
 *
 * Schemas mirror the `functionSchema` blocks that were in cdk/lib/agent-stack.ts.
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { z } from 'zod';
import * as strands from '@strands-agents/sdk';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const AGENT_TOOLS_FUNCTION = process.env.AGENT_TOOLS_FUNCTION_NAME ?? 'security-triage-agent-tools';

const lambda = new LambdaClient({ region: REGION });

async function callTool(tool: string, input: unknown): Promise<string> {
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: AGENT_TOOLS_FUNCTION,
      Payload: Buffer.from(JSON.stringify({ tool, input })),
    }),
  );
  if (res.FunctionError) {
    const raw = res.Payload ? Buffer.from(res.Payload).toString('utf-8') : '(no payload)';
    return `Tool ${tool} failed: ${raw}`;
  }
  const payload = res.Payload ? Buffer.from(res.Payload).toString('utf-8') : '{}';
  try {
    const parsed = JSON.parse(payload) as { body?: string };
    return parsed.body ?? payload;
  } catch {
    return payload;
  }
}

/** Build a Strands tool that proxies to the agent-tools Lambda by name. */
function proxyTool<T extends z.ZodType>(name: string, description: string, inputSchema: T) {
  return strands.tool({
    name,
    description,
    inputSchema,
    callback: (input: z.infer<T>) => callTool(name, input),
  });
}

export const tools = [
  proxyTool(
    'get_findings',
    'Retrieve active Security Hub findings. Call this when the analyst asks about security findings, alerts, or vulnerabilities.',
    z.object({
      severity: z
        .enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
        .optional()
        .describe('Filter by severity. Omit to return findings across all severities.'),
      max_results: z
        .number()
        .int()
        .optional()
        .describe('Maximum number of findings to return (default 10, max 50).'),
    }),
  ),
  proxyTool(
    'get_threat_context',
    'Retrieve GuardDuty threat findings. Use to enrich a Security Hub finding with threat intelligence for a specific resource.',
    z.object({
      resource_id: z
        .string()
        .optional()
        .describe('Resource ID or ARN to filter GuardDuty findings. Omit for all recent findings.'),
    }),
  ),
  proxyTool(
    'get_config_status',
    'Check AWS Config compliance status for a resource. Use to verify whether a resource meets compliance rules.',
    z.object({
      resource_id: z.string().describe('The resource ID or ARN to check compliance for.'),
      resource_type: z
        .string()
        .optional()
        .describe('AWS Config resource type, e.g. AWS::S3::Bucket. Optional — narrows results.'),
    }),
  ),
  proxyTool(
    'get_trail_events',
    'Look up recent CloudTrail API events for a resource or event type. Use to investigate recent changes or suspicious activity.',
    z.object({
      resource_name: z.string().optional().describe('Resource name or ARN to filter events.'),
      event_name: z.string().optional().describe('API event name, e.g. PutBucketLogging.'),
      start_time: z
        .string()
        .optional()
        .describe('ISO 8601 start time. Defaults to 24 hours ago.'),
    }),
  ),
  proxyTool(
    'get_tag_compliance',
    'Find resources missing required tags (Environment, Owner, Project). Returns each resource ARN, existing tags, and which required tags are absent.',
    z.object({
      resource_type: z
        .string()
        .optional()
        .describe('Filter by resource type in ResourceGroupsTaggingAPI format, e.g. s3, ec2:instance.'),
      max_results: z
        .number()
        .int()
        .optional()
        .describe('Maximum non-compliant resources to return (default 20, max 50).'),
    }),
  ),
  proxyTool(
    'get_enabled_standards',
    'List the Security Hub compliance standards currently enabled in this account. Always call this before get_compliance_report.',
    z.object({}),
  ),
  proxyTool(
    'get_compliance_report',
    'Generate a compliance posture report for a specific Security Hub standard. Use get_enabled_standards first to confirm the standard is enabled.',
    z.object({
      standard_name: z
        .string()
        .describe('Short name like "nist-800-53", "cis", "fsbp", or "pci". Partial matches supported.'),
    }),
  ),
  proxyTool(
    'get_iam_analysis',
    'Analyse the IAM security posture of the account. Use when the analyst asks about MFA, access keys, admin users, or overall IAM health.',
    z.object({
      query_type: z
        .enum(['summary', 'mfa_gaps', 'key_rotation', 'admin_users', 'credential_report'])
        .optional()
        .describe('Which IAM analysis to run. Defaults to summary.'),
    }),
  ),
  proxyTool(
    'get_access_analyzer',
    'List IAM Access Analyzer findings for resources accessible from outside the account. Use when the analyst asks about external exposure.',
    z.object({
      status: z.enum(['ACTIVE', 'ARCHIVED', 'RESOLVED']).optional().describe('Finding status filter. Default ACTIVE.'),
      resource_type: z
        .string()
        .optional()
        .describe('Filter by resource type, e.g. AWS::S3::Bucket, AWS::IAM::Role.'),
    }),
  ),
  proxyTool(
    'get_cost_analysis',
    'Analyse AWS costs and detect anomalies. Cost Explorer only reflects costs from the previous day onward — not real-time.',
    z.object({
      query_type: z.enum(['summary', 'tags', 'anomalies']).optional().describe('Defaults to summary.'),
      tag_key: z.string().optional().describe('Tag key to group/filter by. Required when query_type is "tags".'),
      tag_value: z.string().optional().describe('Tag value to filter costs by.'),
      start_date: z.string().optional().describe('YYYY-MM-DD. Defaults to 30 days ago.'),
      end_date: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
    }),
  ),
  proxyTool(
    'queue_task',
    'Queue a remediation task for analyst approval. Only use for enable_s3_logging or tag_resource. Always explain your rationale before calling this.',
    z.object({
      finding_id: z.string().describe('The Security Hub finding ID that triggered this task.'),
      resource_id: z.string().describe('The AWS resource ARN that will be remediated.'),
      action: z.enum(['enable_s3_logging', 'tag_resource']).describe('Remediation action.'),
      rationale: z.string().describe('Plain-English explanation of why this action is needed.'),
      action_params: z
        .string()
        .optional()
        .describe('Required for tag_resource: JSON object of tag key-value pairs to apply.'),
    }),
  ),
  proxyTool(
    'cancel_task',
    'Cancel a PENDING task that you queued in error. Only works on PENDING tasks.',
    z.object({
      task_id: z.string().describe('The task_id of the PENDING task to cancel.'),
      reason: z.string().describe('Brief explanation of why this task is being cancelled.'),
    }),
  ),
  proxyTool(
    'get_task_queue',
    'View remediation tasks in the queue. Use when the analyst asks what tasks are pending, approved, or completed.',
    z.object({
      status: z
        .enum(['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED'])
        .optional()
        .describe('Filter by task status. Defaults to PENDING.'),
    }),
  ),
];
