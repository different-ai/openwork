#!/usr/bin/env node
// Generates the CloudFormation bootstrap a customer approves in their AWS
// console. It creates only the installer: a customer-owned CodeBuild runner,
// its role, and retained encrypted Terraform state. Terraform does the install.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ref = (name) => ({ Ref: name });
const sub = (text, vars) => ({ "Fn::Sub": vars ? [text, vars] : text });
const get = (name, attr) => ({ "Fn::GetAtt": [name, attr] });
const join = (parts) => ({ "Fn::Join": ["", parts] });
const splitId = { "Fn::Split": ["-", ref("DeploymentId")] };
const compactId = { "Fn::Join": ["", splitId] };
// Must match contract/main.tf: name = "ow-" + first 12 hex digits of the id.
const tfName = join(["ow-", { "Fn::Select": [0, splitId] }, { "Fn::Select": [1, splitId] }]);
const runnerRoleName = join(["openwork-", compactId, "-runner"]);
const healthName = join(["openwork-", compactId, "-health"]);
const bootstrap = readFileSync(fileURLToPath(new URL("bootstrap.py", import.meta.url)), "utf8");
const environment = {
  DEPLOYMENT_ID: ref("DeploymentId"), RUN_ID: ref("RunId"), CHALLENGE: ref("Challenge"),
  EXPECTED_ACCOUNT_ID: ref("ExpectedAccountId"), CONTROL_PLANE_ORIGIN: ref("ControlPlaneOrigin"),
  BUNDLE_URL: ref("BundleUrl"), BUNDLE_SHA256: ref("BundleSha256"), OPENWORK_VERSION: ref("OpenWorkVersion"),
  DOMAIN_NAME: ref("DomainName"), ROUTE53_ZONE_ID: ref("Route53ZoneId"), OWNER_EMAIL: ref("OwnerEmail"),
  SIZE: ref("Size"), STATE_BUCKET: ref("StateBucket"),
};
// Pass only the names a pattern uses, keeping the template small and readable.
const names = (text) => Object.fromEntries([["Name", tfName], ["Health", healthName]].filter(([key]) => text.includes(`\${${key}}`)));
const arn = (service, resource) => sub(`arn:\${AWS::Partition}:${service}:\${AWS::Region}:\${AWS::AccountId}:${resource}`, names(resource));
const iamRole = (pattern) => sub(`arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/${pattern}`, names(pattern));

