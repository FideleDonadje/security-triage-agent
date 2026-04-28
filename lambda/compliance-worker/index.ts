/**
 * compliance-worker/index.ts — async compliance document generator
 *
 * Triggered by DynamoDB Streams on security-triage-systems when a document
 * record is written with status=PENDING. Dispatches to a generator function
 * based on the sk value (DOC#NIST#{TYPE}).
 *
 * Supported document types:
 *   POAM    — Plan of Action & Milestones (SecurityHub findings → Bedrock)
 *   SSP     — System Security Plan (SecurityHub + Config + IAM → Bedrock)
 *   SAR     — Security Assessment Report (SecurityHub + GuardDuty → Bedrock)
 *   RA      — Risk Assessment (SecurityHub + GuardDuty + AccessAnalyzer → Bedrock)
 *   CONMON  — Continuous Monitoring Plan (SecurityHub standards/integrations → Bedrock)
 *   IRP     — Incident Response Plan (SecurityHub + system metadata → Bedrock)
 *
 * Never throws — all errors are captured and written back to DynamoDB as FAILED.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  SecurityHubClient,
  GetFindingsCommand,
  GetEnabledStandardsCommand,
  DescribeHubCommand,
  type AwsSecurityFinding,
} from '@aws-sdk/client-securityhub';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  GuardDutyClient,
  ListDetectorsCommand,
  ListFindingsCommand,
  GetFindingsCommand as GdGetFindingsCommand,
} from '@aws-sdk/client-guardduty';
import { IAMClient, GenerateCredentialReportCommand, GetCredentialReportCommand, GetAccountSummaryCommand } from '@aws-sdk/client-iam';
import { AccessAnalyzerClient, ListAnalyzersCommand, ListFindingsCommand as AAListFindingsCommand } from '@aws-sdk/client-accessanalyzer';
import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { getBaselineControls, NIST_TITLES, NIST_BASELINE } from './nist-catalog';
import {
  getAwsResponsibility,
  inheritedNarrative,
  AWS_INHERITED_IDS,
  AWS_SHARED_IDS,
} from './aws-crm';

// ── Config ─────────────────────────────────────────────────────────────────────
const REGION          = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const SYSTEMS_TABLE   = process.env.SYSTEMS_TABLE_NAME!;
const COMPLIANCE_BUCKET = process.env.COMPLIANCE_BUCKET!;
const MODEL_ID        = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const SYSTEM_ID       = 'default';

// ── AWS clients ────────────────────────────────────────────────────────────────
const ddb     = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
const hub     = new SecurityHubClient({ region: REGION });
const bedrock = new BedrockRuntimeClient({ region: REGION });
const s3      = new S3Client({ region: REGION });
const gd      = new GuardDutyClient({ region: REGION });
const iam     = new IAMClient({ region: REGION });
const aa      = new AccessAnalyzerClient({ region: REGION });

// ── NIST 800-53 control family definitions ─────────────────────────────────────
const NIST_FAMILIES: Record<string, string> = {
  AC: 'Access Control', AT: 'Awareness and Training', AU: 'Audit and Accountability',
  CA: 'Assessment, Authorization, and Monitoring', CM: 'Configuration Management',
  CP: 'Contingency Planning', IA: 'Identification and Authentication',
  IR: 'Incident Response', MA: 'Maintenance', MP: 'Media Protection',
  PE: 'Physical and Environmental Protection', PL: 'Planning',
  PM: 'Program Management', PS: 'Personnel Security', RA: 'Risk Assessment',
  SA: 'System and Services Acquisition', SC: 'System and Communications Protection',
  SI: 'System and Information Integrity',
};

// ── Types ──────────────────────────────────────────────────────────────────────

type DocType = 'POAM' | 'SSP' | 'SAR' | 'RA' | 'CONMON' | 'IRP';

interface SystemMetadata {
  systemName: string;
  ownerName: string;
  ownerEmail: string;
  awsAccountId: string;
  region: string;
}

interface Fips199Record {
  confidentiality: string;
  integrity: string;
  availability: string;
  overallImpact: string;
}

type ControlStatus =
  | 'implemented'
  | 'partially_implemented'
  | 'planned'
  | 'alternative_implementation'
  | 'not_applicable'
  | 'inherited'         // fully satisfied by AWS
  | 'inherited_shared'; // shared responsibility — AWS + customer

type ControlOrigination =
  | 'sp_system_specific'
  | 'sp_hybrid'
  | 'configured_by_customer'
  | 'provided_by_customer'
  | 'inherited';

interface SspControlEntry {
  controlId:               string;
  title:                   string;
  status:                  ControlStatus;
  origination:             ControlOrigination;
  responsibleEntities:     string;
  implementationNarrative: string;
  testingEvidence:         string;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    await processRecord(record).catch((e: unknown) => {
      console.error('Unexpected top-level error in processRecord', e);
    });
  }
};

async function processRecord(record: DynamoDBRecord): Promise<void> {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return;

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return;

  const pk     = newImage.pk?.S;
  const sk     = newImage.sk?.S;
  const status = newImage.status?.S;

  if (!pk || !sk || status !== 'PENDING') return;
  // Only handle document records (not METADATA, not FIPS199 which is never PENDING)
  if (!sk.startsWith('DOC#NIST#')) return;

  const docType = sk.replace('DOC#NIST#', '') as DocType;
  const systemId = pk.replace('SYSTEM#', '');

  console.log('Compliance worker: starting generation', { systemId, docType });

  const claimed = await markInProgress(pk, sk);
  if (!claimed) {
    console.log('Already claimed by another worker (duplicate stream delivery), skipping', { pk, sk });
    return;
  }

  try {
    await generateDocument(systemId, docType, pk, sk);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Document generation failed', { systemId, docType, error: msg });
    await markFailed(pk, sk, msg);
  }
}

// ── Document dispatch ──────────────────────────────────────────────────────────

async function generateDocument(systemId: string, docType: DocType, pk: string, sk: string): Promise<void> {
  let report: unknown;

  switch (docType) {
    case 'POAM':   report = await generatePoam();           break;
    case 'SSP':    report = await generateSsp(systemId);    break;
    case 'SAR':    report = await generateSar();            break;
    case 'RA':     report = await generateRiskAssessment(); break;
    case 'CONMON': report = await generateConmon();         break;
    case 'IRP':    report = await generateIrp(systemId);   break;
    default:
      throw new Error(`Unknown docType: ${docType}`);
  }

  const s3Key = `compliance/${systemId}/NIST/${docType}/current.json`;
  await s3.send(new PutObjectCommand({
    Bucket:      COMPLIANCE_BUCKET,
    Key:         s3Key,
    Body:        JSON.stringify(report),
    ContentType: 'application/json',
  }));

  await markCompleted(pk, sk, s3Key);
  console.log('Compliance worker: generation complete', { systemId, docType, s3Key });
}

// ── POA&M generator (adapted from ato-worker) ─────────────────────────────────

async function generatePoam(): Promise<unknown> {
  const findings = await fetchNistFindings();
  const familyMap = groupByNistFamily(findings);

  if (familyMap.size === 0) {
    return {
      controlFamilies: [],
      summary: { totalFindings: 0, totalFailed: 0, familiesEvaluated: 0 },
      generatedAt: new Date().toISOString(),
    };
  }

  const controlFamilies = [];
  let totalFindings = 0;
  let totalFailed   = 0;

  for (const [family, { passed, failed }] of familyMap.entries()) {
    totalFindings += passed.length + failed.length;
    totalFailed   += failed.length;

    let assessment;
    if (failed.length > 0) {
      try {
        assessment = await callBedrock(buildPoamPrompt(family, passed, failed));
      } catch (e: unknown) {
        assessment = fallbackPoamAssessment(family, passed, failed);
      }
    } else {
      assessment = {
        riskAssessment:          `All ${passed.length} evaluated ${NIST_FAMILIES[family] ?? family} controls are currently passing.`,
        implementationStatement: `Controls in the ${family} family are implemented and verified as compliant per current Security Hub evaluation.`,
        poamEntries: [],
      };
    }

    controlFamilies.push({
      family,
      familyName:   NIST_FAMILIES[family] ?? family,
      findingCount: passed.length + failed.length,
      passCount:    passed.length,
      failCount:    failed.length,
      ...assessment,
    });
  }

  controlFamilies.sort((a, b) => a.family.localeCompare(b.family));

  return {
    controlFamilies,
    summary: { totalFindings, totalFailed, familiesEvaluated: controlFamilies.length },
    generatedAt: new Date().toISOString(),
  };
}

// ── SSP generator ──────────────────────────────────────────────────────────────

async function generateSsp(systemId: string): Promise<unknown> {
  const [findings, fips199, metadata] = await Promise.all([
    fetchNistFindings(),
    readFips199(systemId),
    readSystemMetadata(systemId),
  ]);

  const familyMap  = groupByNistFamily(findings);
  const hubSummary = summarizeByFamily(familyMap);

  // Call 1: system overview
  const overview = await callBedrock(buildSspOverviewPrompt(metadata, fips199, hubSummary));

  // Call 2+: per-family per-control narratives, all families in parallel.
  // Stage A: pre-fill AWS-inherited controls without calling Bedrock.
  // Stage B: chunk remaining controls at 8 per call (prevents 8192-token truncation
  //          on large families like SC which have 40+ controls at Moderate).
  // Parallel execution cuts wall time from ~12 min to ~2-3 min.
  const MAX_CONTROLS_PER_CALL = 8;
  const impactLevel = fips199?.overallImpact ?? 'Moderate';

  // All 20 NIST baseline families — not just families that SecurityHub has findings for.
  // Families with no findings still need narratives (e.g. AT, PE, PS have no Hub findings
  // but are required by the baseline). NIST_BASELINE already includes PM and PT.
  const allFamilies = new Set([...familyMap.keys(), ...Object.keys(NIST_BASELINE)]);

  const familyResults = await Promise.allSettled(
    Array.from(allFamilies).map(family =>
      generateSspFamily(family, familyMap, impactLevel, MAX_CONTROLS_PER_CALL)
    )
  );

  const familyNarratives = familyResults
    .filter((r): r is PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof generateSspFamily>>>> =>
      r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value!);

  familyNarratives.sort((a, b) => a.family.localeCompare(b.family));

  return {
    overview,
    controlFamilies: familyNarratives,
    generatedAt:     new Date().toISOString(),
  };
}

// ── SSP per-family helper (called in parallel by generateSsp) ─────────────────

async function generateSspFamily(
  family: string,
  familyMap: Map<string, { passed: AwsSecurityFinding[]; failed: AwsSecurityFinding[] }>,
  impactLevel: string,
  maxControlsPerCall: number,
): Promise<{ family: string; familyName: string; familyImplementationStatus: string; inheritedControls: string; controls: SspControlEntry[] } | null> {
  const { passed = [], failed = [] } = familyMap.get(family) ?? {};
  const baselineIds = getBaselineControls(family, impactLevel);
  // Use only baseline controls — SecurityHub findings for out-of-baseline controls
  // (e.g. High-only enhancements reported on a Moderate system) inform narratives
  // via the passed/failed arrays below but must not expand the control list.
  const controlIds = baselineIds;
  if (controlIds.length === 0) return null;

  // Stage A: pre-fill fully-inherited controls (PE, MA-3 family) — no Bedrock call
  const preFilledControls: SspControlEntry[] = [];
  const needsBedrockIds: string[] = [];

  for (const id of controlIds) {
    const title = NIST_TITLES[id] ?? id;
    if (AWS_INHERITED_IDS.has(id)) {
      preFilledControls.push({
        controlId:               id,
        title,
        status:                  'inherited',
        origination:             'inherited',
        responsibleEntities:     'Amazon Web Services',
        implementationNarrative: inheritedNarrative(id, title),
        testingEvidence:         'AWS FedRAMP High P-ATO package available in AWS Artifact.',
      });
    } else {
      needsBedrockIds.push(id);
    }
  }

  if (needsBedrockIds.length === 0) {
    return {
      family,
      familyName:                 NIST_FAMILIES[family] ?? family,
      familyImplementationStatus: 'inherited',
      inheritedControls:          preFilledControls.map(c => c.controlId).join(', '),
      controls:                   preFilledControls,
    };
  }

  // Stage B: Bedrock for customer/shared controls, chunked to prevent token overflow
  try {
    const chunks = chunkArray(needsBedrockIds, maxControlsPerCall);
    const chunkResults: Record<string, unknown>[] = [];
    for (const chunk of chunks) {
      const result = await callBedrock(
        buildSspFamilyPrompt(family, chunk, impactLevel, passed, failed),
        8192,
      );
      chunkResults.push(result);
    }
    const merged = chunkResults[0];
    if (chunkResults.length > 1) {
      merged['controls'] = chunkResults.flatMap(r => (r['controls'] as unknown[] | undefined) ?? []);
    }
    const bedrockControls = (merged['controls'] ?? []) as SspControlEntry[];
    return {
      family,
      familyName:                 NIST_FAMILIES[family] ?? family,
      familyImplementationStatus: (merged['familyImplementationStatus'] as string) ?? 'partially_implemented',
      inheritedControls:          (merged['inheritedControls'] as string) ?? 'None',
      controls:                   [...preFilledControls, ...bedrockControls],
    };
  } catch (e: unknown) {
    const fallback: SspControlEntry[] = needsBedrockIds.map(id => ({
      controlId:               id,
      title:                   NIST_TITLES[id] ?? id,
      status:                  failed.some(f => extractControlId(f, family) === id)
                                 ? 'partially_implemented' : 'planned',
      origination:             'sp_system_specific',
      responsibleEntities:     'System Owner',
      implementationNarrative: `See Security Hub findings for ${id}.`,
      testingEvidence:         `Review Security Hub findings for control ${id}.`,
    }));
    console.error(`SSP family ${family} Bedrock failed, using fallback`, (e as Error).message);
    return {
      family,
      familyName:                 NIST_FAMILIES[family] ?? family,
      familyImplementationStatus: 'partially_implemented',
      inheritedControls:          preFilledControls.map(c => c.controlId).join(', ') || 'None',
      controls:                   [...preFilledControls, ...fallback],
    };
  }
}

// ── SAR generator ──────────────────────────────────────────────────────────────

async function generateSar(): Promise<unknown> {
  const findings = await fetchNistFindings();
  const gdFindings = await fetchGuardDutyFindings(5).catch(() => []);

  const severityCounts = countBySeverity(findings);
  const top5 = findings
    .filter(f => f.Severity?.Label === 'CRITICAL' || f.Severity?.Label === 'HIGH')
    .slice(0, 5)
    .map(f => ({ title: f.Title, severity: f.Severity?.Label, resource: f.Resources?.[0]?.Id }));

  const summary = await callBedrock(buildSarSummaryPrompt(severityCounts, top5, gdFindings.length));

  const familyMap = groupByNistFamily(findings);
  const familyAssessments = [];
  for (const [family, { passed: _p, failed }] of familyMap.entries()) {
    if (failed.length === 0) continue;
    try {
      const assessment = await callBedrock(buildSarFamilyPrompt(family, failed));
      familyAssessments.push({ family, familyName: NIST_FAMILIES[family] ?? family, ...assessment });
    } catch {
      familyAssessments.push({
        family,
        familyName:       NIST_FAMILIES[family] ?? family,
        findingsSummary:  `${failed.length} findings require remediation.`,
        riskExposure:     'Review required.',
        recommendations:  'Remediate findings identified in Security Hub.',
      });
    }
  }

  return { summary, familyAssessments, generatedAt: new Date().toISOString() };
}

// ── Risk Assessment generator ──────────────────────────────────────────────────

async function generateRiskAssessment(): Promise<unknown> {
  const [findings, gdFindings, aaFindings] = await Promise.all([
    fetchNistFindings(),
    fetchGuardDutyFindings(10).catch(() => []),
    fetchAccessAnalyzerFindings().catch(() => []),
  ]);

  const severityCounts = countBySeverity(findings);
  const prompt = buildRiskAssessmentPrompt(severityCounts, gdFindings.length, aaFindings.length);
  const report = await callBedrock(prompt);

  return { ...report, generatedAt: new Date().toISOString() };
}

// ── ConMon Plan generator ──────────────────────────────────────────────────────

async function generateConmon(): Promise<unknown> {
  const [standards, findings] = await Promise.all([
    hub.send(new GetEnabledStandardsCommand({})),
    fetchNistFindings(),
  ]);

  let integrations: string[] = [];
  try {
    const hubInfo = await hub.send(new DescribeHubCommand({}));
    integrations = hubInfo.AutoEnableControls ? ['Auto-enabled controls active'] : [];
  } catch { /* DescribeHub may not be available in all regions */ }

  const familyMap     = groupByNistFamily(findings);
  const familyCounts  = [...familyMap.entries()].map(([f, { passed, failed }]) => ({
    family: f, passCount: passed.length, failCount: failed.length,
  }));
  const standardNames = (standards.StandardsSubscriptions ?? []).map(s => s.StandardsArn ?? '');

  const report = await callBedrock(buildConmonPrompt(standardNames, integrations, familyCounts));
  return { ...report, generatedAt: new Date().toISOString() };
}

