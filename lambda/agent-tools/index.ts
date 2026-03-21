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
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetAnomaliesCommand,
  GetAnomalyMonitorsCommand,
  Granularity,
  GroupDefinitionType,
} from '@aws-sdk/client-cost-explorer';
import {
  IAMClient,
  GetAccountSummaryCommand,
  GenerateCredentialReportCommand,
  GetCredentialReportCommand,
  ListUsersCommand,
  ListAttachedUserPoliciesCommand,
} from '@aws-sdk/client-iam';
import {
  AccessAnalyzerClient,
  ListAnalyzersCommand,
  ListFindingsCommand as AAListFindingsCommand,
} from '@aws-sdk/client-accessanalyzer';
import { randomUUID } from 'crypto';

// ── AWS Clients ──────────────────────────────────────────────────────────────

const REGION = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const securityHub = new SecurityHubClient({ region: REGION });
const guardDuty = new GuardDutyClient({ region: REGION });
const configService = new ConfigServiceClient({ region: REGION });
const cloudTrail = new CloudTrailClient({ region: REGION });
const tagging = new ResourceGroupsTaggingAPIClient({ region: REGION });
const ssmClient = new SSMClient({ region: REGION });
// Cost Explorer and IAM are global services — endpoint is always us-east-1
const costExplorer = new CostExplorerClient({ region: 'us-east-1' });
const iamClient = new IAMClient({ region: 'us-east-1' });
const accessAnalyzer = new AccessAnalyzerClient({ region: REGION });
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
      case 'get_cost_analysis':
        resultText = await getCostAnalysis(params);
        break;
      case 'get_iam_analysis':
        resultText = await getIamAnalysis(params);
        break;
      case 'get_access_analyzer':
        resultText = await getAccessAnalyzer(params);
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

// ── Tool: get_cost_analysis ───────────────────────────────────────────────────

type CostQueryType = 'services' | 'tags' | 'anomalies' | 'summary';

async function getCostAnalysis(params: Record<string, string>): Promise<string> {
  const queryType = (params.query_type ?? 'summary') as CostQueryType;
  const granularity = (params.granularity?.toUpperCase() ?? 'MONTHLY') as Granularity;

  // Default: last 30 days (or last full month for MONTHLY)
  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 30);
  const start = params.start_date ?? defaultStart.toISOString().slice(0, 10);
  const end   = params.end_date   ?? now.toISOString().slice(0, 10);

  if (queryType === 'anomalies') {
    // Get anomaly monitors first (needed to query anomalies)
    const monitorsRes = await costExplorer.send(new GetAnomalyMonitorsCommand({}));
    const monitors = monitorsRes.AnomalyMonitors ?? [];

    if (monitors.length === 0) {
      return 'No Cost Anomaly monitors are configured. Enable AWS Cost Anomaly Detection in the Cost Management console to use this feature.';
    }

    const anomaliesRes = await costExplorer.send(new GetAnomaliesCommand({
      DateInterval: { StartDate: start, EndDate: end },
      MonitorArn: monitors[0].MonitorArn,
      MaxResults: 20,
    }));

    const anomalies = anomaliesRes.Anomalies ?? [];
    if (anomalies.length === 0) return `No cost anomalies detected between ${start} and ${end}.`;

    return JSON.stringify({
      period: { start, end },
      anomaly_count: anomalies.length,
      anomalies: anomalies.map(a => ({
        anomaly_id: a.AnomalyId,
        service: a.RootCauses?.[0]?.Service ?? 'Unknown',
        region: a.RootCauses?.[0]?.Region ?? 'Unknown',
        total_impact:        `$${(a.Impact?.TotalImpact ?? 0).toFixed(2)}`,
        total_impact_pct:    `${(a.Impact?.TotalImpactPercentage ?? 0).toFixed(1)}%`,
        max_impact:          `$${(a.Impact?.MaxImpact ?? 0).toFixed(2)}`,
        severity: a.AnomalyScore?.MaxScore !== undefined
          ? (a.AnomalyScore.MaxScore > 80 ? 'HIGH' : a.AnomalyScore.MaxScore > 40 ? 'MEDIUM' : 'LOW')
          : 'UNKNOWN',
        start_date: a.AnomalyStartDate,
        end_date: a.AnomalyEndDate ?? 'ongoing',
      })),
    }, null, 2);
  }

  // Build GroupBy for services or tags
  const groupBy = queryType === 'tags' && params.tag_key
    ? [{ Type: GroupDefinitionType.TAG, Key: params.tag_key }]
    : [{ Type: GroupDefinitionType.DIMENSION, Key: 'SERVICE' }];

  // Build filter for tag-scoped queries
  const filter = queryType === 'tags' && params.tag_key && params.tag_value
    ? { Tags: { Key: params.tag_key, Values: [params.tag_value] } }
    : undefined;

  const res = await costExplorer.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: granularity,
    Metrics: ['UnblendedCost'],
    GroupBy: groupBy,
    ...(filter && { Filter: filter }),
  }));

  const results = res.ResultsByTime ?? [];

  // Aggregate totals across all time periods
  const totals: Record<string, number> = {};
  let grandTotal = 0;

  for (const period of results) {
    for (const group of period.Groups ?? []) {
      const key   = group.Keys?.[0] ?? 'Unknown';
      const cost  = parseFloat(group.Metrics?.UnblendedCost?.Amount ?? '0');
      totals[key] = (totals[key] ?? 0) + cost;
      grandTotal += cost;
    }
  }

  const sorted = Object.entries(totals)
    .sort(([, a], [, b]) => b - a)
    .map(([name, cost]) => ({
      [queryType === 'tags' ? 'tag_value' : 'service']: name,
      cost: `$${cost.toFixed(2)}`,
      percent: grandTotal > 0 ? `${((cost / grandTotal) * 100).toFixed(1)}%` : '0%',
    }));

  return JSON.stringify({
    period: { start, end, granularity },
    query_type: queryType,
    ...(queryType === 'tags' && params.tag_key && { tag_key: params.tag_key }),
    ...(params.tag_value && { tag_value: params.tag_value }),
    grand_total: `$${grandTotal.toFixed(2)}`,
    breakdown: sorted,
  }, null, 2);
}

