/**
 * ato-worker/index.ts — ATO Assist background processor
 *
 * Triggered by DynamoDB Streams on the AtoJobsTable when a new job is INSERT-ed
 * with status=PENDING. For each job:
 *   1. Marks the job IN_PROGRESS
 *   2. Fetches active Security Hub findings (paginated, up to 2000)
 *   3. Groups findings by NIST 800-53 Rev 5 control family using RelatedRequirements
 *   4. For each family with failures, calls Bedrock (Claude Sonnet) to generate:
 *        - riskAssessment narrative
 *        - implementationStatement narrative
 *        - poamEntries for each failed finding
 *      Families with only passing findings get a generated passing statement
 *      without a Bedrock call (saves cost and time)
 *   5. Writes the full structured JSON report to S3
 *   6. Marks the job COMPLETED (or FAILED on any error)
 *
 * Never throws — all errors are captured and written back to DynamoDB.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  SecurityHubClient,
  GetFindingsCommand,
  type AwsSecurityFinding,
} from '@aws-sdk/client-securityhub';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';

// ── Config ─────────────────────────────────────────────────────────────────────
const REGION        = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const JOBS_TABLE    = process.env.JOBS_TABLE_NAME!;
const REPORTS_BUCKET = process.env.REPORTS_BUCKET!;
const MODEL_ID      = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const MAX_FINDINGS  = 2000; // Cap to avoid Lambda timeout on very large accounts (was 500 — missed families beyond that)

// ── AWS clients ────────────────────────────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const hub     = new SecurityHubClient({ region: REGION });
const bedrock = new BedrockRuntimeClient({ region: REGION });
const s3      = new S3Client({ region: REGION });

// ── NIST 800-53 control family definitions ────────────────────────────────────
const NIST_FAMILIES: Record<string, string> = {
  AC: 'Access Control',
  AT: 'Awareness and Training',
  AU: 'Audit and Accountability',
  CA: 'Assessment, Authorization, and Monitoring',
  CM: 'Configuration Management',
  CP: 'Contingency Planning',
  IA: 'Identification and Authentication',
  IR: 'Incident Response',
  MA: 'Maintenance',
  MP: 'Media Protection',
  PE: 'Physical and Environmental Protection',
  PL: 'Planning',
  PM: 'Program Management',
  PS: 'Personnel Security',
  RA: 'Risk Assessment',
  SA: 'System and Services Acquisition',
  SC: 'System and Communications Protection',
  SI: 'System and Information Integrity',
};

// ── Types ──────────────────────────────────────────────────────────────────────

interface PoamEntry {
  poamId: string;
  affectedControl: string;
  description: string;
  dateIdentified: string;
  scheduledCompletionDate: string;
  status: string;
  riskRating: string;
  remediationPlan: string;
}

interface ControlFamily {
  family: string;
  familyName: string;
  findingCount: number;
  passCount: number;
  failCount: number;
  riskAssessment: string;
  implementationStatement: string;
  poamEntries: PoamEntry[];
}

interface AtoReport {
  controlFamilies: ControlFamily[];
  summary: {
    totalFindings: number;
    totalFailed: number;
    familiesEvaluated: number;
  };
  generatedAt: string;
}

interface BedrockAssessment {
  riskAssessment: string;
  implementationStatement: string;
  poamEntries: PoamEntry[];
}

// ── Handler ────────────────────────────────────────────────────────────────────

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};

async function processRecord(record: DynamoDBRecord): Promise<void> {
  // Only act on INSERT events (new job created)
  if (record.eventSource !== 'aws:dynamodb' || record.eventName !== 'INSERT') return;

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return;

  const jobId       = newImage.jobId?.S;
  const username    = newImage.username?.S;
  const status      = newImage.status?.S;
  const standardsArn = newImage.standardsArn?.S;

  if (!jobId || !username || status !== 'PENDING') return;

  console.log('Starting ATO job', { jobId, username, standardsArn });

  try {
    await processJob(jobId, username, standardsArn);
  } catch (e: unknown) {
    // Top-level safety net — processJob handles its own errors, but guard against any leak
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Unexpected error in processRecord', { jobId, error: msg });
    await markFailed(jobId, `Unexpected worker error: ${msg}`);
  }
}

// ── Core job processor ─────────────────────────────────────────────────────────

async function processJob(jobId: string, username: string, standardsArn?: string): Promise<void> {
  await markInProgress(jobId);

  // ── Step 1: Fetch Security Hub findings ──────────────────────────────────────
  console.log('Fetching Security Hub findings', { jobId, standardsArn });
  let findings: AwsSecurityFinding[];
  try {
    findings = await fetchFindings(standardsArn);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await markFailed(jobId, `Failed to fetch Security Hub findings: ${msg}`);
    return;
  }
  console.log(`Fetched ${findings.length} findings`, { jobId });

  // ── Step 2: Group by NIST 800-53 control family ───────────────────────────────
  const familyMap = groupByNistFamily(findings);

  // Log a sample RelatedRequirements to diagnose regex issues
  const sampleReqs = findings.slice(0, 5)
    .flatMap(f => f.Compliance?.RelatedRequirements ?? [])
    .slice(0, 10);
  console.log('Sample RelatedRequirements', { jobId, sampleReqs, familiesFound: [...familyMap.keys()] });

  if (familyMap.size === 0) {
    // No NIST findings at all — write an empty report rather than failing
    const emptyReport: AtoReport = {
      controlFamilies: [],
      summary: { totalFindings: 0, totalFailed: 0, familiesEvaluated: 0 },
      generatedAt: new Date().toISOString(),
    };
    await writeReport(jobId, username, emptyReport);
    await markCompleted(jobId, `ato-reports/${username}/${jobId}.json`);
    return;
  }

  // ── Step 3: Generate narratives per family ────────────────────────────────────
  const controlFamilies: ControlFamily[] = [];
  let totalFindings = 0;
  let totalFailed   = 0;

  for (const [family, { passed, failed }] of familyMap.entries()) {
    const findingCount = passed.length + failed.length;
    const passCount    = passed.length;
    const failCount    = failed.length;
    totalFindings += findingCount;
    totalFailed   += failCount;

    let assessment: BedrockAssessment;

    if (failCount > 0) {
      // Call Bedrock to generate a real assessment for families with failures
      console.log(`Generating assessment for family ${family}`, { jobId, failCount });
      try {
        assessment = await generateAssessment(family, passed, failed);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Bedrock call failed for family ${family}`, { jobId, error: msg });
        // Degrade gracefully: include the family with a fallback message
        // Cap at 10 entries — same limit as the Bedrock prompt
        const fName = NIST_FAMILIES[family] ?? family;
        assessment = {
          riskAssessment: `${failed.length} findings failed in the ${fName} (${family}) control family. Manual review required — see POA&M entries below.`,
          implementationStatement: `The ${fName} control family has ${passed.length} passing and ${failed.length} failing controls. Review and remediate the findings listed in the POA&M section.`,
          poamEntries: failed.slice(0, 10).map((f, i) => ({
            poamId: `POAM-${family}-${String(i + 1).padStart(3, '0')}`,
            affectedControl: extractControlId(f, family),
            description: f.Title ?? 'No title available',
            dateIdentified: new Date().toISOString().slice(0, 10),
            scheduledCompletionDate: futureDate(severityToRisk(f.Severity?.Label) === 'High' ? 30 : 60),
            status: 'Open',
            riskRating: severityToRisk(f.Severity?.Label),
            remediationPlan: buildFallbackRemediation(f),
          })),
        };
      }
    } else {
      // All passing — no Bedrock call needed
      assessment = {
        riskAssessment: `All ${passCount} evaluated ${NIST_FAMILIES[family] ?? family} controls are currently passing. No findings of concern.`,
        implementationStatement: `Controls in the ${family} family are implemented and verified as compliant per current Security Hub evaluation.`,
        poamEntries: [],
      };
    }

    controlFamilies.push({
      family,
      familyName: NIST_FAMILIES[family] ?? family,
      findingCount,
      passCount,
      failCount,
      ...assessment,
    });
  }

  // Sort families alphabetically by code
  controlFamilies.sort((a, b) => a.family.localeCompare(b.family));

  // ── Step 4: Write report to S3 ───────────────────────────────────────────────
  const report: AtoReport = {
    controlFamilies,
    summary: {
      totalFindings,
      totalFailed,
      familiesEvaluated: controlFamilies.length,
    },
    generatedAt: new Date().toISOString(),
  };

  const s3Key = `ato-reports/${username}/${jobId}.json`;
  try {
    await writeReport(jobId, username, report);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await markFailed(jobId, `Failed to write report to S3: ${msg}`);
    return;
  }

  await markCompleted(jobId, s3Key);
  console.log('ATO job completed', { jobId, familiesEvaluated: controlFamilies.length, totalFailed });
}

// ── Security Hub: fetch active failed findings ─────────────────────────────────

async function fetchFindings(standardsArn?: string): Promise<AwsSecurityFinding[]> {
  const all: AwsSecurityFinding[] = [];
  let nextToken: string | undefined;

  do {
    const res = await hub.send(new GetFindingsCommand({
      Filters: {
        RecordState:    [{ Value: 'ACTIVE',     Comparison: 'EQUALS' }],
        WorkflowStatus: [{ Value: 'SUPPRESSED', Comparison: 'NOT_EQUALS' }],
        // Filter to the selected standard so RelatedRequirements carry its control mappings
        ...(standardsArn ? { StandardsArn: [{ Value: standardsArn, Comparison: 'EQUALS' }] } : {}),
      },
      MaxResults: 100,
      NextToken: nextToken,
    }));

    if (res.Findings) all.push(...res.Findings);
    nextToken = res.NextToken;
  } while (nextToken && all.length < MAX_FINDINGS);

  return all;
}

// ── Group findings by NIST 800-53 control family ──────────────────────────────

function groupByNistFamily(
  findings: AwsSecurityFinding[],
): Map<string, { passed: AwsSecurityFinding[]; failed: AwsSecurityFinding[] }> {
  const map = new Map<string, { passed: AwsSecurityFinding[]; failed: AwsSecurityFinding[] }>();

  for (const finding of findings) {
    const families = extractNistFamilies(finding);
    if (families.length === 0) continue;

    const isFailed = finding.Compliance?.Status === 'FAILED' || finding.Compliance?.Status === 'WARNING';

    for (const family of families) {
      if (!map.has(family)) map.set(family, { passed: [], failed: [] });
      const bucket = map.get(family)!;
      if (isFailed) {
        bucket.failed.push(finding);
      } else {
        bucket.passed.push(finding);
      }
    }
  }

  return map;
}

/**
 * Extracts NIST 800-53 control family codes from a finding's RelatedRequirements.
 * Looks for strings like "NIST.800-53.r5 AC-2", "NIST.800-53.r5 SC-7", etc.
 * Returns deduplicated family codes (e.g. ["AC", "SC"]).
 */
