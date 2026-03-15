import {
  SecurityHubClient,
  GetFindingsCommand,
  GetEnabledStandardsCommand,
  DescribeStandardsCommand,
  DescribeStandardsControlsCommand,
} from '@aws-sdk/client-securityhub';
import {
  GuardDutyClient,
  ListDetectorsCommand,
  ListFindingsCommand,
  GetFindingsCommand as GDGetFindingsCommand,
} from '@aws-sdk/client-guardduty';
import {
  ConfigServiceClient,
  DescribeComplianceByResourceCommand,
} from '@aws-sdk/client-config-service';
import { CloudTrailClient, LookupEventsCommand, LookupAttributeKey } from '@aws-sdk/client-cloudtrail';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomUUID } from 'crypto';

// ── AWS Clients ──────────────────────────────────────────────────────────────

const REGION = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const securityHub = new SecurityHubClient({ region: REGION });
const guardDuty = new GuardDutyClient({ region: REGION });
const configService = new ConfigServiceClient({ region: REGION });
const cloudTrail = new CloudTrailClient({ region: REGION });
const tagging = new ResourceGroupsTaggingAPIClient({ region: REGION });
const ssmClient = new SSMClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

const TABLE = process.env.TABLE_NAME!;
const STATUS_INDEX = process.env.STATUS_INDEX_NAME ?? 'status-index';
const REQUIRED_TAG_KEYS_PARAM = process.env.REQUIRED_TAG_KEYS_PARAM ?? '/security-triage/required-tag-keys';

// Cache required tag keys for the lifetime of the Lambda container
let cachedRequiredTagKeys: string[] | undefined;

async function getRequiredTagKeys(): Promise<string[]> {
  if (cachedRequiredTagKeys) return cachedRequiredTagKeys;
  const result = await ssmClient.send(new GetParameterCommand({ Name: REQUIRED_TAG_KEYS_PARAM }));
  const value = result.Parameter?.Value ?? '["Environment","Owner","Project"]';
  cachedRequiredTagKeys = JSON.parse(value) as string[];
  return cachedRequiredTagKeys;
}

// ── Bedrock action group event types ─────────────────────────────────────────

interface BedrockParameter {
  name: string;
  type: string;
  value: string;
}

interface BedrockAgentEvent {
  messageVersion: string;
  agent: Record<string, unknown>;
  sessionId: string;
  actionGroup: string;
  function: string;
  parameters?: BedrockParameter[];
}