// ── Tool: get_iam_analysis ────────────────────────────────────────────────────

async function getIamAnalysis(params: Record<string, string>): Promise<string> {
  const queryType = params.query_type ?? 'summary';

  // Account-level summary
  if (queryType === 'summary') {
    const summary = await iamClient.send(new GetAccountSummaryCommand({}));
    const m = summary.SummaryMap ?? {};
    return JSON.stringify({
      users:               m['Users'],
      groups:              m['Groups'],
      roles:               m['Roles'],
      policies:            m['Policies'],
      mfa_devices:         m['MFADevices'],
      mfa_devices_in_use:  m['MFADevicesInUse'],
      access_keys_present: m['AccountAccessKeysPresent'],
      account_mfa_enabled: m['AccountMFAEnabled'] === 1,
      signing_certs:       m['AccountSigningCertificatesPresent'],
    }, null, 2);
  }

  // Credential report — covers MFA gaps and key rotation
  if (queryType === 'mfa_gaps' || queryType === 'key_rotation' || queryType === 'credential_report') {
    // GenerateCredentialReport is async — keep retrying until COMPLETE
    let state = 'STARTED';
    for (let attempt = 0; attempt < 6 && state !== 'COMPLETE'; attempt++) {
      const gen = await iamClient.send(new GenerateCredentialReportCommand({}));
      state = gen.State ?? 'STARTED';
      if (state !== 'COMPLETE') await new Promise(r => setTimeout(r, 2000));
    }

    const report = await iamClient.send(new GetCredentialReportCommand({}));
    const csv = Buffer.from(report.Content ?? '').toString('utf-8');
    const lines = csv.split('\n').filter(Boolean);
    const headers = lines[0].split(',');

    const col = (row: string[], name: string) => row[headers.indexOf(name)] ?? '';

    const users = lines.slice(1).map(line => {
      const row = line.split(',');
      const keyAge = (dateStr: string) => {
        if (!dateStr || dateStr === 'N/A' || dateStr === 'not_supported') return null;
        return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
      };
      return {
        user:              col(row, 'user'),
        mfa_active:        col(row, 'mfa_active') === 'true',
        password_enabled:  col(row, 'password_enabled') === 'true',
        password_last_used: col(row, 'password_last_used'),
        key1_active:       col(row, 'access_key_1_active') === 'true',
        key1_age_days:     keyAge(col(row, 'access_key_1_last_rotated')),
        key2_active:       col(row, 'access_key_2_active') === 'true',
        key2_age_days:     keyAge(col(row, 'access_key_2_last_rotated')),
      };
    });

    if (queryType === 'mfa_gaps') {
      const gaps = users.filter(u => u.password_enabled && !u.mfa_active);
      return gaps.length === 0
        ? 'All console users have MFA enabled.'
        : JSON.stringify({ mfa_gap_count: gaps.length, users_without_mfa: gaps.map(u => u.user) }, null, 2);
    }

    if (queryType === 'key_rotation') {
      const stale = users.flatMap(u => {
        const results = [];
        if (u.key1_active && u.key1_age_days !== null && u.key1_age_days > 90)
          results.push({ user: u.user, key: 'key1', age_days: u.key1_age_days });
        if (u.key2_active && u.key2_age_days !== null && u.key2_age_days > 90)
          results.push({ user: u.user, key: 'key2', age_days: u.key2_age_days });
        return results;
      });
      return stale.length === 0
        ? 'All active access keys have been rotated within 90 days.'
        : JSON.stringify({ stale_key_count: stale.length, stale_keys: stale }, null, 2);
    }

    // Full credential report
    return JSON.stringify({ user_count: users.length, users }, null, 2);
  }

  // Admin users — check for directly attached AdministratorAccess policy
  if (queryType === 'admin_users') {
    const usersRes = await iamClient.send(new ListUsersCommand({ MaxItems: 100 }));
    const admins: string[] = [];
    for (const user of usersRes.Users ?? []) {
      const policies = await iamClient.send(new ListAttachedUserPoliciesCommand({ UserName: user.UserName }));
      if (policies.AttachedPolicies?.some((p: { PolicyName?: string }) => p.PolicyName === 'AdministratorAccess')) {
        admins.push(user.UserName ?? '');
      }
    }
    return admins.length === 0
      ? 'No users have AdministratorAccess directly attached.'
      : JSON.stringify({ admin_user_count: admins.length, admin_users: admins }, null, 2);
  }

  return `Unknown query_type '${queryType}'. Valid values: summary, mfa_gaps, key_rotation, credential_report, admin_users.`;
}

