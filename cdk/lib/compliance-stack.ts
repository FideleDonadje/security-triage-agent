/**
 * compliance-stack.ts — compliance workspace infrastructure
 *
 * Resources:
 *   - DynamoDB security-triage-systems — systems + documents table (Streams enabled)
 *   - S3 security-triage-compliance-* — versioned reports bucket (7-year retention)
 *   - SQS security-triage-compliance-worker-dlq — dead-letter queue for worker failures
 *   - Lambda security-triage-compliance-worker — async document generator
 *   - Lambda security-triage-compliance-repair — stuck-job detector + DLQ recovery
 *   - EventBridge rule — fires repair Lambda every 5 minutes
 *
 * Cross-stack wiring (via props from SecurityTriageStack):
 *   - apiLambda: grants DynamoDB + S3 permissions, adds env vars for new table/bucket
 *   - cognitoAuthorizer: reused on all new API routes
 *   - api: compliance routes added to existing RestApi
 *
 * ARCHITECTURE RULE: compliance-worker has ZERO write access to AWS resources.
 * It only writes to DynamoDB (document status) and S3 (report content).
 */

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export const SSM_SYSTEMS_TABLE  = '/security-triage/systems-table-name';
export const SSM_COMPLIANCE_BUCKET = '/security-triage/compliance-bucket-name';

const COMPLIANCE_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

export interface ComplianceStackProps extends cdk.StackProps {
  apiLambda:         lambdaNode.NodejsFunction;
  cognitoAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  api:               apigateway.RestApi;
  userPool:          cognito.UserPool;
  frontendUrl?:      string;
}

