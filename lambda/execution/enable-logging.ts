import {
  S3Client,
  GetBucketLoggingCommand,
  PutBucketLoggingCommand,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  Tag,
} from '@aws-sdk/client-s3';

export interface ActionResult {
  success: boolean;
  message: string;
}

/**
 * Enables S3 server access logging on the given bucket.
 *
 * Idempotent: returns success immediately if logging is already configured.
 * Appends security-agent tags without overwriting existing tags.
 *
 * @param s3 - shared S3 client from the caller
 * @param bucketName - bucket to remediate (not the ARN, just the name)
 * @param logTargetBucket - dedicated logging bucket to write access logs to
 */
export async function enableS3Logging(
  s3: S3Client,
  bucketName: string,
  logTargetBucket: string,
): Promise<ActionResult> {
  // ── Idempotency check ─────────────────────────────────────────────────────
  const existing = await s3.send(new GetBucketLoggingCommand({ Bucket: bucketName }));

  if (existing.LoggingEnabled?.TargetBucket) {
    return {
      success: true,
      message: `Access logging already enabled on '${bucketName}' (target: ${existing.LoggingEnabled.TargetBucket}/${existing.LoggingEnabled.TargetPrefix ?? ''})`,
    };
  }

  // ── Enable logging ────────────────────────────────────────────────────────
  await s3.send(
    new PutBucketLoggingCommand({
      Bucket: bucketName,
      BucketLoggingStatus: {
        LoggingEnabled: {
          TargetBucket: logTargetBucket,
          TargetPrefix: `access-logs/${bucketName}/`,
        },
      },
    }),
  );

  // ── Tag the bucket ────────────────────────────────────────────────────────
  await tagBucket(s3, bucketName);

  return {
    success: true,
    message: `Enabled S3 access logging on '${bucketName}'. Logs -> s3://${logTargetBucket}/access-logs/${bucketName}/`,
  };
}

// ── Tagging helper ─────────────────────────────────────────────────────────────

async function tagBucket(s3: S3Client, bucketName: string): Promise<void> {
  // Fetch existing tags (PutBucketTagging replaces the full tag set)
  let existingTags: Tag[] = [];
  try {
    const result = await s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    existingTags = result.TagSet ?? [];
  } catch (e: unknown) {
    // NoSuchTagSet (HTTP 404) is expected when the bucket has no tags
    if ((e as { name?: string }).name !== 'NoSuchTagSet') throw e;
  }

  // Remove any stale security-agent tags before merging
  const otherTags = existingTags.filter(
    (t) => t.Key !== 'security-agent-action' && t.Key !== 'security-agent-executed-at',
  );

  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: {
        TagSet: [
          ...otherTags,
          { Key: 'security-agent-action', Value: 'enable_s3_logging' },
          { Key: 'security-agent-executed-at', Value: new Date().toISOString() },
        ],
      },
    }),
  );
}
