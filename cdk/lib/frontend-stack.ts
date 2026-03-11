import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

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
      // Account/region suffix prevents global naming conflicts
      bucketName: `security-triage-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── CloudFront Distribution ────────────────────────────────────────────
    // S3BucketOrigin.withOriginAccessControl automatically creates the OAC
    // and adds the required bucket policy — no manual grantRead needed.
    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      comment: 'Security Triage Agent frontend',
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
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