// ── IRP generator ──────────────────────────────────────────────────────────────

async function generateIrp(systemId: string): Promise<unknown> {
  const [findings, metadata] = await Promise.all([
    fetchNistFindings(),
    readSystemMetadata(systemId),
  ]);

  const incidentFindings = findings
    .filter(f => f.Severity?.Label === 'CRITICAL' || f.Severity?.Label === 'HIGH')
    .slice(0, 15)
    .map(f => ({ title: f.Title, severity: f.Severity?.Label, resource: f.Resources?.[0]?.Id }));

  const report = await callBedrock(buildIrpPrompt(metadata, incidentFindings));
  return { ...report, generatedAt: new Date().toISOString() };
}


// ── Bedrock call + JSON parse ──────────────────────────────────────────────────

async function callBedrock(prompt: string, maxTokens = 8192): Promise<Record<string, unknown>> {
  const response = await bedrock.send(new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  }));

  const rawText  = new TextDecoder().decode(response.body);
  const parsed   = JSON.parse(rawText) as { content?: Array<{ text?: string }> };
  const text     = parsed.content?.[0]?.text ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in Bedrock response');

  try {
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (e: unknown) {
    console.error('Bedrock JSON parse failed. Preview:', text.slice(0, 500));
    throw new Error(`Bedrock returned malformed JSON: ${(e as Error).message}`);
  }
}

