import { SecurityHubClient, GetFindingsCommand } from '@aws-sdk/client-securityhub';
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
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

// ── AWS Clients ──────────────────────────────────────────────────────────────

const REGION = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const securityHub = new SecurityHubClient({ region: REGION });
const guardDuty = new GuardDutyClient({ region: REGION });
const configService = new ConfigServiceClient({ region: REGION });
const cloudTrail = new CloudTrailClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

const TABLE = process.env.TABLE_NAME!;
const STATUS_INDEX = process.env.STATUS_INDEX_NAME ?? 'status-index';

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

// ── Tool: queue_task ──────────────────────────────────────────────────────────

const VALID_ACTIONS = ['enable_s3_logging', 'enable_s3_encryption'] as const;

async function queueTask(params: Record<string, string>): Promise<string> {
  const { finding_id, resource_id, action, rationale } = params;

  if (!finding_id) return 'Error: finding_id is required';
  if (!resource_id) return 'Error: resource_id is required';
  if (!action) return 'Error: action is required';
  if (!rationale) return 'Error: rationale is required';
  if (!VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
    return `Error: action must be one of: ${VALID_ACTIONS.join(', ')}`;
  }

  const taskId = randomUUID();
  const now = new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
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
      },
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