function extractNistFamilies(finding: AwsSecurityFinding): string[] {
  const related = finding.Compliance?.RelatedRequirements ?? [];
  const families = new Set<string>();

  for (const req of related) {
    // Security Hub formats NIST 800-53 requirements as:
    //   "NIST.800-53.r5 AC-2"      (most common)
    //   "NIST.800-53.r5 AC-2(1)"   (with enhancement number)
    //   "NIST 800-53 Rev 5 AC-2"   (alternative format)
    // We only need the two-letter family code before the hyphen.
    const match = req.match(/NIST[\s.]800-53[\s.](?:r5|Rev[\s.]?5)?[\s.]?([A-Z]{2})-/i);
    if (match?.[1]) {
      const family = match[1].toUpperCase();
      if (family in NIST_FAMILIES) families.add(family);
    }
  }

  return Array.from(families);
}

// ── Bedrock: generate compliance narratives ───────────────────────────────────

async function generateAssessment(
  family: string,
  passed: AwsSecurityFinding[],
  failed: AwsSecurityFinding[],
): Promise<BedrockAssessment> {
  const familyName = NIST_FAMILIES[family] ?? family;
  const today      = new Date().toISOString().slice(0, 10);

  // Cap to 10 entries in the prompt to stay within token budget
  const failedSummary = failed.slice(0, 10).map((f, i) => ({
    id: `${family}-${String(i + 1).padStart(3, '0')}`,
    title: f.Title ?? 'Untitled finding',
    description: (f.Description ?? '').slice(0, 150),
    severity: f.Severity?.Label ?? 'UNKNOWN',
    resource: f.Resources?.[0]?.Id ?? 'unknown',
    control: extractControlId(f, family),
    remediationUrl: f.Remediation?.Recommendation?.Url ?? '',
  }));

  const prompt = `You are a NIST 800-53 compliance expert preparing an ATO (Authority to Operate) package for an AWS environment.

Analyze these Security Hub findings for NIST 800-53 Rev 5 control family: ${family} - ${familyName}

Statistics:
- Passing controls: ${passed.length}
- Failing controls: ${failed.length} (${failedSummary.length} shown below)
- Total evaluated: ${passed.length + failed.length}

Failing Findings:
${JSON.stringify(failedSummary, null, 2)}

CRITICAL: Respond with ONLY a valid JSON object. No markdown fences, no explanation, no text before or after the JSON.

IMPORTANT JSON rules - violations will cause a parse error:
- Use plain prose in all string values. No curly braces, no square brackets, no quotes inside strings.
- Write CLI steps in plain English, not as shell commands with JSON arguments.

{
  "riskAssessment": "2-3 sentence risk posture narrative for the ${family} family",
  "implementationStatement": "2-3 sentence description of current ${familyName} control implementation",
  "poamEntries": [
    {
      "poamId": "POAM-${family}-001",
      "affectedControl": "${family}-X",
      "description": "one sentence describing the specific compliance gap",
      "dateIdentified": "${today}",
      "scheduledCompletionDate": "YYYY-MM-DD",
      "status": "Open",
      "riskRating": "High or Medium or Low",
      "remediationPlan": "2-3 specific steps in plain English. Example: Navigate to IAM in the AWS console, select Users, choose the affected user, click Security credentials tab, then click Manage MFA device and follow the setup wizard."
    }
  ]
}

Rules:
- One POA&M entry per failing finding shown above (${failedSummary.length} entries total)
- riskRating: CRITICAL or HIGH severity maps to High, MEDIUM maps to Medium, LOW or INFORMATIONAL maps to Low
- scheduledCompletionDate: High risk gets 30 days, Medium gets 60 days, Low gets 90 days from ${today}
- remediationPlan: plain English steps only - describe what to click or navigate to, not CLI syntax`;

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  };

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body),
  }));

  const rawText = new TextDecoder().decode(response.body);
  const parsed  = JSON.parse(rawText) as { content?: Array<{ text?: string }> };
  const text    = parsed.content?.[0]?.text ?? '';

  // Extract JSON from the response (Claude may wrap it in markdown code fences)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Could not extract JSON from Bedrock response for family ${family}`);

  // Attempt parse; if it fails, log the raw text for diagnosis
  try {
    return JSON.parse(jsonMatch[0]) as BedrockAssessment;
  } catch (parseErr) {
    console.error(`JSON parse failed for family ${family}. First 500 chars of response:`, text.slice(0, 500));
    throw new Error(`Bedrock returned malformed JSON for family ${family}: ${(parseErr as Error).message}`);
  }
}

