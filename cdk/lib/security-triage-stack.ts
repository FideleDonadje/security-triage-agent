/**
 * security-triage-stack.ts — core infrastructure: auth, data, API, and remediation
 *
 * The main stack. Deploys everything except the Bedrock Agent (agent-stack.ts)
 * and the CloudFront frontend (frontend-stack.ts). Responsibilities:
 *
 *   Auth
 *     - Cognito User Pool (admin-provisioned accounts, TOTP MFA, SRP auth flow)
 *     - Cognito App Client (browser SPA, no client secret, OAuth code grant)
 *
 *   Data
 *     - DynamoDB table (security-triage-tasks) — task queue with status GSI
 *     - DynamoDB Streams enabled — triggers the Execution Lambda on APPROVED tasks
 *     - S3 bucket for S3 access logs written by the enable_s3_logging action
 *
 *   API
 *     - API Lambda (security-triage-api) — validates Cognito JWTs, proxies chat
 *       to Bedrock Agent, handles task queue CRUD. Uses async self-invocation to
 *       work around API Gateway's 29-second timeout for long Bedrock calls.
 *     - API Gateway REST API with Cognito authorizer on every route
 *     - WAF (REGIONAL) — OWASP core rules, known bad inputs, rate limiting
 *
 *   Remediation
 *     - Execution Lambda (security-triage-execution) — the ONLY Lambda with write
 *       access to AWS resources. Triggered by DynamoDB stream on status=APPROVED.
 *       Implements two actions: enable_s3_logging and tag_resource.
 *
 *   Observability
 *     - CloudWatch log groups for API GW, API Lambda, and Execution Lambda (90-day retention)
 *
 * ARCHITECTURE RULE: the API Lambda and Agent role have ZERO write access to AWS
 * services. Only the Execution Lambda writes to AWS resources, and only when a task
 * has been explicitly APPROVED by the analyst.
 *
 * SSM outputs (read by deploy-frontend.sh and the API Lambda):
 *   /security-triage/user-pool-id        — Cognito User Pool ID
 *   /security-triage/user-pool-client-id — Cognito App Client ID
 *   /security-triage/api-url             — API Gateway invoke URL
 *   /security-triage/cognito-domain      — Cognito hosted UI base URL
 */

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { SSM_AGENT_ID, SSM_AGENT_ALIAS, SSM_REQUIRED_TAG_KEYS } from './agent-stack';
import { Construct } from 'constructs';

// SSM parameter paths — referenced by CI/CD pipelines and sibling stacks
export const SSM_USER_POOL_ID        = '/security-triage/user-pool-id';
export const SSM_USER_POOL_CLIENT_ID = '/security-triage/user-pool-client-id';
export const SSM_API_URL             = '/security-triage/api-url';
export const SSM_COGNITO_DOMAIN      = '/security-triage/cognito-domain';

export interface SecurityTriageStackProps extends cdk.StackProps {
  /**
   * CloudFront distribution URL (e.g. https://dXXXX.cloudfront.net).
   * Used as the Cognito callback URL and API CORS allowed origin.
   * Defaults to localhost only when omitted (local dev).
   */
  frontendUrl?: string;

  /**
   * Cognito hosted UI domain prefix — must be globally unique in the region.
   * Defaults to 'security-triage-ops'. Override via CDK context key
   * `cognitoDomainPrefix` or by passing this prop directly.
   * Do NOT include the AWS account ID — Cognito domain prefixes are public.
   */
  cognitoDomainPrefix?: string;
}

export class SecurityTriageStack extends cdk.Stack {
  // Exported for sibling stacks
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly taskTable: dynamodb.Table;
  public readonly api: apigateway.RestApi;
  public readonly apiLambda: lambdaNode.NodejsFunction;
  public readonly cognitoAuthorizer: apigateway.CognitoUserPoolsAuthorizer;