export class ComplianceStack extends cdk.Stack {
  public readonly systemsTable: dynamodb.Table;
  public readonly complianceBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ComplianceStackProps) {
    super(scope, id, props);

    // ── DynamoDB: security-triage-systems ─────────────────────────────────
    // Single table, composite key: pk=SYSTEM#{id}, sk=METADATA|DOC#NIST#{type}
    this.systemsTable = new dynamodb.Table(this, 'SystemsTable', {
      tableName: 'security-triage-systems',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      stream:       dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      encryption:   dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: (process.env.DEPLOY_ENV ?? 'dev') === 'prod',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI: query all documents by status (used by repair Lambda to find stuck jobs).
    // ALL projection so generationStartedAt is available without a separate GetItem call.
    this.systemsTable.addGlobalSecondaryIndex({
      indexName:       'status-all-index',
      partitionKey:    { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey:         { name: 'sk', type: dynamodb.AttributeType.STRING },
      projectionType:  dynamodb.ProjectionType.ALL,
    });

    // ── S3: compliance reports bucket (versioned) ──────────────────────────
    this.complianceBucket = new s3.Bucket(this, 'ComplianceReportsBucket', {
      bucketName:         `security-triage-compliance-${this.account}-${this.region}`,
      blockPublicAccess:  s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL:         true,
      encryption:         s3.BucketEncryption.S3_MANAGED,
      versioned:          true,
      lifecycleRules: [
        {
          // Non-current versions expire after 90 days
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
        {
          // Current version: move to Glacier after 1 year, hard-delete after 7 years
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(365) },
          ],
          expiration: cdk.Duration.days(365 * 7),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    // ── SQS DLQ for compliance worker ─────────────────────────────────────
    const workerDlq = new sqs.Queue(this, 'ComplianceWorkerDlq', {
      queueName:          'security-triage-compliance-worker-dlq',
      retentionPeriod:    cdk.Duration.days(14),
      visibilityTimeout:  cdk.Duration.seconds(360), // 6× repair Lambda timeout (60s)
      encryption:      sqs.QueueEncryption.SQS_MANAGED,
    });

    // ── CloudWatch log groups ──────────────────────────────────────────────
    const workerLogGroup = new logs.LogGroup(this, 'ComplianceWorkerLogs', {
      logGroupName:  '/aws/lambda/security-triage-compliance-worker',
      retention:     logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const repairLogGroup = new logs.LogGroup(this, 'ComplianceRepairLogs', {
      logGroupName:  '/aws/lambda/security-triage-compliance-repair',
      retention:     logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── IAM: compliance-worker role ────────────────────────────────────────
    const workerRole = new iam.Role(this, 'ComplianceWorkerRole', {
      roleName:    'security-triage-compliance-worker-lambda',
      assumedBy:   new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Compliance worker: reads AWS services, calls Bedrock, writes reports to S3',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    workerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SystemsTableStreamAndReadWrite',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetRecords', 'dynamodb:GetShardIterator',
        'dynamodb:DescribeStream', 'dynamodb:ListStreams',
        'dynamodb:UpdateItem', 'dynamodb:GetItem',
      ],
      resources: [
        this.systemsTable.tableArn,
        `${this.systemsTable.tableArn}/stream/*`,
      ],
    }));

    workerRole.addToPolicy(new iam.PolicyStatement({
      sid:     'ComplianceBucketWrite',
      effect:  iam.Effect.ALLOW,
      actions: ['s3:PutObject'],
      resources: [`${this.complianceBucket.bucketArn}/compliance/*`],
    }));

    workerRole.addToPolicy(new iam.PolicyStatement({
      sid:     'BedrockInvokeModel',
      effect:  iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${COMPLIANCE_MODEL_ID}`,
        `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
      ],
    }));

    workerRole.addToPolicy(new iam.PolicyStatement({
      sid:     'SecurityHubRead',
      effect:  iam.Effect.ALLOW,
      actions: [
        'securityhub:GetFindings',
        'securityhub:GetEnabledStandards',
        'securityhub:DescribeStandardsControls',
        'securityhub:DescribeHub',
      ],
      resources: ['*'],
    }));

    workerRole.addToPolicy(new iam.PolicyStatement({
      sid:     'ConfigRead',
      effect:  iam.Effect.ALLOW,
      actions: [
        'config:DescribeConfigurationRecorders',
        'config:DescribeComplianceByResource',
        'config:ListDiscoveredResources',
      ],
      resources: ['*'],
    }));

    workerRole.addToPolicy(new iam.PolicyStatement({
      sid:     'GuardDutyRead',
      effect:  iam.Effect.ALLOW,
      actions: ['guardduty:ListDetectors', 'guardduty:ListFindings', 'guardduty:GetFindings'],
      resources: ['*'],
    }));

    workerRole.addToPolicy(new iam.PolicyStatement({
      sid:     'IamReadForSsp',
      effect:  iam.Effect.ALLOW,
      actions: ['iam:GetAccountSummary', 'iam:GetCredentialReport', 'iam:GenerateCredentialReport'],
      resources: ['*'],
    }));

    workerRole.addToPolicy(new iam.PolicyStatement({
      sid:     'AccessAnalyzerRead',
      effect:  iam.Effect.ALLOW,
      actions: ['access-analyzer:ListAnalyzers', 'access-analyzer:ListFindings'],
      resources: ['*'],
    }));

    // Defense-in-depth: deny destructive actions
    workerRole.addToPolicy(new iam.PolicyStatement({
      sid:     'DenyDestructive',
      effect:  iam.Effect.DENY,
      actions: [
        's3:DeleteObject', 's3:DeleteBucket', 's3:PutBucketPolicy',
        'dynamodb:DeleteItem', 'dynamodb:DeleteTable',
        'iam:CreateUser', 'iam:AttachUserPolicy', 'iam:PutUserPolicy',
      ],
      resources: ['*'],
    }));

    // ── IAM: compliance-repair role (shared by EventBridge + DLQ triggers) ─
    const repairRole = new iam.Role(this, 'ComplianceRepairRole', {
      roleName:    'security-triage-compliance-repair-lambda',
      assumedBy:   new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Compliance repair: marks stuck/failed jobs as FAILED in DynamoDB',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    repairRole.addToPolicy(new iam.PolicyStatement({
      sid:     'SystemsTableRepair',
      effect:  iam.Effect.ALLOW,
      actions: ['dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:GetItem'],
      resources: [
        this.systemsTable.tableArn,
        `${this.systemsTable.tableArn}/index/*`,
      ],
    }));

    repairRole.addToPolicy(new iam.PolicyStatement({
      sid:     'DlqConsume',
      effect:  iam.Effect.ALLOW,
      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
      resources: [workerDlq.queueArn],
    }));

    // ── Lambda: compliance-worker ──────────────────────────────────────────
    const complianceWorker = new lambdaNode.NodejsFunction(this, 'ComplianceWorkerLambda', {
      functionName: 'security-triage-compliance-worker',
      description:  'Compliance workspace worker: generates SSP, SAR, POA&M, IRP, and other NIST documents via Bedrock',
      runtime:      lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry:        path.join(__dirname, '../../lambda/compliance-worker/index.ts'),
      handler:      'handler',
      role:         workerRole,
      timeout:      cdk.Duration.minutes(15),
      memorySize:   1024,
      logGroup:     workerLogGroup,
      bundling:     { minify: true, sourceMap: true, externalModules: [] },
      environment: {
        SYSTEMS_TABLE_NAME: this.systemsTable.tableName,
        COMPLIANCE_BUCKET:  this.complianceBucket.bucketName,
        REGION:             this.region,
        BEDROCK_MODEL_ID:   COMPLIANCE_MODEL_ID,
      },
    });

    // DynamoDB stream → compliance-worker
    complianceWorker.addEventSource(
      new lambdaEventSources.DynamoEventSource(this.systemsTable, {
        startingPosition:       lambda.StartingPosition.TRIM_HORIZON,
        batchSize:              1,
        bisectBatchOnError:     true,
        retryAttempts:          2,
        onFailure:              new lambdaEventSources.SqsDlq(workerDlq),
        filters: [
          lambda.FilterCriteria.filter({
            dynamodb: {
              NewImage: { status: { S: ['PENDING'] } },
            },
          }),
        ],
      }),
    );

    // ── Lambda: compliance-repair ──────────────────────────────────────────
    const complianceRepair = new lambdaNode.NodejsFunction(this, 'ComplianceRepairLambda', {
      functionName: 'security-triage-compliance-repair',
      description:  'Marks stuck IN_PROGRESS compliance jobs as FAILED. Triggered by EventBridge (5 min) and SQS DLQ.',
      runtime:      lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry:        path.join(__dirname, '../../lambda/compliance-repair/index.ts'),
      handler:      'handler',
      role:         repairRole,
      timeout:      cdk.Duration.seconds(60),
      memorySize:   256,
      logGroup:     repairLogGroup,
      bundling:     { minify: true, sourceMap: true, externalModules: [] },
      environment: {
        SYSTEMS_TABLE_NAME:  this.systemsTable.tableName,
        STATUS_INDEX_NAME:   'status-all-index',
        STUCK_THRESHOLD_MIN: '16',
        REGION:              this.region,
      },
    });

    // SQS DLQ → repair Lambda (failed worker records)
    complianceRepair.addEventSource(
      new lambdaEventSources.SqsEventSource(workerDlq, { batchSize: 10 }),
    );

    // EventBridge rule: every 5 min → repair Lambda (stuck-job detection)
    new events.Rule(this, 'StuckJobDetectorRule', {
      ruleName:    'security-triage-stuck-job-detector',
      description: 'Fires every 5 minutes to mark stuck IN_PROGRESS compliance jobs as FAILED',
      schedule:    events.Schedule.rate(cdk.Duration.minutes(5)),
      targets:     [new targets.LambdaFunction(complianceRepair)],
    });

    // ── API Lambda: grant permissions + env vars (cross-stack) ────────────
    // Use explicit ARN strings (not CDK resource tokens) to avoid a cross-stack
    // circular dependency: ComplianceStack → SecurityTriageStack (via props.apiLambda)
    // would cycle back if we referenced this.systemsTable.tableArn (token from ComplianceStack).
    const tableName  = 'security-triage-systems';
    const bucketName = `security-triage-compliance-${this.account}-${this.region}`;
    props.apiLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
        'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan',
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${tableName}`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${tableName}/index/*`,
      ],
    }));
    props.apiLambda.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['s3:GetObject'],
      resources: [`arn:aws:s3:::${bucketName}/*`],
    }));
    props.apiLambda.addEnvironment('SYSTEMS_TABLE_NAME', tableName);
    props.apiLambda.addEnvironment('COMPLIANCE_BUCKET',  bucketName);

    // ── API Gateway: compliance routes ─────────────────────────────────────
    const complianceIntegration = new apigateway.LambdaIntegration(props.apiLambda, { proxy: true });
    const authOptions: apigateway.MethodOptions = {
      authorizer:        props.cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // CORS preflight is handled globally by the RestApi's defaultCorsPreflightOptions
    // (set in SecurityTriageStack) — no per-resource addCorsPreflight needed here.
    const systemsResource = props.api.root.addResource('systems');
    const systemResource  = systemsResource.addResource('{systemId}');

    systemResource.addMethod('GET', complianceIntegration, authOptions);

    const settingsResource = systemResource.addResource('settings');
    settingsResource.addMethod('PUT', complianceIntegration, authOptions);

    const docsResource  = systemResource.addResource('documents');
    docsResource.addMethod('GET', complianceIntegration, authOptions);

    const fips199Resource = docsResource.addResource('FIPS199');
    fips199Resource.addMethod('PUT', complianceIntegration, authOptions);

    const docTypeResource = docsResource.addResource('{docType}');
    docTypeResource.addMethod('GET', complianceIntegration, authOptions);

    const generateResource = docTypeResource.addResource('generate');
    generateResource.addMethod('POST', complianceIntegration, authOptions);

    // ── Initial system record (written once at deploy time) ────────────────
    const initSystemRecord = new cr.AwsCustomResource(this, 'InitSystemRecord', {
      installLatestAwsSdk: false,
      onCreate: {
        service:    'DynamoDB',
        action:     'putItem',
        parameters: {
          TableName: this.systemsTable.tableName,
          Item: {
            pk:          { S: 'SYSTEM#default' },
            sk:          { S: 'METADATA' },
            systemName:  { S: 'My System' },
            ownerName:   { S: '' },
            ownerEmail:  { S: '' },
            awsAccountId: { S: this.account },
            region:      { S: this.region },
          },
          // Idempotent — never overwrites changes the analyst made in Settings
          ConditionExpression: 'attribute_not_exists(pk)',
        },
        physicalResourceId: cr.PhysicalResourceId.of('InitSystemRecord'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.systemsTable.tableArn],
      }),
    });
    initSystemRecord.node.addDependency(this.systemsTable);

    // ── SSM Parameters ─────────────────────────────────────────────────────
    new ssm.StringParameter(this, 'SsmSystemsTableName', {
      parameterName: SSM_SYSTEMS_TABLE,
      stringValue:   this.systemsTable.tableName,
      description:   'DynamoDB systems table name for the compliance workspace',
    });

    new ssm.StringParameter(this, 'SsmComplianceBucketName', {
      parameterName: SSM_COMPLIANCE_BUCKET,
      stringValue:   this.complianceBucket.bucketName,
      description:   'S3 bucket for compliance reports (versioned)',
    });

    // ── CDK Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SystemsTableName', {
      value:       this.systemsTable.tableName,
      exportName:  'SecurityTriageSystemsTableName',
    });

    new cdk.CfnOutput(this, 'ComplianceBucketName', {
      value:       this.complianceBucket.bucketName,
      exportName:  'SecurityTriageComplianceBucketName',
    });
  }
}
