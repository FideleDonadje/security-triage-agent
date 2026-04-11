/**
 * frontend-stack.ts — React SPA hosting: S3 bucket + CloudFront distribution
 *
 * Deploys the static frontend independently of the core infrastructure stack.
 * Keeping it separate means a frontend-only redeploy (./deploy-frontend.sh)
 * never touches Cognito, DynamoDB, or the API.
 *
 *   S3 bucket   — private, CloudFront-only access via OAC (no public URLs)
 *   CloudFront  — HTTPS-only, TLS 1.2+, SPA routing (403/404 → index.html)
 *
 * The CloudFront URL is written to SSM after deploy so that:
 *   - deploy.sh can read it and pass it to SecurityTriageStack as the Cognito
 *     callback URL (--context frontendUrl=...) without a cross-stack CFN dependency
 *   - deploy-frontend.sh can read bucket name + distribution ID to sync and
 *     invalidate without parsing cdk-outputs.json
 *
 * SSM outputs (read by deploy.sh and deploy-frontend.sh):
 *   /security-triage/cloudfront-url             — https://dXXXX.cloudfront.net
 *   /security-triage/cloudfront-distribution-id — used for cache invalidation
 *   /security-triage/frontend-bucket-name       — target for aws s3 sync
 */

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

// SSM parameter paths — referenced by CI/CD pipelines (s3 sync + cache invalidation)
export const SSM_CLOUDFRONT_URL             = '/security-triage/cloudfront-url';
export const SSM_CLOUDFRONT_DISTRIBUTION_ID = '/security-triage/cloudfront-distribution-id';
export const SSM_FRONTEND_BUCKET_NAME       = '/security-triage/frontend-bucket-name';

// Requires aws-cdk-lib >= 2.116.0 for S3BucketOrigin with OAC support

/**
 * FrontendStack — S3 bucket + CloudFront distribution for the React SPA.
 *
 * Uses OAC (Origin Access Control) to keep the S3 bucket fully private.
 * All traffic is HTTPS-only via CloudFront.
 *
 * NOTE: If you add a WAF for CloudFront, it MUST be deployed to us-east-1.
 * Create a separate CfnWebACL stack in us-east-1 and pass the ARN here.
 */
export class FrontendStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly frontendBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── S3 Bucket (private — CloudFront-only access) ───────────────────────
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      // No explicit bucketName — CDK generates a hash-based name.
      // Avoids embedding the AWS account ID in a publicly visible bucket name.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,  // static SPA — sync --delete replaces all files, old versions add cost
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── CloudFront Distribution ────────────────────────────────────────────
    // S3BucketOrigin.withOriginAccessControl automatically creates the OAC
    // and adds the required bucket policy — no manual grantRead needed.
    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      comment: 'Security Triage Agent frontend',
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // PriceClass_100 covers US, Canada, Europe — sufficient for an internal
      // security tool; avoids paying for South America / Asia / Australia edge nodes
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(this.frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },
      // SPA routing: send all 403/404 back to index.html so React Router handles paths
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // ── SSM Parameters — consumed by CI/CD pipeline ────────────────────────
    // Pipeline steps: aws ssm get-parameter → npm run build → aws s3 sync → cloudfront invalidation
    new ssm.StringParameter(this, 'SsmCloudfrontUrl', {
      parameterName: SSM_CLOUDFRONT_URL,
      stringValue: `https://${this.distribution.distributionDomainName}`,
      description: 'CloudFront URL — used as VITE_APP_URL and Cognito callback URL',
    });

    new ssm.StringParameter(this, 'SsmDistributionId', {
      parameterName: SSM_CLOUDFRONT_DISTRIBUTION_ID,
      stringValue: this.distribution.distributionId,
      description: 'CloudFront distribution ID — used for cache invalidation on deploy',
    });

    new ssm.StringParameter(this, 'SsmFrontendBucketName', {
      parameterName: SSM_FRONTEND_BUCKET_NAME,
      stringValue: this.frontendBucket.bucketName,
      description: 'S3 bucket name — target for aws s3 sync of frontend build output',
    });

    // ── CDK Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'CloudFront URL — use this as the app URL',
      exportName: 'SecurityTriageDistributionUrl',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID — needed for cache invalidation on deploy',
      exportName: 'SecurityTriageDistributionId',
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.frontendBucket.bucketName,
      description: 'S3 bucket name — sync build output here to deploy',
      exportName: 'SecurityTriageFrontendBucketName',
    });
  }
}