  constructor(scope: Construct, id: string, props?: SecurityTriageStackProps) {
    super(scope, id, props);

    const frontendUrl = props?.frontendUrl;
    const cognitoDomainPrefix =
      props?.cognitoDomainPrefix ??
      (this.node.tryGetContext('cognitoDomainPrefix') as string | undefined) ??
      'security-triage-ops';
    // Callback URLs: always include localhost for dev; add CloudFront URL when known
    const callbackUrls = ['http://localhost:5173/'];
    const logoutUrls   = ['http://localhost:5173/'];
    if (frontendUrl) {
      callbackUrls.push(`${frontendUrl}/`);
      logoutUrls.push(`${frontendUrl}/`);
    }

    // ── Cognito User Pool ──────────────────────────────────────────────────
    this.userPool = new cognito.UserPool(this, 'AnalystPool', {
      userPoolName: 'security-triage-analysts',
      selfSignUpEnabled: false,         // admin-provisioned accounts only
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true,                      // TOTP only — no SMS
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolDomain = this.userPool.addDomain('CognitoDomain', {
      cognitoDomain: { domainPrefix: cognitoDomainPrefix },
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'AnalystPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'security-triage-spa',
      authFlows: {
        userSrp: true,                  // SRP only — no plaintext password flow
        userPassword: false,
      },
      generateSecret: false,            // browser client — no client secret
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
    });

    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito hosted UI domain — use as VITE_COGNITO_DOMAIN in frontend .env',
      exportName: 'SecurityTriageCognitoDomain',
    });

    // ── DynamoDB Task Table ────────────────────────────────────────────────
    this.taskTable = new dynamodb.Table(this, 'TaskTable', {
      tableName: 'security-triage-tasks',
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Streams required: Execution Lambda filters on status → APPROVED
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      // PITR costs ~$0.20/GB/month — enable in prod, skip in dev
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: (process.env.DEPLOY_ENV ?? 'dev') === 'prod',
      },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',       // auto-removes completed chat records after 2 hours
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI: list tasks by status (get all PENDING / APPROVED)
    this.taskTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── S3 Access Logging Bucket ───────────────────────────────────────────
    // Target for S3 access logs written by the Execution Lambda's enable_s3_logging action.
    // The logging.s3.amazonaws.com service principal needs PutObject to write log files.
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: `security-triage-access-logs-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, // ACLs disabled
      lifecycleRules: [
        { expiration: cdk.Duration.days(90) }, // align with log retention policy
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Allow the S3 logging service to write access logs from any bucket in this account
    accessLogsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowS3LogDelivery',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('logging.s3.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [`${accessLogsBucket.bucketArn}/access-logs/*`],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
    );

    // ── CloudWatch Log Groups (90-day retention) ───────────────────────────
    const apiGwLogGroup = new logs.LogGroup(this, 'ApiGatewayLogs', {
      logGroupName: '/security-triage/api-gateway',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda log groups — pre-created so retention is managed by CDK, not Lambda
    const apiLambdaLogGroup = new logs.LogGroup(this, 'ApiLambdaLogs', {
      logGroupName: '/aws/lambda/security-triage-api',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const executionLambdaLogGroup = new logs.LogGroup(this, 'ExecutionLambdaLogs', {
      logGroupName: '/aws/lambda/security-triage-execution',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── IAM: Execution Lambda Role ─────────────────────────────────────────
    // ARCHITECTURE RULE: this is the ONLY role that writes to AWS resources
    const executionLambdaRole = new iam.Role(this, 'ExecutionLambdaRole', {
      roleName: 'security-triage-execution-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution Lambda - S3 remediation (logging + encryption) only',
    });

    executionLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // DynamoDB: read stream + update task status to EXECUTED / FAILED
    executionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDBStreamAndUpdate',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:UpdateItem',
        'dynamodb:GetRecords',
        'dynamodb:GetShardIterator',
        'dynamodb:DescribeStream',
        'dynamodb:ListStreams',
      ],
      resources: [
        this.taskTable.tableArn,
        `${this.taskTable.tableArn}/stream/*`,
      ],
    }));

    // S3: enable_s3_logging action (read logging config + write + tagging)
    executionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3LoggingActionOnly',
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetBucketLocation',
        's3:GetBucketLogging',
        's3:PutBucketLogging',
        's3:GetBucketTagging',
        's3:PutBucketTagging',
      ],
      resources: ['arn:aws:s3:::*'],
    }));

    // ResourceGroupsTaggingAPI: tag_resource action (applies tags to any resource ARN).
    // tag:TagResources is required, but the Tagging API also delegates to each service's
    // native tag API — so we must grant those too for every supported resource type.
    executionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TagResourceAction',
      effect: iam.Effect.ALLOW,
      actions: [
        'tag:TagResources',
        // Native service permissions required by TagResources (S3 covered by S3LoggingActionOnly)
        'lambda:TagResource',
        'ec2:CreateTags',
        'rds:AddTagsToResource',
      ],
      resources: ['*'],
    }));

    // SSM: read required tag keys at cold start
    executionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmReadRequiredTagKeys',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_REQUIRED_TAG_KEYS}`,
      ],
    }));

    // Explicit deny for destructive S3 actions (defense-in-depth)
    executionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DenyDestructiveS3Writes',
      effect: iam.Effect.DENY,
      actions: [
        's3:DeleteBucket',
        's3:DeleteObject',
        's3:PutBucketPolicy',
        's3:PutBucketAcl',
      ],
      resources: ['*'],
    }));

    // ── IAM: API Lambda Role ───────────────────────────────────────────────
    // ARCHITECTURE RULE: no write to any AWS service except DynamoDB
    const apiLambdaRole = new iam.Role(this, 'ApiLambdaRole', {
      roleName: 'security-triage-api-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'API Lambda - JWT validation, DynamoDB CRUD, AgentCore proxy',
    });

    apiLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // DynamoDB: task queue CRUD (no stream access — that belongs to execution role)
    apiLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDBTaskCRUD',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        this.taskTable.tableArn,
        `${this.taskTable.tableArn}/index/*`,
      ],
    }));

    // Bedrock: invoke AgentCore agent — ARN pattern updated post-deploy
    apiLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockAgentCoreInvoke',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeAgent',
        'bedrock:InvokeAgentWithResponseStream',
      ],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:agent/*`,
        `arn:aws:bedrock:${this.region}:${this.account}:agent-alias/*/*`,
      ],
    }));

    // SSM: read agent ID and alias ID written by AgentStack after deploy
    apiLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmReadAgentConfig',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_AGENT_ID}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_AGENT_ALIAS}`,
      ],
    }));

    // ── Lambda: API Layer (NodejsFunction — esbuild bundles TS) ───────────
    this.apiLambda = new lambdaNode.NodejsFunction(this, 'ApiLambda', {
      functionName: 'security-triage-api',
      description: 'REST API handler: validates Cognito JWT, proxies chat to Bedrock Agent, manages task queue CRUD in DynamoDB',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../lambda/api/index.ts'),
      handler: 'handler',
      role: apiLambdaRole,
      // 5-minute timeout supports async worker invocations (Bedrock multi-tool calls).
      // For API GW-triggered paths the 29-second gateway limit applies regardless.
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: apiLambdaLogGroup,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],            // bundle everything; Lambda has no deps
      },
      environment: {
        TABLE_NAME: this.taskTable.tableName,
        STATUS_INDEX_NAME: 'status-index',
        USER_POOL_ID: this.userPool.userPoolId,
        USER_POOL_CLIENT_ID: this.userPoolClient.userPoolClientId,
        REGION: this.region,
        // Agent IDs are written to SSM by AgentStack and read at Lambda cold start
        AGENT_ID_PARAM: SSM_AGENT_ID,
        AGENT_ALIAS_ID_PARAM: SSM_AGENT_ALIAS,
        // CORS: restrict to CloudFront URL; falls back to * for local dev
        ALLOWED_ORIGIN: frontendUrl ?? '*',
        // Used by handleChat to invoke itself asynchronously
        FUNCTION_NAME: 'security-triage-api',
      },
    });

    // Allow the API Lambda to invoke itself asynchronously for long-running Bedrock calls
    apiLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SelfInvokeAsync',
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:security-triage-api`],
    }));

    // ── Lambda: Execution (triggered by DynamoDB stream on APPROVED) ───────
    const executionLambda = new lambdaNode.NodejsFunction(this, 'ExecutionLambda', {
      functionName: 'security-triage-execution',
      description: 'Triggered by DynamoDB stream on APPROVED tasks: enables S3 access logging or applies resource tags. The only Lambda with write access to AWS resources.',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../lambda/execution/index.ts'),
      handler: 'handler',
      role: executionLambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      logGroup: executionLambdaLogGroup,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
      environment: {
        TABLE_NAME: this.taskTable.tableName,
        LOGGING_BUCKET: accessLogsBucket.bucketName,
        REGION: this.region,
        REQUIRED_TAG_KEYS_PARAM: SSM_REQUIRED_TAG_KEYS,
      },
    });

    // DynamoDB stream → Execution Lambda
    // Filter: only fire when status is set to APPROVED
    executionLambda.addEventSource(
      new lambdaEventSources.DynamoEventSource(this.taskTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 1,                   // one task at a time — safer for remediation
        bisectBatchOnError: true,
        retryAttempts: 3,
        filters: [
          lambda.FilterCriteria.filter({
            dynamodb: {
              NewImage: {
                status: { S: ['APPROVED'] },
              },
            },
          }),
        ],
      })
    );

    // ── API Gateway ────────────────────────────────────────────────────────
    this.api = new apigateway.RestApi(this, 'SecurityTriageApi', {
      restApiName: 'security-triage-api',
      description: 'Security Triage Agent REST API',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(apiGwLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS, // tighten to CloudFront URL post-deploy
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Cognito authorizer — every route requires a valid analyst JWT
    this.cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'CognitoAuthorizer',
      {
        cognitoUserPools: [this.userPool],
        authorizerName: 'analyst-authorizer',
        identitySource: 'method.request.header.Authorization',
      }
    );

    const authOptions: apigateway.MethodOptions = {
      authorizer: this.cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const lambdaIntegration = new apigateway.LambdaIntegration(this.apiLambda, {
      proxy: true,
    });

    // POST /chat  (returns 202 immediately — starts async worker)
    // GET  /chat/result/{request_id}  (poll for result)
    const chatResource = this.api.root.addResource('chat');
    chatResource.addMethod('POST', lambdaIntegration, authOptions);
    chatResource.addResource('result').addResource('{request_id}')
      .addMethod('GET', lambdaIntegration, authOptions);

    // GET /tasks  POST /tasks
    const tasksResource = this.api.root.addResource('tasks');
    tasksResource.addMethod('GET', lambdaIntegration, authOptions);
    tasksResource.addMethod('POST', lambdaIntegration, authOptions);

    // POST /tasks/{task_id}/approve
    // POST /tasks/{task_id}/reject
    const taskResource = tasksResource.addResource('{task_id}');
    taskResource.addMethod('DELETE', lambdaIntegration, authOptions);   // dismiss FAILED/REJECTED
    taskResource.addResource('approve').addMethod('POST', lambdaIntegration, authOptions);
    taskResource.addResource('reject').addMethod('POST', lambdaIntegration, authOptions);

    // ── WAF — REGIONAL (API Gateway) ──────────────────────────────────────
    const wafWebAcl = new wafv2.CfnWebACL(this, 'ApiWaf', {
      name: 'security-triage-api-waf',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'SecurityTriageApiWaf',
        sampledRequestsEnabled: true,
      },
      rules: [
        // AWS managed: OWASP core rule set
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 10,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        // AWS managed: known bad inputs (Log4Shell, SSRF, etc.)
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 20,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputs',
            sampledRequestsEnabled: true,
          },
        },
        // Rate limit: 500 requests per 5-minute window per IP
        {
          name: 'RateLimitPerIp',
          priority: 30,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 500,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitPerIp',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate WAF with the API Gateway prod stage
    const wafAssociation = new wafv2.CfnWebACLAssociation(this, 'ApiWafAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.api.restApiId}/stages/${this.api.deploymentStage.stageName}`,
      webAclArn: wafWebAcl.attrArn,
    });
    // Ensure API is deployed before WAF association
    wafAssociation.addDependency(wafWebAcl);

    // ── ATO Assist — DynamoDB jobs table, S3 reports bucket, two Lambdas ─────
    //
    // The model ID must match what the worker is permitted to call via IAM.
    // Keep in sync with FOUNDATION_MODEL in agent-stack.ts.
    const ATO_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

    // Log groups — pre-created so retention is CDK-managed, not Lambda-auto-created
    const atoTriggerLogGroup = new logs.LogGroup(this, 'AtoTriggerLogs', {
      logGroupName: '/aws/lambda/security-triage-ato-trigger',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const atoWorkerLogGroup = new logs.LogGroup(this, 'AtoWorkerLogs', {
      logGroupName: '/aws/lambda/security-triage-ato-worker',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // AtoJobsTable — job lifecycle tracking (PENDING → IN_PROGRESS → COMPLETED/FAILED)
    const atoJobsTable = new dynamodb.Table(this, 'AtoJobsTable', {
      tableName: 'security-triage-ato-jobs',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Stream triggers the ato-worker Lambda on INSERT (new job created)
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'ttl',   // job records expire after 7 years (set by ato-trigger Lambda)
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      // PITR conditional — same policy as the task table
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: (process.env.DEPLOY_ENV ?? 'dev') === 'prod',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI: list all jobs for a specific analyst, newest first
    atoJobsTable.addGlobalSecondaryIndex({
      indexName: 'username-index',
      partitionKey: { name: 'username', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'startTime', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // AtoReportsBucket — stores generated JSON reports, accessed via presigned URLs
    const atoReportsBucket = new s3.Bucket(this, 'AtoReportsBucket', {
      bucketName: `security-triage-ato-reports-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          // POA&M reports are compliance artifacts — keep in S3 for 7 years.
          // Move to Glacier after 1 year (infrequent access after audit closes).
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(365) },
          ],
          expiration: cdk.Duration.days(365 * 7), // hard delete after 7 years
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // CORS required so the browser can fetch the presigned URL directly from S3.
      // Presigned URLs are already time-limited and IAM-signed — wildcard origin is safe here.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    // ── IAM: ATO Trigger Lambda role ──────────────────────────────────────────
    const atoTriggerRole = new iam.Role(this, 'AtoTriggerRole', {
      roleName: 'security-triage-ato-trigger-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'ATO Trigger Lambda: creates job records and generates presigned report URLs',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    atoTriggerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AtoTriggerSecurityHubRead',
      effect: iam.Effect.ALLOW,
      actions: [
        'securityhub:GetEnabledStandards',
        'securityhub:DescribeStandards',
      ],
      resources: ['*'],
    }));

    atoTriggerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AtoJobsTableReadWrite',
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:Query'],
      resources: [atoJobsTable.tableArn, `${atoJobsTable.tableArn}/index/*`],
    }));

    // GetObject needed to generate presigned URLs (the URL is signed with the Lambda role)
    atoTriggerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AtoReportsBucketPresign',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${atoReportsBucket.bucketArn}/ato-reports/*`],
    }));

    // ── IAM: ATO Worker Lambda role ───────────────────────────────────────────
    const atoWorkerRole = new iam.Role(this, 'AtoWorkerRole', {
      roleName: 'security-triage-ato-worker-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'ATO Worker Lambda: reads SecurityHub, calls Bedrock, writes report to S3',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    atoWorkerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AtoJobsTableStream',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetRecords',
        'dynamodb:GetShardIterator',
        'dynamodb:DescribeStream',
        'dynamodb:ListStreams',
      ],
      resources: [`${atoJobsTable.tableArn}/stream/*`],
    }));

    atoWorkerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AtoJobsTableUpdate',
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:UpdateItem'],
      resources: [atoJobsTable.tableArn],
    }));

    atoWorkerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SecurityHubReadForAto',
      effect: iam.Effect.ALLOW,
      actions: [
        'securityhub:GetFindings',
        'securityhub:GetEnabledStandards',
        'securityhub:DescribeStandardsControls',
      ],
      resources: ['*'],
    }));

    atoWorkerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvokeModelForAto',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${ATO_MODEL_ID}`,
        `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
      ],
    }));

    atoWorkerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AtoReportsBucketWrite',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject'],
      resources: [`${atoReportsBucket.bucketArn}/ato-reports/*`],
    }));

    // ── Lambda: ATO Trigger (API handler) ─────────────────────────────────────
    const atoTriggerLambda = new lambdaNode.NodejsFunction(this, 'AtoTriggerLambda', {
      functionName: 'security-triage-ato-trigger',
      description: 'ATO Assist API: POST /ato/generate creates job, GET /ato/status/{jobId} polls status and returns presigned S3 URL when complete',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../lambda/ato-trigger/index.ts'),
      handler: 'handler',
      role: atoTriggerRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: atoTriggerLogGroup,
      bundling: { minify: true, sourceMap: true, externalModules: [] },
      environment: {
        JOBS_TABLE_NAME:      atoJobsTable.tableName,
        JOBS_USERNAME_INDEX:  'username-index',
        REPORTS_BUCKET:       atoReportsBucket.bucketName,
        REGION:               this.region,
        USER_POOL_ID:         this.userPool.userPoolId,
        USER_POOL_CLIENT_ID:  this.userPoolClient.userPoolClientId,
        ALLOWED_ORIGIN:       frontendUrl ?? '*',
      },
    });

    // ── Lambda: ATO Worker (background processor) ─────────────────────────────
    // Larger timeout and memory — makes sequential Bedrock calls per NIST family
    const atoWorkerLambda = new lambdaNode.NodejsFunction(this, 'AtoWorkerLambda', {
      functionName: 'security-triage-ato-worker',
      description: 'ATO Assist worker: triggered by DynamoDB stream on new job. Fetches SecurityHub findings, generates NIST 800-53 narratives via Bedrock, writes JSON report to S3.',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../lambda/ato-worker/index.ts'),
      handler: 'handler',
      role: atoWorkerRole,
      timeout: cdk.Duration.minutes(10),   // up to 18 NIST families × Bedrock latency
      memorySize: 1024,
      logGroup: atoWorkerLogGroup,
      bundling: { minify: true, sourceMap: true, externalModules: [] },
      environment: {
        JOBS_TABLE_NAME:   atoJobsTable.tableName,
        REPORTS_BUCKET:    atoReportsBucket.bucketName,
        REGION:            this.region,
        BEDROCK_MODEL_ID:  ATO_MODEL_ID,
      },
    });

    // DynamoDB stream → ATO Worker (filter: INSERT only, one job at a time)
    atoWorkerLambda.addEventSource(
      new lambdaEventSources.DynamoEventSource(atoJobsTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 1,
        bisectBatchOnError: true,
        retryAttempts: 2,
        filters: [
          lambda.FilterCriteria.filter({
            dynamodb: {
              NewImage: { status: { S: ['PENDING'] } },
            },
          }),
        ],
      }),
    );

    // ── API Gateway routes for ATO Assist ────────────────────────────────────
    // Reuses the existing Cognito authorizer and prod stage — separate Lambda integration
    const atoTriggerIntegration = new apigateway.LambdaIntegration(atoTriggerLambda, { proxy: true });
    const atoResource = this.api.root.addResource('ato');
    atoResource.addResource('standards')
      .addMethod('GET', atoTriggerIntegration, authOptions);
    atoResource.addResource('jobs')
      .addMethod('GET', atoTriggerIntegration, authOptions);
    atoResource.addResource('generate')
      .addMethod('POST', atoTriggerIntegration, authOptions);
    atoResource.addResource('status').addResource('{jobId}')
      .addMethod('GET', atoTriggerIntegration, authOptions);

    // ── SSM Parameters — consumed by CI/CD pipelines and the frontend build ──
    new ssm.StringParameter(this, 'SsmUserPoolId', {
      parameterName: SSM_USER_POOL_ID,
      stringValue: this.userPool.userPoolId,
      description: 'Cognito User Pool ID — used as VITE_USER_POOL_ID in frontend build',
    });

    new ssm.StringParameter(this, 'SsmUserPoolClientId', {
      parameterName: SSM_USER_POOL_CLIENT_ID,
      stringValue: this.userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID — used as VITE_USER_POOL_CLIENT_ID in frontend build',
    });

    new ssm.StringParameter(this, 'SsmApiUrl', {
      parameterName: SSM_API_URL,
      stringValue: this.api.url,
      description: 'API Gateway URL (prod stage) — used as VITE_API_URL in frontend build',
    });

    // Store domain only (no https://) — auth.ts prepends the protocol itself.
    new ssm.StringParameter(this, 'SsmCognitoDomain', {
      parameterName: SSM_COGNITO_DOMAIN,
      stringValue: `${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito hosted UI domain (no protocol) — auth.ts prepends https://',
    });

    // ── CDK Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID - set as USER_POOL_ID env var',
      exportName: 'SecurityTriageUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID - set as USER_POOL_CLIENT_ID env var',
      exportName: 'SecurityTriageUserPoolClientId',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway URL (prod stage)',
      exportName: 'SecurityTriageApiUrl',
    });

    new cdk.CfnOutput(this, 'TaskTableName', {
      value: this.taskTable.tableName,
      description: 'DynamoDB task table name',
      exportName: 'SecurityTriageTaskTableName',
    });

    new cdk.CfnOutput(this, 'TaskTableArn', {
      value: this.taskTable.tableArn,
      description: 'DynamoDB task table ARN',
      exportName: 'SecurityTriageTaskTableArn',
    });

    new cdk.CfnOutput(this, 'WafWebAclArn', {
      value: wafWebAcl.attrArn,
      description: 'WAF WebACL ARN (REGIONAL - for API Gateway)',
      exportName: 'SecurityTriageWafWebAclArn',
    });

    new cdk.CfnOutput(this, 'AccessLogsBucketName', {
      value: accessLogsBucket.bucketName,
      description: 'S3 bucket that receives access logs from remediated buckets',
      exportName: 'SecurityTriageAccessLogsBucket',
    });
  }
}