const SHARED_PROMPT_RULES = `
CRITICAL: Respond with ONLY a valid JSON object. No markdown fences, no explanation, no text before or after the JSON.

IMPORTANT JSON rules — violations will cause a parse error:
- Use plain prose in all string values.
- No curly braces, no square brackets, no quotes inside strings.
- Write procedural steps in plain English, not as code or CLI commands.
- Arrays must contain only string values or simple objects, never nested arrays.`;

// ── Prompt builders ────────────────────────────────────────────────────────────

function buildPoamPrompt(family: string, passed: AwsSecurityFinding[], failed: AwsSecurityFinding[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const failedSummary = failed.slice(0, 10).map((f, i) => ({
    id:       `${family}-${String(i + 1).padStart(3, '0')}`,
    title:    f.Title ?? 'Untitled',
    severity: f.Severity?.Label ?? 'UNKNOWN',
    resource: f.Resources?.[0]?.Id ?? 'unknown',
    control:  extractControlId(f, family),
  }));

  return `You are a NIST 800-53 compliance expert preparing a POA&M for an AWS environment.

Control family: ${family} - ${NIST_FAMILIES[family] ?? family}
Passing: ${passed.length}, Failing: ${failed.length}

Failing findings:
${JSON.stringify(failedSummary, null, 2)}
${SHARED_PROMPT_RULES}

{
  "riskAssessment": "2-3 sentence risk narrative for the ${family} family",
  "implementationStatement": "2-3 sentence description of current implementation",
  "poamEntries": [
    {
      "poamId": "POAM-${family}-001",
      "affectedControl": "${family}-X",
      "description": "one sentence describing the compliance gap",
      "dateIdentified": "${today}",
      "scheduledCompletionDate": "YYYY-MM-DD",
      "status": "Open",
      "riskRating": "High or Medium or Low",
      "remediationPlan": "2-3 plain English steps"
    }
  ]
}

Rules: one POA&M entry per failing finding (${failedSummary.length} entries). High/Critical → 30 days, Medium → 60 days, Low → 90 days from ${today}.`;
}

function buildSspOverviewPrompt(metadata: SystemMetadata | null, fips199: Fips199Record | null, hubSummary: string): string {
  return `You are a NIST 800-53 compliance expert writing a System Security Plan (SSP) for an AWS system.

System: ${metadata?.systemName ?? 'Unknown System'}
Owner: ${metadata?.ownerName ?? 'Unknown'} (${metadata?.ownerEmail ?? ''})
AWS Account: ${metadata?.awsAccountId ?? 'Unknown'}, Region: ${metadata?.region ?? 'Unknown'}
FIPS 199 Impact: Confidentiality=${fips199?.confidentiality ?? 'Unknown'}, Integrity=${fips199?.integrity ?? 'Unknown'}, Availability=${fips199?.availability ?? 'Unknown'}, Overall=${fips199?.overallImpact ?? 'Unknown'}
Security Hub summary: ${hubSummary}
${SHARED_PROMPT_RULES}

{
  "systemDescription": "2-3 sentences describing the system purpose and scope",
  "systemPurpose": "1-2 sentences on the business purpose",
  "authorizationBoundary": "2-3 sentences describing what is in scope",
  "securityCategorizationRationale": "2-3 sentences justifying the FIPS 199 impact ratings"
}`;
}

function buildSspFamilyPrompt(
  family: string,
  controlIds: string[],
  impactLevel: string,
  passed: AwsSecurityFinding[],
  failed: AwsSecurityFinding[],
): string {
  const failedControlIds = new Set(
    failed.map(f => extractControlId(f, family)).filter(id => !id.endsWith('-?')),
  );
  const failingSample = failed.slice(0, 8).map(f => ({
    controlId: extractControlId(f, family),
    title:     f.Title ?? 'Untitled',
    severity:  f.Severity?.Label ?? 'UNKNOWN',
  }));

  // Build per-control context: title + CRM responsibility + SecurityHub status
  const controlContext = controlIds.map(id => {
    const crm      = getAwsResponsibility(id);
    const title    = NIST_TITLES[id] ?? id;
    const shFailed = failedControlIds.has(id);
    const shPassed = passed.some(f => extractControlId(f, family) === id);
    const shStatus = shFailed ? 'FAILING in SecurityHub' : shPassed ? 'PASSING in SecurityHub' : 'not directly assessed';
    const resp     = crm.responsibility === 'aws'    ? 'AWS (inherited)'
                   : crm.responsibility === 'shared' ? 'Shared (AWS + Customer)'
                   : 'Customer';
    return `  ${id} | ${title} | Responsibility: ${resp} | SecurityHub: ${shStatus}`;
  }).join('\n');

  return `You are writing the ${family} - ${NIST_FAMILIES[family] ?? family} section of a System Security Plan (SSP) per NIST 800-53 Rev 5.

System FIPS 199 impact level: ${impactLevel}
SecurityHub findings — Passing: ${passed.length}, Failing: ${failed.length}
Failing findings sample: ${JSON.stringify(failingSample)}

Controls in scope for this chunk (${controlIds.length} controls):
${controlContext}
${SHARED_PROMPT_RULES}

Produce a JSON object with EXACTLY this structure — one "controls" entry per control ID above:
{
  "familyImplementationStatus": "implemented or partially_implemented or planned",
  "inheritedControls": "comma-separated list of control IDs inherited from AWS, or None",
  "controls": [
    {
      "controlId": "exact ID from the list above",
      "title": "exact NIST 800-53 Rev 5 title as shown above",
      "status": "implemented | partially_implemented | planned | alternative_implementation | not_applicable | inherited | inherited_shared",
      "origination": "sp_system_specific | sp_hybrid | configured_by_customer | provided_by_customer | inherited",
      "responsibleEntities": "who implements this control — e.g. System Owner, AWS, DevOps Team",
      "implementationNarrative": "2-3 sentences describing HOW this specific control is implemented in this AWS environment. For enhancements, focus on the added capability beyond the base control. Reference SecurityHub status where relevant.",
      "testingEvidence": "1 sentence naming a specific artifact, log, or check that confirms this control is working"
    }
  ]
}

Rules:
- Exactly ${controlIds.length} entries in "controls" — one per ID in the list above.
- Controls where Responsibility = "AWS (inherited)": set status="inherited", origination="inherited", responsibleEntities="Amazon Web Services".
- Controls where Responsibility = "Shared": set status="inherited_shared", origination="sp_hybrid", responsibleEntities="AWS (infrastructure) and [System Owner] (configuration)".
- For enhancements like AC-2(1), write a narrative specific to the enhancement requirement, not a repeat of the parent control.
- Base status on SecurityHub: FAILING → not_implemented or partially_implemented. PASSING → implemented. Not assessed → use best judgment.
- Active voice, present tense. No bullet points inside string values.`;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}



function buildSarSummaryPrompt(severityCounts: Record<string, number>, top5: unknown[], gdCount: number): string {
  return `You are writing a Security Assessment Report (SAR) for an AWS environment.

Security Hub findings by severity: ${JSON.stringify(severityCounts)}
GuardDuty findings: ${gdCount}
Top high-severity findings: ${JSON.stringify(top5)}
${SHARED_PROMPT_RULES}

{
  "assessmentScope": "2-3 sentences describing what was assessed",
  "assessmentMethodology": "2-3 sentences on how the assessment was performed (Security Hub, GuardDuty, etc.)",
  "overallRiskPosture": "Low or Moderate or High or Critical",
  "executiveSummary": "3-4 sentences summarizing the overall security posture"
}`;
}

function buildSarFamilyPrompt(family: string, failed: AwsSecurityFinding[]): string {
  const sample = failed.slice(0, 8).map(f => ({ title: f.Title, severity: f.Severity?.Label }));
  return `You are writing a Security Assessment Report (SAR) assessment for the ${family} - ${NIST_FAMILIES[family] ?? family} control family.

Failing findings (${failed.length} total, showing ${sample.length}): ${JSON.stringify(sample)}
${SHARED_PROMPT_RULES}

{
  "findingsSummary": "2 sentences summarizing the findings in this family",
  "riskExposure": "2 sentences on the risk exposure these findings create",
  "recommendations": "2-3 specific recommendations to address the findings"
}`;
}

function buildRiskAssessmentPrompt(severityCounts: Record<string, number>, gdCount: number, aaCount: number): string {
  return `You are a security risk assessor evaluating an AWS environment using NIST 800-30.

Security Hub findings: ${JSON.stringify(severityCounts)}
GuardDuty active findings: ${gdCount}
Access Analyzer external-access findings: ${aaCount}
${SHARED_PROMPT_RULES}

{
  "threatEnvironment": "2-3 sentences describing the current threat environment",
  "vulnerabilitySummary": "2-3 sentences summarizing identified vulnerabilities",
  "likelihoodDetermination": "Low or Moderate or High",
  "impactDetermination": "Low or Moderate or High",
  "overallRiskRating": "Low or Moderate or High or Critical",
  "riskResponseRecommendations": "3-4 specific actions to reduce risk"
}`;
}

function buildConmonPrompt(standardArns: string[], integrations: string[], familyCounts: Array<{ family: string; passCount: number; failCount: number }>): string {
  const highRiskFamilies = familyCounts.filter(f => f.failCount > 5).map(f => f.family);
  const medRiskFamilies  = familyCounts.filter(f => f.failCount >= 1 && f.failCount <= 5).map(f => f.family);
  return `You are writing a Continuous Monitoring (ConMon) Plan for an AWS environment per NIST 800-137.

Enabled Security Hub standards: ${standardArns.join(', ') || 'None detected'}
Active integrations: ${integrations.join(', ') || 'Standard Security Hub'}
High-risk families (>5 failures, monthly monitoring): ${highRiskFamilies.join(', ') || 'None'}
Medium-risk families (1-5 failures, quarterly monitoring): ${medRiskFamilies.join(', ') || 'None'}
${SHARED_PROMPT_RULES}

{
  "monitoringTools": ["tool name and purpose"],
  "monitoringFrequencies": [{ "family": "XX", "frequency": "Monthly or Quarterly or Semi-Annual", "rationale": "reason" }],
  "reportingCadence": "who receives reports and how often",
  "escalationThresholds": "what severity levels trigger immediate escalation",
  "rolesAndResponsibilities": "2-3 sentences on who owns continuous monitoring activities"
}`;
}

function buildIrpPrompt(metadata: SystemMetadata | null, incidentFindings: unknown[]): string {
  return `You are writing an Incident Response Plan (IRP) for an AWS environment per NIST 800-61.

System: ${metadata?.systemName ?? 'Unknown'}, Owner: ${metadata?.ownerName ?? 'Unknown'} (${metadata?.ownerEmail ?? ''})
AWS Region: ${metadata?.region ?? 'Unknown'}
Recent high-severity findings (potential incident indicators): ${JSON.stringify(incidentFindings)}
${SHARED_PROMPT_RULES}

{
  "incidentCategories": ["category name and description"],
  "detectionSources": ["detection source and how it is used"],
  "responseTeam": { "primary": "primary contact role and responsibility", "escalation": "escalation path" },
  "containmentProcedures": "3-4 steps to contain a security incident in AWS",
  "eradicationProcedures": "3-4 steps to eradicate the threat",
  "recoveryProcedures": "3-4 steps to restore normal operations",
  "lessonsLearnedProcess": "2-3 sentences on post-incident review process"
}`;
}

// ── Security Hub helpers ───────────────────────────────────────────────────────

async function fetchNistFindings(): Promise<AwsSecurityFinding[]> {
  const all: AwsSecurityFinding[] = [];
  let nextToken: string | undefined;

  do {
    const res = await hub.send(new GetFindingsCommand({
      Filters: {
        RecordState:    [{ Value: 'ACTIVE',     Comparison: 'EQUALS' }],
        WorkflowStatus: [{ Value: 'SUPPRESSED', Comparison: 'NOT_EQUALS' }],
      },
      MaxResults: 100,
      NextToken:  nextToken,
    }));
    if (res.Findings) all.push(...res.Findings);
    nextToken = res.NextToken;
  } while (nextToken && all.length < 2000);

  return all;
}

function groupByNistFamily(
  findings: AwsSecurityFinding[],
): Map<string, { passed: AwsSecurityFinding[]; failed: AwsSecurityFinding[] }> {
  const map = new Map<string, { passed: AwsSecurityFinding[]; failed: AwsSecurityFinding[] }>();

  for (const f of findings) {
    const families = extractNistFamilies(f);
    const isFailed = f.Compliance?.Status === 'FAILED' || f.Compliance?.Status === 'WARNING';
    for (const family of families) {
      if (!map.has(family)) map.set(family, { passed: [], failed: [] });
      (isFailed ? map.get(family)!.failed : map.get(family)!.passed).push(f);
    }
  }
  return map;
}

function extractNistFamilies(finding: AwsSecurityFinding): string[] {
  const related  = finding.Compliance?.RelatedRequirements ?? [];
  const families = new Set<string>();
  for (const req of related) {
    const match = req.match(/NIST[\s.]800-53[\s.](?:r5|Rev[\s.]?5)?[\s.]?([A-Z]{2})-/i);
    if (match?.[1]) {
      const family = match[1].toUpperCase();
      if (family in NIST_FAMILIES) families.add(family);
    }
  }
  return Array.from(families);
}

function summarizeByFamily(familyMap: Map<string, { passed: AwsSecurityFinding[]; failed: AwsSecurityFinding[] }>): string {
  const parts = [...familyMap.entries()].map(([f, { passed, failed }]) => `${f}: ${passed.length} pass, ${failed.length} fail`);
  return parts.join('; ') || 'No NIST findings found';
}

function countBySeverity(findings: AwsSecurityFinding[]): Record<string, number> {
  const counts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFORMATIONAL: 0 };
  for (const f of findings) {
    const sev = f.Severity?.Label ?? 'INFORMATIONAL';
    counts[sev] = (counts[sev] ?? 0) + 1;
  }
  return counts;
}