// Create, read and update the deployment's networking, containers, database,
// load balancer and certificate. Many of these AWS create/describe APIs do not
// support resource-level permissions; the account is dedicated to OpenWork and
// requests are limited to the selected region. There are no delete actions
// except deregistering superseded task definitions during updates.
const infrastructureActions = [
  "ec2:Describe*", "ec2:CreateVpc", "ec2:ModifyVpcAttribute", "ec2:CreateSubnet", "ec2:ModifySubnetAttribute",
  "ec2:CreateInternetGateway", "ec2:AttachInternetGateway", "ec2:AllocateAddress", "ec2:CreateNatGateway",
  "ec2:CreateRouteTable", "ec2:CreateRoute", "ec2:ReplaceRoute", "ec2:AssociateRouteTable", "ec2:CreateSecurityGroup",
  "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress",
  "ec2:ModifySecurityGroupRules", "ec2:UpdateSecurityGroupRuleDescriptionsIngress", "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
  "ec2:CreateTags",
  "ecs:CreateCluster", "ecs:UpdateCluster", "ecs:PutClusterCapacityProviders", "ecs:Describe*", "ecs:List*", "ecs:RegisterTaskDefinition",
  "ecs:DeregisterTaskDefinition", "ecs:CreateService", "ecs:UpdateService", "ecs:TagResource",
  "elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:CreateListener",
  "elasticloadbalancing:CreateRule", "elasticloadbalancing:Describe*", "elasticloadbalancing:ModifyLoadBalancerAttributes",
  "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:ModifyListener",
  "elasticloadbalancing:ModifyListenerAttributes", "elasticloadbalancing:ModifyRule", "elasticloadbalancing:AddTags",
  "elasticloadbalancing:SetSecurityGroups", "elasticloadbalancing:RegisterTargets",
  "rds:CreateDBInstance", "rds:CreateDBSubnetGroup", "rds:ModifyDBInstance", "rds:ModifyDBSubnetGroup", "rds:Describe*",
  "rds:AddTagsToResource", "rds:ListTagsForResource",
  "acm:RequestCertificate", "acm:DescribeCertificate", "acm:AddTagsToCertificate", "acm:ListTagsForCertificate",
  "servicediscovery:CreatePrivateDnsNamespace", "servicediscovery:Get*", "servicediscovery:List*", "servicediscovery:CreateService",
  "servicediscovery:UpdateService", "servicediscovery:TagResource",
  "events:DescribeRule", "events:ListTargetsByRule", "events:ListTagsForResource",
];
const policy = {
  Version: "2012-10-17", Statement: [
    { Sid: "Infrastructure", Effect: "Allow", Action: infrastructureActions, Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": ref("AWS::Region") } } },
    { Sid: "DeploymentDns", Effect: "Allow", Action: ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ChangeResourceRecordSets", "route53:ListTagsForResource"], Resource: sub("arn:${AWS::Partition}:route53:::hostedzone/${Route53ZoneId}") },
    { Sid: "DnsChanges", Effect: "Allow", Action: "route53:GetChange", Resource: sub("arn:${AWS::Partition}:route53:::change/*") },
    // Cloud Map creates and reads a private hosted zone for the new VPC.
    { Sid: "ServiceDiscoveryZone", Effect: "Allow", Action: ["route53:CreateHostedZone", "route53:GetHostedZone", "route53:ListHostedZonesByName"], Resource: "*" },
    { Sid: "ServiceRoles", Effect: "Allow", Action: ["iam:CreateRole", "iam:GetRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:TagRole", "iam:UpdateAssumeRolePolicy"], Resource: [iamRole("${Name}-den-*"), iamRole("${Health}")] },
    { Sid: "ExecutionPolicy", Effect: "Allow", Action: "iam:AttachRolePolicy", Resource: iamRole("${Name}-den-*"), Condition: { ArnEquals: { "iam:PolicyARN": sub("arn:${AWS::Partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy") } } },
    { Sid: "PassTaskRoles", Effect: "Allow", Action: "iam:PassRole", Resource: iamRole("${Name}-den-*"), Condition: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } } },
    { Sid: "PassHealthRole", Effect: "Allow", Action: "iam:PassRole", Resource: iamRole("${Health}"), Condition: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } } },
    { Sid: "ServiceLinkedRoles", Effect: "Allow", Action: "iam:CreateServiceLinkedRole", Resource: sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/aws-service-role/*"), Condition: { StringEquals: { "iam:AWSServiceName": ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "rds.amazonaws.com"] } } },
    { Sid: "HealthAgent", Effect: "Allow", Action: ["lambda:CreateFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:ListVersionsByFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:AddPermission", "lambda:GetPolicy", "lambda:TagResource", "lambda:ListTags", "lambda:InvokeFunction"], Resource: arn("lambda", "function:${Health}") },
    { Sid: "HealthSchedule", Effect: "Allow", Action: ["events:PutRule", "events:PutTargets", "events:TagResource"], Resource: arn("events", "rule/${Health}") },
    { Sid: "Logs", Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:PutRetentionPolicy", "logs:ListTagsLogGroup", "logs:ListTagsForResource", "logs:TagResource", "logs:TagLogGroup"], Resource: [arn("logs", "log-group:/ecs/${Name}/*"), arn("logs", "log-group:/aws/lambda/${Health}"), arn("logs", "log-group:/aws/lambda/${Health}:*"), sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${AWS::StackName}*")] },
    { Sid: "ListLogs", Effect: "Allow", Action: "logs:DescribeLogGroups", Resource: "*" },
    { Sid: "AppSecrets", Effect: "Allow", Action: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:ListSecretVersionIds", "secretsmanager:GetResourcePolicy", "secretsmanager:TagResource"], Resource: arn("secretsmanager", "secret:${Name}-den-*") },
    { Sid: "StateBucket", Effect: "Allow", Action: ["s3:ListBucket", "s3:GetBucketLocation"], Resource: get("StateBucket", "Arn") },
    // State and its S3-native lock file, for this deployment only.
    { Sid: "StateObjects", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: join([get("StateBucket", "Arn"), "/deployments/", ref("DeploymentId"), "/*"]) },
  ],
};
const launcherCode = `import boto3, json, urllib.request

HINTS = {
    "AccountLimitExceededException": "CodeBuild is not yet available in this new AWS account. Request a CodeBuild concurrent build quota increase, then retry.",
    "ResourceNotFoundException": "The installer project was not found.",
}

def handler(event, context):
    status, reason = "SUCCESS", "Installer started; follow progress in OpenWork."
    try:
        if event["RequestType"] in ("Create", "Update"):
            boto3.client("codebuild").start_build(projectName=event["ResourceProperties"]["ProjectName"], idempotencyToken=event["RequestId"][:64])
    except Exception as error:
        name = type(error).__name__
        status, reason = "FAILED", HINTS.get(name, "Could not start the installer (" + name + "). See the launcher logs.")
    body = json.dumps({"Status": status, "Reason": reason, "PhysicalResourceId": event.get("PhysicalResourceId", event["LogicalResourceId"]), "StackId": event["StackId"], "RequestId": event["RequestId"], "LogicalResourceId": event["LogicalResourceId"]}).encode()
    request = urllib.request.Request(event["ResponseURL"], data=body, method="PUT", headers={"Content-Type": "", "Content-Length": str(len(body))})
    urllib.request.urlopen(request, timeout=15).close()
`;
const template = {
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "OpenWork installer. Creates a customer-owned runner and retained, encrypted Terraform state. The runner provisions billable ECS, RDS, load balancer and NAT resources in this dedicated account, plus a read-only health agent that reports status to OpenWork.",
  Parameters: {
    DeploymentId: { Type: "String", AllowedPattern: "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}" }, RunId: { Type: "String", AllowedPattern: "[a-f0-9-]{36}" },
    Challenge: { Type: "String", AllowedPattern: "[a-f0-9]{64}" }, ExpectedAccountId: { Type: "String", AllowedPattern: "[0-9]{12}" },
    ControlPlaneOrigin: { Type: "String", AllowedPattern: "https://[a-zA-Z0-9.-]+(:[0-9]+)?" },
    BundleUrl: { Type: "String", AllowedPattern: "https://.*" }, BundleSha256: { Type: "String", AllowedPattern: "[a-f0-9]{64}" },
    OpenWorkVersion: { Type: "String", AllowedPattern: "[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?" },
    DomainName: { Type: "String", AllowedPattern: "[a-z0-9.-]+" }, Route53ZoneId: { Type: "String", AllowedPattern: "Z[A-Z0-9]+" }, OwnerEmail: { Type: "String" },
    Size: { Type: "String", AllowedValues: ["small"], Default: "small" },
  },
  Resources: {
    StateBucket: { Type: "AWS::S3::Bucket", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain", Properties: {
      VersioningConfiguration: { Status: "Enabled" }, BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
    } },
    StateBucketPolicy: { Type: "AWS::S3::BucketPolicy", Properties: { Bucket: ref("StateBucket"), PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [get("StateBucket", "Arn"), join([get("StateBucket", "Arn"), "/*"])], Condition: { Bool: { "aws:SecureTransport": false } } }] } } },
    RunnerRole: { Type: "AWS::IAM::Role", Properties: { RoleName: runnerRoleName, AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "codebuild.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": ref("AWS::AccountId") } } }] }, Policies: [{ PolicyName: "ProvisionOpenWork", PolicyDocument: policy }] } },
    Runner: { Type: "AWS::CodeBuild::Project", Properties: {
      Name: sub("${AWS::StackName}-runner"), ServiceRole: get("RunnerRole", "Arn"), ConcurrentBuildLimit: 1, TimeoutInMinutes: 120,
      Artifacts: { Type: "NO_ARTIFACTS" }, Environment: { Type: "LINUX_CONTAINER", ComputeType: "BUILD_GENERAL1_SMALL", Image: "aws/codebuild/standard:7.0", PrivilegedMode: false, EnvironmentVariables: Object.entries(environment).map(([Name, Value]) => ({ Name, Value, Type: "PLAINTEXT" })) },
      Source: { Type: "NO_SOURCE", BuildSpec: JSON.stringify({ version: "0.2", phases: { install: { commands: ["python3 -m pip install --disable-pip-version-check boto3==1.43.110 botocore==1.43.110"] }, build: { commands: ["set -eu", "umask 077", "cat > /tmp/openwork-bootstrap.py <<'OPENWORK_BOOTSTRAP'\n" + bootstrap + "\nOPENWORK_BOOTSTRAP", "python3 /tmp/openwork-bootstrap.py"] } } }) },
      LogsConfig: { CloudWatchLogs: { Status: "ENABLED" } },
    } },
    LauncherRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }, Policies: [{ PolicyName: "LaunchRunner", PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "codebuild:StartBuild", Resource: get("Runner", "Arn") }, { Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${AWS::StackName}*:*") }] } }] } },
    Launcher: { Type: "AWS::Lambda::Function", Properties: { FunctionName: sub("${AWS::StackName}-launcher"), Runtime: "python3.12", Handler: "index.handler", Role: get("LauncherRole", "Arn"), Timeout: 60, Code: { ZipFile: launcherCode } } },
    // A new RunId (new install, retry or approved update) starts a new build.
    StartRunner: { Type: "Custom::OpenWorkLaunch", Properties: { ServiceToken: get("Launcher", "Arn"), ProjectName: ref("Runner"), RunId: ref("RunId") } },
  },
  Outputs: { RunnerProject: { Value: ref("Runner") }, StateBucket: { Value: ref("StateBucket") } },
};
const output = resolve(process.argv[2] ?? fileURLToPath(new URL("cloudformation.json", import.meta.url)));
writeFileSync(output, JSON.stringify(template, null, 1) + "\n");
console.log(`Wrote ${output}`);