// ── Tool: get_access_analyzer ─────────────────────────────────────────────────

async function getAccessAnalyzer(params: Record<string, string>): Promise<string> {
  const status      = (params.status?.toUpperCase() ?? 'ACTIVE') as 'ACTIVE' | 'ARCHIVED' | 'RESOLVED';
  const resourceType = params.resource_type;

  const analyzersRes = await accessAnalyzer.send(new ListAnalyzersCommand({}));
  const analyzers = analyzersRes.analyzers ?? [];

  if (analyzers.length === 0) {
    return 'No IAM Access Analyzers are configured. Enable Access Analyzer in the IAM console (Access Analyzer → Create analyzer) to use this feature.';
  }

  const allFindings: unknown[] = [];

  for (const analyzer of analyzers) {
    const res = await accessAnalyzer.send(new AAListFindingsCommand({
      analyzerArn: analyzer.arn,
      filter: {
        status: { eq: [status] },
        ...(resourceType && { resourceType: { eq: [resourceType] } }),
      },
      maxResults: 50,
    }));

    for (const f of res.findings ?? []) {
      allFindings.push({
        id:            f.id,
        resource:      f.resource,
        resource_type: f.resourceType,
        action:        f.action,
        principal:     f.principal,
        condition:     f.condition,
        status:        f.status,
        is_public:     f.isPublic,
        created_at:    f.createdAt,
        analyzer:      analyzer.name,
      });
    }
  }

  if (allFindings.length === 0) {
    return `No ${status.toLowerCase()} Access Analyzer findings${resourceType ? ` for resource type ${resourceType}` : ''}.`;
  }

  return JSON.stringify({
    analyzer_count: analyzers.length,
    finding_count:  allFindings.length,
    status_filter:  status,
    findings:       allFindings,
  }, null, 2);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseParams(parameters: BedrockParameter[]): Record<string, string> {
  return parameters.reduce<Record<string, string>>((acc, p) => {
    acc[p.name] = p.value;
    return acc;
  }, {});
}
