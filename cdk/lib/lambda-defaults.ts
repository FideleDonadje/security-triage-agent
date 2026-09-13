/**
 * lambda-defaults.ts — shared CDK defaults used by every stack in this app.
 *
 * Every NodejsFunction bundling block and every CloudWatch log group in this
 * project use the exact same settings. Kept in one place so a policy change
 * (retention period, bundling options) doesn't need updating in 7+ call sites.
 */
import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

/** Every NodejsFunction in this app bundles everything with esbuild — no external deps. */
export const STANDARD_BUNDLING: BundlingOptions = {
  minify: true,
  sourceMap: true,
  externalModules: [],
};

/**
 * Creates a CloudWatch log group with this app's standard policy: 90-day retention,
 * destroyed on stack teardown (dev tier — not a durable audit trail requirement),
 * KMS encryption deferred to a prod tier (documented for Checkov's CKV_AWS_158).
 */
export function createLogGroup(scope: Construct, id: string, logGroupName: string): logs.LogGroup {
  const logGroup = new logs.LogGroup(scope, id, {
    logGroupName,
    retention: logs.RetentionDays.THREE_MONTHS,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  (logGroup.node.defaultChild as logs.CfnLogGroup).addMetadata('checkov', {
    skip: [{ id: 'CKV_AWS_158', comment: 'KMS encryption on logs deferred to prod tier' }],
  });
  return logGroup;
}
