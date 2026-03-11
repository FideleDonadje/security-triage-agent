import {
  S3Client,
  GetBucketEncryptionCommand,
  PutBucketEncryptionCommand,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  Tag,
} from '@aws-sdk/client-s3';
import type { ActionResult } from './enable-logging';

/**
 * Enables S3 default encryption (SSE-S3 / AES256) on the given bucket.
 *
 * Idempotent: returns success immediately if any encryption is already configured.
 * Appends security-agent tags without overwriting existing tags.
 *
 * SSE-S3 (AES256) is chosen over SSE-KMS because:
 *  - No key management overhead or extra IAM permissions required
 *  - Satisfies CIS AWS Foundations Benchmark control 2.1.1
 *  - Safe for all bucket types including replication targets
 *
 * @param s3 - shared S3 client from the caller
 * @param bucketName - bucket to remediate
 */
export async function enableS3Encryption(
  s3: S3Client,
  bucketName: string,
): Promise<ActionResult> {
  // ── Idempotency check ─────────────────────────────────────────────────────
  try {
    const existing = await s3.send(
      new GetBucketEncryptionCommand({ Bucket: bucketName }),
    );
    if (existing.ServerSideEncryptionConfiguration?.Rules?.length) {
      const algo =
        existing.ServerSideEncryptionConfiguration.Rules[0]
          .ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? 'unknown';
      return {
        success: true,
        message: `Default encryption already enabled on '${bucketName}' (algorithm: ${algo})`,
      };
    }
  } catch (e: unknown) {
    // ServerSideEncryptionConfigurationNotFoundError (HTTP 404) means not configured — proceed
    if ((e as { name?: string }).name !== 'ServerSideEncryptionConfigurationNotFoundError') throw e;
  }

  // ── Enable SSE-S3 (AES256) ────────────────────────────────────────────────
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
            BucketKeyEnabled: false,
          },
        ],
      },
    }),
  );

  // ── Tag the bucket ────────────────────────────────────────────────────────
  await tagBucket(s3, bucketName);

  return {
    success: true,
    message: `Enabled SSE-S3 (AES256) default encryption on '${bucketName}'`,
  };
}

// ── Tagging helper ─────────────────────────────────────────────────────────────

async function tagBucket(s3: S3Client, bucketName: string): Promise<void> {
  let existingTags: Tag[] = [];
  try {
    const result = await s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    existingTags = result.TagSet ?? [];
  } catch (e: unknown) {
    // NoSuchTagSet (HTTP 404) is expected when the bucket has no tags
    if ((e as { name?: string }).name !== 'NoSuchTagSet') throw e;
  }

  const otherTags = existingTags.filter(
    (t) => t.Key !== 'security-agent-action' && t.Key !== 'security-agent-executed-at',
  );

  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: {
        TagSet: [
          ...otherTags,
          { Key: 'security-agent-action', Value: 'enable_s3_encryption' },
          { Key: 'security-agent-executed-at', Value: new Date().toISOString() },
        ],
      },
    }),
  );
}