function extractControlId(finding: AwsSecurityFinding, family: string): string {
  const related = finding.Compliance?.RelatedRequirements ?? [];
  for (const req of related) {
    const match = req.match(new RegExp(`NIST[.\\s]800-53[.\\s][^\\s]*\\s+(${family}-\\d+)`, 'i'));
    if (match?.[1]) return match[1].toUpperCase();
  }
  return `${family}-?`;
}

function fallbackPoamAssessment(family: string, passed: AwsSecurityFinding[], failed: AwsSecurityFinding[]) {
  const fName = NIST_FAMILIES[family] ?? family;
  const today = new Date().toISOString().slice(0, 10);
  return {
    riskAssessment:          `${failed.length} findings failed in the ${fName} (${family}) family. Manual review required.`,
    implementationStatement: `The ${fName} family has ${passed.length} passing and ${failed.length} failing controls.`,
    poamEntries: failed.slice(0, 10).map((f, i) => ({
      poamId:                   `POAM-${family}-${String(i + 1).padStart(3, '0')}`,
      affectedControl:          extractControlId(f, family),
      description:              f.Title ?? 'No title available',
      dateIdentified:           today,
      scheduledCompletionDate:  futureDate(f.Severity?.Label === 'CRITICAL' || f.Severity?.Label === 'HIGH' ? 30 : 60),
      status:                   'Open',
      riskRating:               f.Severity?.Label === 'CRITICAL' || f.Severity?.Label === 'HIGH' ? 'High' : f.Severity?.Label === 'MEDIUM' ? 'Medium' : 'Low',
      remediationPlan:          f.Remediation?.Recommendation?.Text ?? `Remediate ${f.Title} in your AWS environment.`,
    })),
  };
}

