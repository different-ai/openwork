#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ref = (name) => ({ Ref: name });
const sub = (text, vars) => ({ "Fn::Sub": vars ? [text, vars] : text });
const get = (name, attr) => ({ "Fn::GetAtt": [name, attr] });
const join = (parts) => ({ "Fn::Join": ["", parts] });
const splitId = { "Fn::Split": ["-", ref("DeploymentId")] };
const tfName = join(["ow-", { "Fn::Select": [0, splitId] }, { "Fn::Select": [1, splitId] }]);
const roleName = join(["openwork-", { "Fn::Join": ["", splitId] }, "-runner"]);
const runner = readFileSync(fileURLToPath(new URL("bootstrap.py", import.meta.url)), "utf8");
const environment = {
  DEPLOYMENT_ID: ref("DeploymentId"), RUN_ID: ref("RunId"), CHALLENGE: ref("Challenge"),
  EXPECTED_ACCOUNT_ID: ref("ExpectedAccountId"), CONTROL_PLANE_ORIGIN: ref("ControlPlaneOrigin"),
  BUNDLE_URL: ref("BundleUrl"), BUNDLE_SHA256: ref("BundleSha256"), OPENWORK_VERSION: ref("OpenWorkVersion"),
  DOMAIN_NAME: ref("DomainName"), ROUTE53_ZONE_ID: ref("Route53ZoneId"), OWNER_EMAIL: ref("OwnerEmail"),
  STATE_BUCKET: ref("StateBucket"), LOCK_TABLE: ref("StateLock"),
};
const infrastructureActions = [
  "ec2:Describe*", "ec2:CreateVpc", "ec2:ModifyVpcAttribute", "ec2:CreateSubnet", "ec2:ModifySubnetAttribute",
  "ec2:CreateInternetGateway", "ec2:AttachInternetGateway", "ec2:AllocateAddress", "ec2:CreateNatGateway",
  "ec2:CreateRouteTable", "ec2:CreateRoute", "ec2:AssociateRouteTable", "ec2:CreateSecurityGroup",
  "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress",
  "ec2:CreateTags", "ec2:DeleteTags",
  "ecs:CreateCluster", "ecs:Describe*", "ecs:List*", "ecs:RegisterTaskDefinition", "ecs:CreateService", "ecs:UpdateService", "ecs:TagResource",
  "elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:CreateListener",
  "elasticloadbalancing:CreateRule", "elasticloadbalancing:Describe*", "elasticloadbalancing:ModifyLoadBalancerAttributes",
  "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:AddTags", "elasticloadbalancing:RegisterTargets",
  "rds:CreateDBInstance", "rds:CreateDBSubnetGroup", "rds:ModifyDBInstance", "rds:Describe*", "rds:AddTagsToResource", "rds:ListTagsForResource",
  "acm:RequestCertificate", "acm:DescribeCertificate", "acm:AddTagsToCertificate", "acm:ListTagsForCertificate",
  "servicediscovery:CreatePrivateDnsNamespace", "servicediscovery:Get*", "servicediscovery:List*", "servicediscovery:CreateService", "servicediscovery:TagResource",
];
const taskRole = sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${Name}-den-*", { Name: tfName });
const logArn = sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/ecs/${Name}/*", { Name: tfName });
const policy = {
  Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: infrastructureActions, Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": ref("AWS::Region") } } },
    { Effect: "Allow", Action: ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ChangeResourceRecordSets"], Resource: sub("arn:${AWS::Partition}:route53:::hostedzone/${Route53ZoneId}") },
    { Effect: "Allow", Action: "route53:GetChange", Resource: sub("arn:${AWS::Partition}:route53:::change/*") },
    { Effect: "Allow", Action: ["iam:CreateRole", "iam:GetRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:TagRole"], Resource: taskRole },
    { Effect: "Allow", Action: "iam:AttachRolePolicy", Resource: taskRole, Condition: { ArnEquals: { "iam:PolicyARN": sub("arn:${AWS::Partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy") } } },
    { Effect: "Allow", Action: "iam:PassRole", Resource: taskRole, Condition: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } } },
    { Effect: "Allow", Action: "iam:CreateServiceLinkedRole", Resource: sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/aws-service-role/*"), Condition: { StringEquals: { "iam:AWSServiceName": ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "rds.amazonaws.com"] } } },
    { Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:PutRetentionPolicy", "logs:ListTagsLogGroup", "logs:ListTagsForResource", "logs:TagResource"], Resource: [logArn, sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${AWS::StackName}*")] },
    { Effect: "Allow", Action: "logs:DescribeLogGroups", Resource: "*" },
    { Effect: "Allow", Action: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:ListSecretVersionIds", "secretsmanager:TagResource"], Resource: sub("arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${Name}-den-*", { Name: tfName }) },
    { Effect: "Allow", Action: ["s3:ListBucket", "s3:GetBucketLocation"], Resource: get("StateBucket", "Arn") },
    { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: join([get("StateBucket", "Arn"), "/deployments/", ref("DeploymentId"), "/*"]) },
    { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:DescribeTable"], Resource: get("StateLock", "Arn") },
  ],
};
const launcherCode = `import boto3, json, urllib.request\n\ndef handler(event, context):\n    status = "SUCCESS"\n    try:\n        if event["RequestType"] in ("Create", "Update"):\n            boto3.client("codebuild").start_build(projectName=event["ResourceProperties"]["ProjectName"], idempotencyToken=event["RequestId"])\n    except Exception:\n        status = "FAILED"\n    body = json.dumps({"Status": status, "Reason": "See the customer-owned launcher logs", "PhysicalResourceId": event.get("PhysicalResourceId", event["LogicalResourceId"]), "StackId": event["StackId"], "RequestId": event["RequestId"], "LogicalResourceId": event["LogicalResourceId"]}).encode()\n    request = urllib.request.Request(event["ResponseURL"], data=body, method="PUT", headers={"Content-Type": "", "Content-Length": str(len(body))})\n    urllib.request.urlopen(request, timeout=15).close()\n`;
const template = {
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "OpenWork AWS installer. Creates a customer-owned runner and retained encrypted state. The runner provisions billable ECS, RDS, ALB and NAT resources in this dedicated account.",
  Parameters: {
    DeploymentId: { Type: "String", AllowedPattern: "[a-f0-9-]{36}" }, RunId: { Type: "String", AllowedPattern: "[a-f0-9-]{36}" },
    Challenge: { Type: "String", AllowedPattern: "[a-f0-9]{64}" }, ExpectedAccountId: { Type: "String", AllowedPattern: "[0-9]{12}" },
    ControlPlaneOrigin: { Type: "String", AllowedPattern: "https://[a-zA-Z0-9.-]+" },
    BundleUrl: { Type: "String", AllowedPattern: "https://.*" }, BundleSha256: { Type: "String", AllowedPattern: "[a-f0-9]{64}" },
    OpenWorkVersion: { Type: "String" }, DomainName: { Type: "String" }, Route53ZoneId: { Type: "String", AllowedPattern: "Z[A-Z0-9]+" }, OwnerEmail: { Type: "String" },
  },
  Resources: {
    StateBucket: { Type: "AWS::S3::Bucket", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain", Properties: {
      VersioningConfiguration: { Status: "Enabled" }, BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    } },
    StateBucketPolicy: { Type: "AWS::S3::BucketPolicy", Properties: { Bucket: ref("StateBucket"), PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [get("StateBucket", "Arn"), join([get("StateBucket", "Arn"), "/*"])], Condition: { Bool: { "aws:SecureTransport": false } } }] } } },
    StateLock: { Type: "AWS::DynamoDB::Table", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain", Properties: { BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "LockID", AttributeType: "S" }], KeySchema: [{ AttributeName: "LockID", KeyType: "HASH" }], SSESpecification: { SSEEnabled: true } } },
    RunnerRole: { Type: "AWS::IAM::Role", Properties: { RoleName: roleName, AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "codebuild.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": ref("AWS::AccountId") } } }] }, Policies: [{ PolicyName: "ProvisionOpenWork", PolicyDocument: policy }] } },
    Runner: { Type: "AWS::CodeBuild::Project", Properties: {
      Name: sub("${AWS::StackName}-runner"), ServiceRole: get("RunnerRole", "Arn"), ConcurrentBuildLimit: 1, TimeoutInMinutes: 90,
      Artifacts: { Type: "NO_ARTIFACTS" }, Environment: { Type: "LINUX_CONTAINER", ComputeType: "BUILD_GENERAL1_SMALL", Image: "aws/codebuild/standard:7.0", PrivilegedMode: false, EnvironmentVariables: Object.entries(environment).map(([Name, Value]) => ({ Name, Value, Type: "PLAINTEXT" })) },
      Source: { Type: "NO_SOURCE", BuildSpec: JSON.stringify({ version: "0.2", phases: { install: { commands: ["python3 -m pip install --disable-pip-version-check boto3==1.43.110 botocore==1.43.110"] }, build: { commands: ["set -eu", "umask 077", "cat > /tmp/openwork-bootstrap.py <<'OPENWORK_BOOTSTRAP'\n" + runner + "\nOPENWORK_BOOTSTRAP", "python3 /tmp/openwork-bootstrap.py"] } } }) },
      LogsConfig: { CloudWatchLogs: { Status: "ENABLED" } },
    } },
    LauncherRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }, Policies: [{ PolicyName: "LaunchRunner", PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "codebuild:StartBuild", Resource: get("Runner", "Arn") }, { Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${AWS::StackName}*:*") }] } }] } },
    Launcher: { Type: "AWS::Lambda::Function", Properties: { FunctionName: sub("${AWS::StackName}-launcher"), Runtime: "python3.12", Handler: "index.handler", Role: get("LauncherRole", "Arn"), Timeout: 60, Code: { ZipFile: launcherCode } } },
    StartRunner: { Type: "Custom::OpenWorkLaunch", Properties: { ServiceToken: get("Launcher", "Arn"), ProjectName: ref("Runner"), RunId: ref("RunId") } },
  },
  Outputs: { RunnerProject: { Value: ref("Runner") }, StateBucket: { Value: ref("StateBucket") }, LockTable: { Value: ref("StateLock") } },
};
const output = resolve(process.argv[2] ?? "infra/aws-managed/cloudformation.json");
writeFileSync(output, JSON.stringify(template, null, 2) + "\n");
console.log(`Wrote ${output}`);