interface BedrockAgentResponse {
  messageVersion: string;
  response: {
    actionGroup: string;
    function: string;
    functionResponse: {
      responseBody: {
        TEXT: { body: string };
      };
    };
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event: BedrockAgentEvent): Promise<BedrockAgentResponse> => {
  const params = parseParams(event.parameters ?? []);

  let resultText: string;
  try {
    switch (event.function) {
      case 'get_findings':
        resultText = await getFindings(params);
        break;
      case 'get_threat_context':
        resultText = await getThreatContext(params);
        break;
      case 'get_config_status':
        resultText = await getConfigStatus(params);
        break;
      case 'get_trail_events':
        resultText = await getTrailEvents(params);
        break;
      case 'queue_task':
        resultText = await queueTask(params);
        break;
      case 'cancel_task':
        resultText = await cancelTask(params);
        break;
      case 'get_tag_compliance':
        resultText = await getTagCompliance(params);
        break;
      case 'get_enabled_standards':
        resultText = await getEnabledStandards();
        break;
      case 'get_compliance_report':
        resultText = await getComplianceReport(params);
        break;
      case 'get_task_queue':
        resultText = await getTaskQueue(params);
        break;
      default:
        resultText = `Unknown function: ${event.function}`;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Tool ${event.function} failed:`, e);
    resultText = `Error executing ${event.function}: ${msg}`;
  }

  return {
    messageVersion: '1.0',
    response: {
      actionGroup: event.actionGroup,
      function: event.function,
      functionResponse: {
        responseBody: {
          TEXT: { body: resultText },
        },
      },
    },
  };
};

// ── Tool: get_findings ────────────────────────────────────────────────────────

async function getFindings(params: Record<string, string>): Promise<string> {
  const severity = params.severity?.toUpperCase();
  const maxResults = Math.min(Math.max(parseInt(params.max_results ?? '10', 10) || 10, 1), 50);

  const filters: Record<string, unknown> = {
    RecordState: [{ Value: 'ACTIVE', Comparison: 'EQUALS' }],
    WorkflowStatus: [
      { Value: 'NEW', Comparison: 'EQUALS' },
      { Value: 'NOTIFIED', Comparison: 'EQUALS' },
    ],
  };

  const severityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'];
  if (severity && severityOrder.includes(severity)) {
    filters.SeverityLabel = [{ Value: severity, Comparison: 'EQUALS' }];
  }

  const result = await securityHub.send(
    new GetFindingsCommand({
      Filters: filters,
      MaxResults: maxResults,
      SortCriteria: [{ Field: 'SeverityLabel', SortOrder: 'asc' }],
    }),
  );

  const findings = result.Findings ?? [];
  if (findings.length === 0) {
    return severity
      ? `No active ${severity} findings found.`
      : 'No active Security Hub findings found.';
  }

  const summary = findings.map((f) => ({
    id: f.Id,
    title: f.Title,
    severity: f.Severity?.Label,
    resource: f.Resources?.[0]?.Id ?? 'unknown',
    resourceType: f.Resources?.[0]?.Type ?? 'unknown',
    description: f.Description,
    updatedAt: f.UpdatedAt,
  }));

  return JSON.stringify({ count: findings.length, findings: summary }, null, 2);
}

// ── Tool: get_threat_context ──────────────────────────────────────────────────

async function getThreatContext(params: Record<string, string>): Promise<string> {
  // Get detector IDs
  const detectorsResult = await guardDuty.send(new ListDetectorsCommand({}));
  const detectorIds = detectorsResult.DetectorIds ?? [];

  if (detectorIds.length === 0) {
    return 'GuardDuty is not enabled in this region.';
  }

  const allFindings: unknown[] = [];

  for (const detectorId of detectorIds) {
    const listFilters: Record<string, unknown> = {};
    if (params.resource_id) {
      listFilters.Criterion = {
        'resource.instanceDetails.instanceId': { Eq: [params.resource_id] },
      };
    }

    const listResult = await guardDuty.send(
      new ListFindingsCommand({
        DetectorId: detectorId,
        FindingCriteria: Object.keys(listFilters).length > 0 ? listFilters : undefined,
        MaxResults: 20,
      }),
    );

    const findingIds = listResult.FindingIds ?? [];
    if (findingIds.length === 0) continue;

    const getResult = await guardDuty.send(
      new GDGetFindingsCommand({
        DetectorId: detectorId,
        FindingIds: findingIds.slice(0, 10),
      }),
    );

    for (const f of getResult.Findings ?? []) {
      allFindings.push({
        id: f.Id,
        type: f.Type,
        severity: f.Severity,
        title: f.Title,
        description: f.Description,
        resourceType: f.Resource?.ResourceType,
        updatedAt: f.UpdatedAt,
      });
    }
  }

  if (allFindings.length === 0) {
    return params.resource_id
      ? `No GuardDuty findings found for resource: ${params.resource_id}`
      : 'No GuardDuty findings found.';
  }

  return JSON.stringify({ count: allFindings.length, findings: allFindings }, null, 2);
}

// ── Tool: get_config_status ───────────────────────────────────────────────────

async function getConfigStatus(params: Record<string, string>): Promise<string> {
  if (!params.resource_id) {
    return 'Error: resource_id is required for get_config_status';
  }

  const result = await configService.send(
    new DescribeComplianceByResourceCommand({
      ResourceId: params.resource_id,
      ResourceType: params.resource_type,
      ComplianceTypes: ['COMPLIANT', 'NON_COMPLIANT', 'NOT_APPLICABLE', 'INSUFFICIENT_DATA'],
    }),
  );

  const items = result.ComplianceByResources ?? [];
  if (items.length === 0) {
    return `No Config compliance data found for resource: ${params.resource_id}`;
  }

  const summary = items.map((item) => ({
    resourceType: item.ResourceType,
    resourceId: item.ResourceId,
    compliance: item.Compliance?.ComplianceType,
  }));

  return JSON.stringify({ count: items.length, resources: summary }, null, 2);
}

// ── Tool: get_trail_events ─────────────────────────────────────────────────────

async function getTrailEvents(params: Record<string, string>): Promise<string> {
  const lookupAttributes = [];

  if (params.resource_name) {
    lookupAttributes.push({ AttributeKey: LookupAttributeKey.RESOURCE_NAME, AttributeValue: params.resource_name });
  }
  if (params.event_name) {
    lookupAttributes.push({ AttributeKey: LookupAttributeKey.EVENT_NAME, AttributeValue: params.event_name });
  }

  let startTime: Date;
  if (params.start_time) {
    const parsed = new Date(params.start_time);
    if (isNaN(parsed.getTime())) return 'Error: start_time is not a valid ISO 8601 date';
    startTime = parsed;
  } else {
    startTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24 hours by default
  }

  const result = await cloudTrail.send(
    new LookupEventsCommand({
      LookupAttributes: lookupAttributes.length > 0 ? lookupAttributes : undefined,
      StartTime: startTime,
      EndTime: new Date(),
      MaxResults: 25,
    }),
  );

  const events = result.Events ?? [];
  if (events.length === 0) {
    return 'No CloudTrail events found matching the criteria.';
  }

  const summary = events.map((e) => ({
    eventName: e.EventName,
    eventTime: e.EventTime,
    username: e.Username,
    sourceIp: (() => {
      try { return e.CloudTrailEvent ? JSON.parse(e.CloudTrailEvent).sourceIPAddress : undefined; }
      catch { return undefined; }
    })(),
    resources: e.Resources?.map((r) => ({ type: r.ResourceType, name: r.ResourceName })),
  }));

  return JSON.stringify({ count: events.length, events: summary }, null, 2);
}

// ── Tool: get_tag_compliance ──────────────────────────────────────────────────

// Resource types the execution Lambda is permitted to tag.
// Excludes CDK-managed infra (CloudFormation, Cognito, API Gateway, Bedrock, IAM)
// because those are owned by CDK and should not be modified by the agent.
const TAGGABLE_RESOURCE_TYPES = [
  's3',                  // S3 buckets
  'lambda:function',     // Lambda functions
  'ec2:instance',        // EC2 instances
  'ec2:security-group',  // Security groups
  'ec2:vpc',             // VPCs
  'ec2:subnet',          // Subnets
  'rds:db',              // RDS instances
  'rds:cluster',         // Aurora clusters
  'dynamodb:table',      // DynamoDB tables (excluding this project's own table is impractical, fine to include)
];

async function getTagCompliance(params: Record<string, string>): Promise<string> {
  const requiredKeys = await getRequiredTagKeys();
  const maxResults = Math.min(Math.max(parseInt(params.max_results ?? '20', 10) || 20, 1), 50);

  // If the caller requests a specific type, validate it is in the allowlist
  const requestedType = params.resource_type;
  const resourceTypeFilters = requestedType
    ? (TAGGABLE_RESOURCE_TYPES.includes(requestedType) ? [requestedType] : null)
    : TAGGABLE_RESOURCE_TYPES;

  if (resourceTypeFilters === null) {
    return `Error: resource_type '${requestedType}' is not supported. Supported types: ${TAGGABLE_RESOURCE_TYPES.join(', ')}`;
  }

  // Paginate up to 100 resources to find non-compliant ones
  const result = await tagging.send(
    new GetResourcesCommand({
      ResourcesPerPage: 100,
      ResourceTypeFilters: resourceTypeFilters,
    }),
  );

  const resources = result.ResourceTagMappingList ?? [];

  // Find resources missing one or more required tags
  const nonCompliant = resources
    .map((r) => {
      const existingTagKeys = new Set((r.Tags ?? []).map((t) => t.Key));
      const missingKeys = requiredKeys.filter((k) => !existingTagKeys.has(k));
      return {
        arn: r.ResourceARN,
        existingTags: Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
        missingTagKeys: missingKeys,
      };
    })
    .filter((r) => r.missingTagKeys.length > 0)
    .slice(0, maxResults);

  if (nonCompliant.length === 0) {
    return `All checked resources have the required tags: ${requiredKeys.join(', ')}`;
  }

  return JSON.stringify(
    {
      requiredTagKeys: requiredKeys,
      nonCompliantCount: nonCompliant.length,
      note: 'Use existingTags on sibling resources to infer correct values before calling queue_task.',
      resources: nonCompliant,
    },
    null,
    2,
  );
}

// ── Tool: queue_task ──────────────────────────────────────────────────────────

const VALID_ACTIONS = ['enable_s3_logging', 'tag_resource'] as const;

async function queueTask(params: Record<string, string>): Promise<string> {
  const { finding_id, resource_id, action, rationale, action_params } = params;

  if (!finding_id) return 'Error: finding_id is required';
  if (!resource_id) return 'Error: resource_id is required';
  if (!action) return 'Error: action is required';
  if (!rationale) return 'Error: rationale is required';
  if (!VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
    return `Error: action must be one of: ${VALID_ACTIONS.join(', ')}`;
  }
  if (action === 'tag_resource') {
    if (!action_params) return 'Error: action_params is required for tag_resource';
    try {
      const parsed = JSON.parse(action_params);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'Error: action_params must be a JSON object of tag key-value pairs';
      }
    } catch {
      return 'Error: action_params must be valid JSON';
    }
  }

  const taskId = randomUUID();
  const now = new Date().toISOString();

  const item: Record<string, unknown> = {
    task_id: taskId,
    status: 'PENDING',
    finding_id,
    resource_id,
    action,
    rationale,
    risk_tier: 1,
    created_at: now,
    approved_at: null,
    approved_by: null,
    executed_at: null,
    result: null,
  };
  if (action_params) item.action_params = action_params;

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(task_id)', // prevent accidental overwrite
    }),
  );

  return JSON.stringify({
    task_id: taskId,
    status: 'PENDING',
    message: `Task queued successfully. An analyst must approve before execution.`,
    action,
    resource_id,
    finding_id,
  });
}

// ── Tool: cancel_task ────────────────────────────────────────────────────────

async function cancelTask(params: Record<string, string>): Promise<string> {
  const { task_id, reason } = params;

  if (!task_id) return 'Error: task_id is required';
  if (!reason)  return 'Error: reason is required';

  // Verify the task exists and was queued by the agent (not a chat record)
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { task_id } }));
  if (!existing.Item) return `Error: task '${task_id}' not found`;
  if (existing.Item.status !== 'PENDING') {
    return `Error: cannot cancel task with status '${existing.Item.status}' — only PENDING tasks can be cancelled`;
  }

  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { task_id },
      ConditionExpression: '#s = :pending',
      UpdateExpression: 'SET #s = :cancelled, cancelled_reason = :reason, cancelled_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':pending':   'PENDING',
        ':cancelled': 'CANCELLED',
        ':reason':    reason,
        ':now':       new Date().toISOString(),
      },
    }));
  } catch (e: unknown) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') {
      return `Error: task '${task_id}' was already actioned (race condition)`;
    }
    throw e;
  }

  return JSON.stringify({ task_id, status: 'CANCELLED', reason, message: 'Task cancelled successfully.' });
}

// ── Tool: get_enabled_standards ───────────────────────────────────────────────

function extractStandardSlug(arn: string): string {
  const match = arn.match(/standards\/([^:]+)/);
  return match ? match[1] : arn;
}

async function getEnabledStandards(): Promise<string> {
  const [enabledResult, allResult] = await Promise.all([
    securityHub.send(new GetEnabledStandardsCommand({})),
    securityHub.send(new DescribeStandardsCommand({})),
  ]);

  const subscriptions = enabledResult.StandardsSubscriptions ?? [];
  if (subscriptions.length === 0) {
    return 'No Security Hub compliance standards are currently enabled. Go to Security Hub → Security standards to enable them.';
  }

  const nameMap = new Map((allResult.Standards ?? []).map((s) => [s.StandardsArn, s.Name]));

  const standards = subscriptions.map((s) => ({
    name: nameMap.get(s.StandardsArn ?? '') ?? extractStandardSlug(s.StandardsArn ?? ''),
    slug: extractStandardSlug(s.StandardsArn ?? ''),
    status: s.StandardsStatus,
    standardsArn: s.StandardsArn,
    subscriptionArn: s.StandardsSubscriptionArn,
  }));

  return JSON.stringify({ count: standards.length, standards }, null, 2);
}

// ── Tool: get_compliance_report ───────────────────────────────────────────────

async function getComplianceReport(params: Record<string, string>): Promise<string> {
  const query = (params.standard_name ?? '').toLowerCase();
  if (!query) return 'Error: standard_name is required (e.g. "nist-800-53", "cis", "fsbp", "pci")';

  // Resolve enabled standards and match the requested one
  const [enabledResult, allResult] = await Promise.all([
    securityHub.send(new GetEnabledStandardsCommand({})),
    securityHub.send(new DescribeStandardsCommand({})),
  ]);

  const nameMap = new Map((allResult.Standards ?? []).map((s) => [s.StandardsArn, s.Name]));
  const subscriptions = enabledResult.StandardsSubscriptions ?? [];

  const matched = subscriptions.find((s) => {
    const slug = extractStandardSlug(s.StandardsArn ?? '').toLowerCase();
    const name = (nameMap.get(s.StandardsArn ?? '') ?? '').toLowerCase();
    return slug.includes(query) || name.includes(query);
  });

  if (!matched) {
    const available = subscriptions
      .map((s) => nameMap.get(s.StandardsArn ?? '') ?? extractStandardSlug(s.StandardsArn ?? ''))
      .join(', ');
    return `Standard '${params.standard_name}' is not enabled. Enabled: ${available || 'none'}. Call get_enabled_standards to see the full list.`;
  }

  const standardName = nameMap.get(matched.StandardsArn ?? '') ?? extractStandardSlug(matched.StandardsArn ?? '');
  const subscriptionArn = matched.StandardsSubscriptionArn!;
  const standardsArn    = matched.StandardsArn!;

  // Paginate through all controls for this standard (NIST 800-53 has ~450 controls)
  const controls: Array<{ ControlId?: string; ControlStatus?: string; SeverityRating?: string; Title?: string }> = [];
  let controlsToken: string | undefined;
  for (let page = 0; page < 6; page++) {
    const res = await securityHub.send(new DescribeStandardsControlsCommand({
      StandardsSubscriptionArn: subscriptionArn,
      MaxResults: 100,
      NextToken: controlsToken,
    }));
    controls.push(...(res.Controls ?? []));
    controlsToken = res.NextToken;
    if (!controlsToken) break;
  }

  const enabled  = controls.filter((c) => c.ControlStatus === 'ENABLED');
  const disabled = controls.filter((c) => c.ControlStatus === 'DISABLED');

  const severityCounts = enabled.reduce<Record<string, number>>((acc, c) => {
    const sev = c.SeverityRating ?? 'UNKNOWN';
    acc[sev] = (acc[sev] ?? 0) + 1;
    return acc;
  }, {});

  // Get active failing compliance findings (Security Hub auto-generates one per control check)
  const failingResult = await securityHub.send(new GetFindingsCommand({
    Filters: {
      ComplianceStatus:  [{ Value: 'FAILED', Comparison: 'EQUALS' }],
      RecordState:       [{ Value: 'ACTIVE', Comparison: 'EQUALS' }],
      WorkflowStatus:    [{ Value: 'NEW', Comparison: 'EQUALS' }, { Value: 'NOTIFIED', Comparison: 'EQUALS' }],
      ProductName:       [{ Value: 'Security Hub', Comparison: 'EQUALS' }],
    },
    MaxResults: 100,
  }));

  // Filter to only findings associated with this specific standard
  const failingForStandard = (failingResult.Findings ?? []).filter((f) =>
    (f.Compliance?.AssociatedStandards ?? []).some((s) => s.StandardsId === standardsArn),
  );

  // Group by control family (e.g. "AC" from "AC.1", "EC2" from "EC2.1")
  const families: Record<string, { count: number; controls: string[] }> = {};
  for (const f of failingForStandard) {
    const controlId = f.Compliance?.SecurityControlId ?? 'Unknown';
    const family    = controlId.split('.')[0];
    if (!families[family]) families[family] = { count: 0, controls: [] };
    families[family].count++;
    if (!families[family].controls.includes(controlId)) families[family].controls.push(controlId);
  }

  const topFamilies = Object.entries(families)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 10)
    .map(([family, d]) => ({ controlFamily: family, failingFindings: d.count, affectedControls: d.controls.slice(0, 5) }));

  return JSON.stringify({
    standard: standardName,
    controls: {
      total:    controls.length,
      enabled:  enabled.length,
      disabled: disabled.length,
      enabledBySeverity: severityCounts,
    },
    failing: {
      count: failingForStandard.length,
      capped: failingResult.Findings?.length === 100,
    },
    topFailingControlFamilies: topFamilies,
    recommendation: topFamilies.length > 0
      ? `Start with the '${topFamilies[0].controlFamily}' family — it has the most active failures (${topFamilies[0].failingFindings}).`
      : 'No active failing findings found for this standard.',
  }, null, 2);
}

// ── Tool: get_task_queue ──────────────────────────────────────────────────────

const VALID_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED'] as const;

async function getTaskQueue(params: Record<string, string>): Promise<string> {
  const status = (params.status ?? 'PENDING').toUpperCase();

  if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
    return `Error: status must be one of: ${VALID_STATUSES.join(', ')}`;
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: STATUS_INDEX,
      KeyConditionExpression: '#s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': status },
      ScanIndexForward: false,
    }),
  );

  const tasks = result.Items ?? [];
  if (tasks.length === 0) {
    return `No ${status} tasks in the queue.`;
  }

  return JSON.stringify({ count: tasks.length, status, tasks }, null, 2);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseParams(parameters: BedrockParameter[]): Record<string, string> {
  return parameters.reduce<Record<string, string>>((acc, p) => {
    acc[p.name] = p.value;
    return acc;
  }, {});
}