// ── GuardDuty helper ───────────────────────────────────────────────────────────

async function fetchGuardDutyFindings(maxResults: number): Promise<unknown[]> {
  const detectors = await gd.send(new ListDetectorsCommand({}));
  const detectorId = detectors.DetectorIds?.[0];
  if (!detectorId) return [];

  const listRes = await gd.send(new ListFindingsCommand({
    DetectorId: detectorId,
    FindingCriteria: { Criterion: { 'service.archived': { Eq: ['false'] } } },
    MaxResults: maxResults,
  }));

  if (!listRes.FindingIds?.length) return [];

  const getRes = await gd.send(new GdGetFindingsCommand({
    DetectorId: detectorId,
    FindingIds: listRes.FindingIds,
  }));

  return getRes.Findings ?? [];
}

// ── AccessAnalyzer helper ──────────────────────────────────────────────────────

async function fetchAccessAnalyzerFindings(): Promise<unknown[]> {
  const analyzers = await aa.send(new ListAnalyzersCommand({}));
  const analyzerArn = analyzers.analyzers?.[0]?.arn;
  if (!analyzerArn) return [];

  const findings = await aa.send(new AAListFindingsCommand({
    analyzerArn,
    filter: { isPublic: { eq: ['true'] } },
    maxResults: 50,
  }));

  return findings.findings ?? [];
}

