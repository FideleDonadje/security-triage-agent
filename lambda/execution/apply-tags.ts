import {
  ResourceGroupsTaggingAPIClient,
  TagResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';
import type { ActionResult } from './enable-logging';

const REGION = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const tagging = new ResourceGroupsTaggingAPIClient({ region: REGION });

/**
 * Applies the analyst-approved tag key-value pairs to the given resource ARN.
 *
 * Uses ResourceGroupsTaggingAPI so it works on any resource type (S3, EC2, Lambda, etc.)
 * without needing service-specific tag APIs.
 *
 * The agent proposes tag values in action_params (inferred from resource name and sibling
 * resource tags). The analyst reviews and approves before this runs.
 *
 * Always appends security-agent audit tags alongside the requested tags.
 *
 * @param resourceArn - full ARN of the resource to tag
 * @param actionParams - JSON string of tag key-value pairs proposed by the agent
 */
export async function applyTags(
  resourceArn: string,
  actionParams: string,
): Promise<ActionResult> {
  // ── Parse action_params ───────────────────────────────────────────────────
  let proposedTags: Record<string, string>;
  try {
    proposedTags = JSON.parse(actionParams);
  } catch {
    return { success: false, message: `Invalid action_params — expected JSON object: ${actionParams}` };
  }

  if (typeof proposedTags !== 'object' || Array.isArray(proposedTags)) {
    return { success: false, message: 'action_params must be a JSON object of tag key-value pairs' };
  }

  // ── Merge with audit tags ─────────────────────────────────────────────────
  const allTags: Record<string, string> = {
    ...proposedTags,
    'security-agent-action': 'tag_resource',
    'security-agent-executed-at': new Date().toISOString(),
  };

  // ── Apply tags ────────────────────────────────────────────────────────────
  const result = await tagging.send(
    new TagResourcesCommand({
      ResourceARNList: [resourceArn],
      Tags: allTags,
    }),
  );

  const failedMap = result.FailedResourcesMap ?? {};
  if (Object.keys(failedMap).length > 0) {
    const reason = Object.values(failedMap)[0]?.ErrorMessage ?? 'unknown error';
    return { success: false, message: `Failed to tag '${resourceArn}': ${reason}` };
  }

  const tagSummary = Object.entries(proposedTags)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

  return {
    success: true,
    message: `Applied tags to '${resourceArn}': ${tagSummary}`,
  };
}