// ── S3: write report ──────────────────────────────────────────────────────────

async function writeReport(jobId: string, username: string, report: AtoReport): Promise<void> {
  const key = `ato-reports/${username}/${jobId}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: REPORTS_BUCKET,
    Key: key,
    Body: JSON.stringify(report),
    ContentType: 'application/json',
  }));
  console.log('Report written to S3', { key });
}

// ── DynamoDB: job status helpers ──────────────────────────────────────────────

async function markInProgress(jobId: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { jobId },
    ConditionExpression: '#s = :pending',
    UpdateExpression: 'SET #s = :inprogress',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'PENDING', ':inprogress': 'IN_PROGRESS' },
  })).catch(ignoreConditionalCheckFailed);
}

async function markCompleted(jobId: string, resultS3Key: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { jobId },
    ConditionExpression: '#s = :inprogress',
    UpdateExpression: 'SET #s = :completed, endTime = :now, resultS3Key = :key',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':inprogress': 'IN_PROGRESS',
      ':completed':  'COMPLETED',
      ':now':        new Date().toISOString(),
      ':key':        resultS3Key,
    },
  })).catch(ignoreConditionalCheckFailed);
}

async function markFailed(jobId: string, reason: string): Promise<void> {
  console.error('Marking ATO job FAILED', { jobId, reason });
  await ddb.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: 'SET #s = :failed, endTime = :now, #err = :reason',
    ExpressionAttributeNames: { '#s': 'status', '#err': 'error' },
    ExpressionAttributeValues: {
      ':failed': 'FAILED',
      ':now':    new Date().toISOString(),
      ':reason': reason,
    },
  }));
}

function ignoreConditionalCheckFailed(e: unknown): void {
  if ((e as { name?: string }).name === 'ConditionalCheckFailedException') {
    console.warn('Conditional check failed on status update (likely re-delivery), skipping');
    return;
  }
  throw e;
}

// ── Utility helpers ───────────────────────────────────────────────────────────

/**
 * Builds a fallback remediation string from Security Hub finding metadata.
 * Avoids the generic "consult documentation" text that Security Hub often returns.
 */
function buildFallbackRemediation(finding: AwsSecurityFinding): string {
  const rec   = finding.Remediation?.Recommendation;
  const url   = rec?.Url ?? '';
  const text  = rec?.Text ?? '';
  const title = finding.Title ?? '';

  // Skip the generic AWS boilerplate — it adds no value in a POA&M
  const isGeneric = text.toLowerCase().includes('consult') || text.toLowerCase().includes('for information on how');

  const base = isGeneric
    ? `Investigate and remediate the "${title}" finding in your AWS environment.`
    : text.slice(0, 250);

  return url ? `${base} See: ${url}` : base;
}

function extractControlId(finding: AwsSecurityFinding, family: string): string {
  const related = finding.Compliance?.RelatedRequirements ?? [];
  for (const req of related) {
    const match = req.match(new RegExp(`NIST[.\\s]800-53[.\\s][^\\s]*\\s+(${family}-\\d+)`, 'i'));
    if (match?.[1]) return match[1].toUpperCase();
  }
  return `${family}-?`;
}

function severityToRisk(label: string | undefined): string {
  switch (label?.toUpperCase()) {
    case 'CRITICAL': return 'High';
    case 'HIGH':     return 'High';
    case 'MEDIUM':   return 'Medium';
    case 'LOW':      return 'Low';
    default:         return 'Medium';
  }
}

function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}