// ── DynamoDB helpers ───────────────────────────────────────────────────────────

async function readSystemMetadata(systemId: string): Promise<SystemMetadata | null> {
  const res = await ddb.send(new GetCommand({
    TableName: SYSTEMS_TABLE,
    Key: { pk: `SYSTEM#${systemId}`, sk: 'METADATA' },
  }));
  return (res.Item as SystemMetadata | undefined) ?? null;
}

async function readFips199(systemId: string): Promise<Fips199Record | null> {
  const res = await ddb.send(new GetCommand({
    TableName: SYSTEMS_TABLE,
    Key: { pk: `SYSTEM#${systemId}`, sk: 'DOC#NIST#FIPS199' },
  }));
  return (res.Item as Fips199Record | undefined) ?? null;
}

async function markInProgress(pk: string, sk: string): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName:                 SYSTEMS_TABLE,
      Key:                       { pk, sk },
      ConditionExpression:       '#s = :pending',
      UpdateExpression:          'SET #s = :inprogress, generationStartedAt = :now',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: { ':pending': 'PENDING', ':inprogress': 'IN_PROGRESS', ':now': new Date().toISOString() },
    }));
    return true;
  } catch (e: unknown) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

async function markCompleted(pk: string, sk: string, s3Key: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName:                 SYSTEMS_TABLE,
    Key:                       { pk, sk },
    ConditionExpression:       '#s = :inprogress',
    UpdateExpression:          'SET #s = :completed, s3Key = :key, updatedAt = :now, #err = :null',
    ExpressionAttributeNames:  { '#s': 'status', '#err': 'error' },
    ExpressionAttributeValues: { ':inprogress': 'IN_PROGRESS', ':completed': 'COMPLETED', ':key': s3Key, ':now': new Date().toISOString(), ':null': null },
  })).catch(ignoreConditionalCheckFailed);
}

async function markFailed(pk: string, sk: string, reason: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName:                 SYSTEMS_TABLE,
    Key:                       { pk, sk },
    UpdateExpression:          'SET #s = :failed, #err = :reason, updatedAt = :now',
    ExpressionAttributeNames:  { '#s': 'status', '#err': 'error' },
    ExpressionAttributeValues: { ':failed': 'FAILED', ':reason': reason, ':now': new Date().toISOString() },
  }));
}

function ignoreConditionalCheckFailed(e: unknown): void {
  if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return;
  throw e;
}

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
