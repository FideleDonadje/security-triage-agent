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
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export class SecurityTriageStack extends cdk.Stack {
  // Exported for sibling stacks
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly taskTable: dynamodb.Table;
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
      },
    });

    // ── DynamoDB Task Table ────────────────────────────────────────────────
    this.taskTable = new dynamodb.Table(this, 'TaskTable', {
      tableName: 'security-triage-tasks',
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Streams required: Execution Lambda filters on status → APPROVED
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
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

    // S3: exactly the two MVP remediation actions + tagging
    executionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3RemediationActionsOnly',
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetBucketLocation',
        's3:GetBucketLogging',
        's3:PutBucketLogging',
        's3:GetEncryptionConfiguration',
        's3:PutEncryptionConfiguration',
        's3:GetBucketTagging',
        's3:PutBucketTagging',
      ],
      resources: ['arn:aws:s3:::*'],
    }));

    // Explicit deny for all other S3 write actions (defense-in-depth)
    executionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DenyAllOtherS3Writes',
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

    // ── Lambda: API Layer (NodejsFunction — esbuild bundles TS) ───────────
    const apiLambda = new lambdaNode.NodejsFunction(this, 'ApiLambda', {
      functionName: 'security-triage-api',
      description: 'REST API handler: validates Cognito JWT, proxies chat to Bedrock Agent, manages task queue CRUD in DynamoDB',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../lambda/api/index.ts'),
      handler: 'handler',
      role: apiLambdaRole,
      timeout: cdk.Duration.seconds(30),
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
        // AGENT_ID and AGENT_ALIAS_ID set after AgentCore deploy
      },
    });

    // ── Lambda: Execution (triggered by DynamoDB stream on APPROVED) ───────
    const executionLambda = new lambdaNode.NodejsFunction(this, 'ExecutionLambda', {
      functionName: 'security-triage-execution',
      description: 'Triggered by DynamoDB stream on APPROVED tasks: enables S3 access logging or S3 default encryption. The only Lambda with S3 write access.',
      runtime: lambda.Runtime.NODEJS_22_X,
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
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Cognito authorizer — every route requires a valid analyst JWT
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'CognitoAuthorizer',
      {
        cognitoUserPools: [this.userPool],
        authorizerName: 'analyst-authorizer',
        identitySource: 'method.request.header.Authorization',
      }
    );

    const authOptions: apigateway.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const lambdaIntegration = new apigateway.LambdaIntegration(apiLambda, {
      proxy: true,
    });

    // POST /chat
    const chatResource = this.api.root.addResource('chat');
    chatResource.addMethod('POST', lambdaIntegration, authOptions);

    // GET /tasks  POST /tasks
    const tasksResource = this.api.root.addResource('tasks');
    tasksResource.addMethod('GET', lambdaIntegration, authOptions);
    tasksResource.addMethod('POST', lambdaIntegration, authOptions);

    // POST /tasks/{task_id}/approve
    // POST /tasks/{task_id}/reject
    const taskResource = tasksResource.addResource('{task_id}');
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
