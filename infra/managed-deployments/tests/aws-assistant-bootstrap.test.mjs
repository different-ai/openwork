import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const templatePath = new URL("../aws/bootstrap/cloudformation.json", import.meta.url);
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const deploymentId = "00000000-0000-4000-8000-000000000001";
const name = "ow-000000000000";
const values = {
  ...Object.fromEntries(Object.entries(template.Parameters).map(([key, value]) => [key, value.Default ?? "fixture"])),
  "AWS::Partition": "aws", "AWS::Region": "ap-southeast-2", "AWS::AccountId": "123456789012", "AWS::URLSuffix": "amazonaws.com",
  "AWS::StackName": "s".repeat(128), DeploymentId: deploymentId,
  Route53ZoneId: "Z".repeat(32), VpcId: "vpc-0123456789abcdef0",
  EcsClusterArn: "arn:aws:ecs:ap-southeast-2:123456789012:cluster/" + "c".repeat(255),
};
const absent = Symbol("AWS::NoValue");
function resolveTemplate(overrides = {}) {
  const parameters = { ...values, ...overrides };
  function resolve(value) {
    if (Array.isArray(value)) return value.map(resolve).filter((item) => item !== absent);
    if (!value || typeof value !== "object") return value;
    if ("Ref" in value) return value.Ref === "AWS::NoValue" ? absent : parameters[value.Ref] ?? value.Ref;
    if ("Condition" in value && Object.keys(value).length === 1) return resolve(template.Conditions[value.Condition]);
    if ("Fn::Equals" in value) { const [left, right] = resolve(value["Fn::Equals"]); return left === right; }
    if ("Fn::Not" in value) return !resolve(value["Fn::Not"][0]);
    if ("Fn::And" in value) return value["Fn::And"].every(resolve);
    if ("Fn::Or" in value) return value["Fn::Or"].some(resolve);
    if ("Fn::If" in value) {
      const [condition, yes, no] = value["Fn::If"];
      return resolve(resolve(template.Conditions[condition]) ? yes : no);
    }
    if ("Fn::Split" in value) { const [separator, text] = value["Fn::Split"]; return resolve(text).split(separator); }
    if ("Fn::Select" in value) { const [index, list] = value["Fn::Select"]; return resolve(list)[index]; }
    if ("Fn::Join" in value) { const [separator, parts] = value["Fn::Join"]; return resolve(parts).join(separator); }
    if ("Fn::Sub" in value) {
      const expression = value["Fn::Sub"];
      const [text, variables] = typeof expression === "string" ? [expression, {}] : expression;
      return text.replace(/\$\{([^}]+)\}/g, (_, key) => resolve(variables[key] ?? { Ref: key }));
    }
    if ("Fn::GetAtt" in value) return "arn:aws:s3:::" + "b".repeat(63);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]).filter(([, item]) => item !== absent));
  }
  return {
    resources: Object.fromEntries(Object.entries(template.Resources)
      .filter(([, resource]) => !resource.Condition || resolve(template.Conditions[resource.Condition]))
      .map(([key, resource]) => [key, resolve(resource)])),
    valid: Object.values(template.Rules).every((rule) => !rule.RuleCondition || !resolve(rule.RuleCondition)
      || rule.Assertions.every((assertion) => resolve(assertion.Assert))),
  };
}
const actions = (statement) => [statement.Action].flat();
const enabled = { HeadlessRunnerEnabled: "true", HeadlessModel: "fixture-model", HeadlessModelSecretArn: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:model-key-abcdef" };
function policies(resources) {
  return Object.values(resources).flatMap((resource) => resource.Type === "AWS::IAM::Role"
    ? resource.Properties.Policies.map((policy) => policy.PolicyDocument)
    : resource.Type === "AWS::IAM::ManagedPolicy" ? [resource.Properties.PolicyDocument] : []);
}

test("generated bootstrap matches the generator and fits CloudFormation's inline limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "openwork-assistant-template-"));
  try {
    const output = join(directory, "cloudformation.json");
    execFileSync(process.execPath, [new URL("../aws/bootstrap/template.mjs", import.meta.url).pathname, output]);
    const bytes = readFileSync(output);
    assert.deepEqual(bytes, readFileSync(templatePath));
    assert.ok(bytes.length < 51_200, `CloudFormation template is ${bytes.length} bytes`);
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test("baseline has no optional storage, backup, runner-secret or Workbot-secret provisioning grants", () => {
  const { resources, valid } = resolveTemplate();
  assert.equal(valid, true);
  assert.equal(resources.RunnerSupplementalPolicy, undefined);
  assert.deepEqual(resources.RunnerCoreSupportPolicy.Properties.PolicyDocument.Statement.map((statement) => statement.Sid), ["ExecutionPolicy", "ListLogs", "DeploymentDns", "DnsChanges", "ServiceDiscoveryZone"]);
  assert.deepEqual(resources.RunnerRole.Properties.ManagedPolicyArns, ["RunnerCoreSupportPolicy"]);
  const policyText = JSON.stringify(policies(resources));
  assert.doesNotMatch(policyText, /elasticfilesystem:|backup:|backup-storage:|runner-backup|secret:ow-[a-f0-9]+-(?:runner|workbot)-/);
  for (const parameter of ["HeadlessRunnerEnabled", "WorkbotEnabled", "SlackAssistantEnabled"]) {
    assert.equal(template.Parameters[parameter].Default, "false");
    assert.deepEqual(template.Parameters[parameter].AllowedValues, ["true", "false"]);
  }
});

test("bootstrap forwards only non-secret model/computer settings and secret references", () => {
  const expected = {
    HEADLESS_RUNNER_ENABLED: "HeadlessRunnerEnabled", WORKBOT_ENABLED: "WorkbotEnabled", SLACK_ASSISTANT_ENABLED: "SlackAssistantEnabled",
    HEADLESS_MODEL_PROTOCOL: "HeadlessModelProtocol", HEADLESS_MODEL_BASE_URL: "HeadlessModelBaseUrl", HEADLESS_MODEL: "HeadlessModel",
    HEADLESS_MODEL_SECRET_ARN: "HeadlessModelSecretArn", HEADLESS_COMPUTER_PROVIDER: "HeadlessComputerProvider", HEADLESS_COMPUTER_SECRET_ARN: "HeadlessComputerSecretArn",
    HEADLESS_COMPUTER_SNAPSHOT: "HeadlessComputerSnapshot", DAYTONA_API_URL: "DaytonaApiUrl", DAYTONA_TARGET: "DaytonaTarget",
  };
  const environment = Object.fromEntries(template.Resources.Runner.Properties.Environment.EnvironmentVariables.map((entry) => [entry.Name, entry.Value]));
  for (const [key, parameter] of Object.entries(expected)) {
    if (["HEADLESS_RUNNER_ENABLED", "WORKBOT_ENABLED", "SLACK_ASSISTANT_ENABLED"].includes(key)) {
      assert.deepEqual(environment[key], { "Fn::If": ["IsGatewayRuntime", "true", { Ref: parameter }] });
    } else assert.deepEqual(environment[key], { Ref: parameter });
  }
  assert.deepEqual(environment.MANAGED_RUNTIME_PROFILE, { Ref: "ManagedRuntimeProfile" });
  assert.deepEqual(template.Parameters.HeadlessModelProtocol.AllowedValues, ["anthropic", "openai", "openai-responses"]);
  assert.deepEqual(template.Parameters.HeadlessComputerProvider.AllowedValues, ["off", "daytona", "freestyle"]);
  assert.equal(template.Parameters.HeadlessComputerProvider.Default, "off");
  assert.equal(template.Parameters.HeadlessComputerSnapshot.Default, "");
  assert.equal(template.Parameters.DaytonaApiUrl.Default, "https://app.daytona.io/api");
  assert.equal(template.Parameters.DaytonaTarget.Default, "us");
  assert.doesNotMatch(Object.keys(template.Parameters).join(","), /ApiKey|Password|Token/);
  assert.doesNotMatch(Object.keys(environment).join(","), /HEADLESS_MODEL_API_KEY|FREESTYLE_API_KEY|DAYTONA_API_KEY/);
  for (const key of ["HeadlessModelSecretArn", "HeadlessComputerSecretArn"]) {
    const pattern = new RegExp(`^(?:${template.Parameters[key].AllowedPattern})$`);
    assert.ok(pattern.test(enabled.HeadlessModelSecretArn));
    assert.ok(pattern.test(""));
    assert.equal(pattern.test(enabled.HeadlessModelSecretArn + ":key::"), false);
    assert.equal(pattern.test("plaintext-key"), false);
  }
});

test("assistant dependencies and model/computer secret requirements fail before the installer", () => {
  assert.equal(resolveTemplate({ ...enabled, WorkbotEnabled: "true", SlackAssistantEnabled: "true" }).valid, true);
  for (const overrides of [
    { WorkbotEnabled: "true" }, { SlackAssistantEnabled: "true" },
    { ...enabled, HeadlessModel: "" }, { ...enabled, HeadlessModelSecretArn: "" },
    { ...enabled, HeadlessComputerProvider: "freestyle" },
  ]) assert.equal(resolveTemplate(overrides).valid, false);
  assert.equal(resolveTemplate({ ...enabled, HeadlessComputerProvider: "freestyle", HeadlessComputerSecretArn: enabled.HeadlessModelSecretArn }).valid, true);
});

test("Gateway explicitly enables all runtime features without legacy model or computer credentials", () => {
  assert.equal(template.Parameters.ManagedRuntimeProfile.Default, "legacy");
  assert.deepEqual(template.Parameters.ManagedRuntimeProfile.AllowedValues, ["legacy", "gateway"]);
  const gateway = { ManagedRuntimeProfile: "gateway", HeadlessModel: "", HeadlessModelBaseUrl: "", HeadlessModelSecretArn: "", HeadlessComputerSecretArn: "" };
  const { resources, valid } = resolveTemplate(gateway);
  assert.equal(valid, true);
  const environment = Object.fromEntries(resources.Runner.Properties.Environment.EnvironmentVariables.map((entry) => [entry.Name, entry.Value]));
  assert.equal(environment.MANAGED_RUNTIME_PROFILE, "gateway");
  for (const key of ["HEADLESS_RUNNER_ENABLED", "WORKBOT_ENABLED", "SLACK_ASSISTANT_ENABLED"]) assert.equal(environment[key], "true");
  assert.equal(environment.HEADLESS_COMPUTER_PROVIDER, "off");
  assert.ok(resources.RunnerSupplementalPolicy);
  for (const key of ["HeadlessModelProtocol", "HeadlessModelBaseUrl", "HeadlessModel", "HeadlessModelSecretArn"]) assert.match(template.Parameters[key].Description, /Legacy.*ignored by Gateway/);
  for (const overrides of [{ HeadlessComputerProvider: "freestyle" }, { HeadlessComputerProvider: "daytona" }, { HeadlessComputerProvider: "daytona", HeadlessComputerSecretArn: enabled.HeadlessModelSecretArn }]) {
    assert.equal(resolveTemplate({ ...gateway, ...overrides }).valid, false);
  }
  assert.equal(resolveTemplate({ ...gateway, HeadlessComputerProvider: "daytona", HeadlessComputerSecretArn: enabled.HeadlessModelSecretArn, HeadlessComputerSnapshot: "computer-fixture" }).valid, true);
  assert.match(template.Description, /five required services: Den API, Den web, headless runner, Workbot and AI Gateway/);
});

test("native AI Gateway resources stay inside existing deployment IAM scopes", () => {
  const { resources } = resolveTemplate({ ManagedRuntimeProfile: "gateway", NetworkMode: "existing" });
  const bySid = Object.fromEntries(policies(resources).flatMap((policy) => policy.Statement).map((statement) => [statement.Sid, statement]));
  assert.ok(bySid.OwnServices.Resource.includes(`/${name}-*`));
  assert.ok(bySid.OwnTaskDefinitions.Resource.includes(`task-definition/${name}-*:`));
  assert.ok(bySid.OwnLoadBalancer.Resource.every((arn) => arn.includes(`/${name}-*`)));
  assert.ok(bySid.Logs.Resource.some((arn) => arn.endsWith(`/ecs/${name}/*`)));
  assert.ok(actions(bySid.NewServiceDiscovery).includes("servicediscovery:CreateService"));
  assert.ok(actions(bySid.OwnSecurityGroupRules).includes("ec2:AuthorizeSecurityGroupIngress"));
});

test("Daytona is optional and requires a provider key plus snapshot only when selected", () => {
  assert.equal(resolveTemplate().valid, true);
  assert.equal(resolveTemplate(enabled).valid, true);
  const daytona = { ...enabled, HeadlessComputerProvider: "daytona", HeadlessComputerSnapshot: "computer-fixture", HeadlessComputerSecretArn: enabled.HeadlessModelSecretArn };
  assert.equal(resolveTemplate(daytona).valid, true);
  for (const overrides of [
    { ...daytona, HeadlessRunnerEnabled: "false" },
    { ...daytona, HeadlessComputerSecretArn: "" },
    { ...daytona, HeadlessComputerSnapshot: "" },
  ]) assert.equal(resolveTemplate(overrides).valid, false);
  assert.equal(resolveTemplate({ ...daytona, HeadlessComputerProvider: "freestyle", HeadlessComputerSnapshot: "" }).valid, true);
  assert.equal(resolveTemplate({ ...daytona, HeadlessComputerProvider: "off", HeadlessComputerSnapshot: "", HeadlessComputerSecretArn: "" }).valid, true);
  const baselinePolicies = policies(resolveTemplate(enabled).resources);
  assert.deepEqual(policies(resolveTemplate(daytona).resources), baselinePolicies);
  assert.deepEqual(policies(resolveTemplate({ ...daytona, HeadlessComputerProvider: "freestyle" }).resources), baselinePolicies);
  // The installer passes only settings/references. Remote computer SDKs and
  // provider key injection belong to the runner service, not CodeBuild.
  assert.doesNotMatch(template.Resources.Runner.Properties.Source.BuildSpec, /daytona|freestyle/i);
});

test("Daytona API URL accepts HTTPS endpoints without credentials, query secrets or fragments", () => {
  const pattern = new RegExp(`^(?:${template.Parameters.DaytonaApiUrl.AllowedPattern})$`);
  for (const url of ["https://app.daytona.io/api", "https://sandbox.example.com:8443/api/v1"]) assert.ok(pattern.test(url));
  for (const url of ["http://app.daytona.io/api", "https://key@app.daytona.io/api", "https://user:password@app.daytona.io/api", "https://app.daytona.io/api?key=secret", "https://app.daytona.io/api#secret", "https://app.daytona.io/ api", ""]) assert.equal(pattern.test(url), false);
  const module = readFileSync(new URL("../../terraform/modules/openwork-aws-ecs/variables.tf", import.meta.url), "utf8");
  assert.match(module, /api_url\s*=\s*optional\(string, "https:\/\/app\.daytona\.io\/api"\)/);
  assert.match(module, /variable "headless_computer"\s*\{[\s\S]*?provider\s*=\s*optional\(string, "off"\)/);
  assert.match(module, /variable "headless_computer"\s*\{[\s\S]*?snapshot\s*=\s*optional\(string, ""\)/);
});

test("optional grants scope EFS creation, owned mount/access-point updates, backups and secret access", () => {
  const { resources } = resolveTemplate(enabled);
  const statements = resources.RunnerSupplementalPolicy.Properties.PolicyDocument.Statement;
  const bySid = Object.fromEntries(statements.map((statement) => [statement.Sid, statement]));
  assert.deepEqual(resources.RunnerRole.Properties.ManagedPolicyArns, ["RunnerCoreSupportPolicy", "RunnerSupplementalPolicy"]);
  assert.equal(bySid.NewRunnerStorage.Condition.StringEquals["aws:RequestTag/Deployment"], deploymentId);
  assert.equal(bySid.NewRunnerStorage.Condition.Bool["elasticfilesystem:Encrypted"], "true");
  assert.deepEqual(bySid.TagNewRunnerStorage.Condition.StringEquals["elasticfilesystem:CreateAction"], ["CreateFileSystem", "CreateAccessPoint"]);
  assert.equal(bySid.OwnRunnerStorage.Condition.StringEquals["aws:ResourceTag/Deployment"], deploymentId);
  assert.ok(actions(bySid.OwnRunnerStorage).includes("elasticfilesystem:CreateMountTarget"));
  assert.ok(actions(bySid.OwnRunnerStorage).includes("elasticfilesystem:CreateAccessPoint"));
  assert.equal(bySid.OwnRunnerStorageTags.Condition.StringEquals["aws:ResourceTag/Deployment"], deploymentId);
  assert.ok(bySid.OwnRunnerStorageTags.Resource.some((arn) => arn.endsWith(":access-point/*")));
  assert.deepEqual(bySid.RunnerMountNetwork.Condition, { "ForAnyValue:StringEquals": { "aws:CalledVia": "elasticfilesystem.amazonaws.com" } });
  assert.equal(bySid.NewRunnerBackupVault.Resource, `arn:aws:backup:ap-southeast-2:123456789012:backup-vault:${name}-runner`);
  for (const sid of ["NewRunnerBackupVault", "NewRunnerBackupPlan"]) assert.equal(bySid[sid].Condition.StringEquals["aws:RequestTag/Deployment"], deploymentId);
  assert.equal(bySid.OwnRunnerBackupPlan.Condition.StringEquals["aws:ResourceTag/Deployment"], deploymentId);
  assert.equal(bySid.RunnerBackupRole.Resource, `arn:aws:iam::123456789012:role/${name}-runner-backup`);
  assert.equal(bySid.PassRunnerBackupRole.Resource, bySid.RunnerBackupRole.Resource);
  assert.deepEqual(bySid.PassRunnerBackupRole.Condition, { StringEquals: { "iam:PassedToService": "backup.amazonaws.com" } });
  assert.equal(bySid.RunnerSecrets, undefined);
  for (const statement of statements) {
    assert.equal(actions(statement).some((action) => /:(Delete|Terminate|Remove|Detach|Restore)/.test(action)), false, statement.Sid);
    assert.equal(actions(statement).some((action) => action.endsWith(":*")), false, statement.Sid);
    if (actions(statement).some((action) => action.startsWith("kms:"))) {
      const service = statement.Sid.startsWith("RunnerStorageKey") ? "elasticfilesystem" : "backup";
      assert.deepEqual(statement.Condition["ForAnyValue:StringEquals"], { "kms:ResourceAliases": `alias/aws/${service}` });
      assert.equal(statement.Condition.StringEquals["kms:ViaService"], `${service}.ap-southeast-2.amazonaws.com`);
      assert.equal(statement.Resource, "arn:aws:kms:ap-southeast-2:123456789012:key/*");
      if (actions(statement).includes("kms:CreateGrant")) assert.deepEqual(statement.Condition.Bool, { "kms:GrantIsForAWSResource": "true" });
    }
  }
  // External customer secrets are injected by ECS; installer reads stay owned.
  for (const policy of policies(resources)) for (const statement of policy.Statement) {
    if (statement.Effect === "Allow" && actions(statement).includes("secretsmanager:GetSecretValue")) {
      assert.notEqual(statement.Resource, "*");
      assert.doesNotMatch(JSON.stringify(statement.Resource), /model-key|HeadlessModelSecretArn|HeadlessComputerSecretArn/);
    }
    if (statement.Effect === "Allow" && actions(statement).includes("ecs:DeregisterTaskDefinition")) assert.notEqual(statement.Resource, "*");
  }
});

test("installer secret access is exactly app-only by default or the three deployment-owned prefixes when enabled", () => {
  const expectedActions = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:ListSecretVersionIds", "secretsmanager:GetResourcePolicy", "secretsmanager:TagResource"];
  for (const runnerEnabled of [false, true]) {
    const { resources } = resolveTemplate({ ...(runnerEnabled ? enabled : {}),
      HeadlessModelSecretArn: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:external-model-abcdef",
      HeadlessComputerSecretArn: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:external-computer-abcdef",
    });
    const grants = policies(resources).flatMap((policy) => policy.Statement).filter((statement) => statement.Effect === "Allow"
      && actions(statement).some((action) => action.startsWith("secretsmanager:")));
    assert.equal(grants.length, 1, "Owned secret grants share one action inventory, without duplicate statements");
    assert.equal(grants[0].Sid, "AppSecrets");
    assert.deepEqual(actions(grants[0]), expectedActions);
    assert.deepEqual([grants[0].Resource].flat(), (runnerEnabled ? ["den", "runner", "workbot"] : ["den"])
      .map((prefix) => `arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:${name}-${prefix}-*`));
    assert.doesNotMatch(JSON.stringify(grants), /external-model|external-computer|HeadlessModelSecretArn|HeadlessComputerSecretArn/);
  }
});

test("documented EFS key and Backup vault dependencies remain minimal and service-scoped", () => {
  // EFS creation uses FAS for CreateGrant; the default managed key is documented at:
  // https://docs.aws.amazon.com/efs/latest/ug/EFSKMS.html
  // Backup's vault dependency list (including backup-storage and these KMS actions):
  // https://docs.aws.amazon.com/aws-backup/latest/devguide/access-control.html#backup-api-permissions-ref
  const { resources } = resolveTemplate(enabled);
  const statements = resources.RunnerSupplementalPolicy.Properties.PolicyDocument.Statement;
  const keyStatements = (prefix) => statements.filter((statement) => statement.Sid.startsWith(prefix));
  assert.deepEqual(keyStatements("RunnerStorageKey").flatMap(actions).sort(), ["kms:CreateGrant", "kms:DescribeKey"]);
  assert.deepEqual(keyStatements("RunnerBackupKey").flatMap(actions).sort(), ["kms:CreateGrant", "kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey", "kms:RetireGrant"]);
  const storage = statements.find((statement) => statement.Sid === "RunnerBackupStorage");
  assert.deepEqual(actions(storage), ["backup-storage:MountCapsule"]);
  assert.equal(storage.Resource, "*");
  assert.equal(storage.Condition.StringEquals["aws:RequestedRegion"], values["AWS::Region"]);
});

test("Backup selection operations authorize against the tagged plan, never a fabricated selection ARN", () => {
  // Action Resources and resource ConditionKeys from AWS's service metadata:
  // https://servicereference.us-east-1.amazonaws.com/v1/backup/backup.json
  // CreateBackupSelection, GetBackupSelection and ListBackupSelections -> backupPlan;
  // backupPlan supports aws:ResourceTag/${TagKey}.
  const { resources } = resolveTemplate(enabled);
  const statement = resources.RunnerSupplementalPolicy.Properties.PolicyDocument.Statement.find((entry) => entry.Sid === "OwnRunnerBackupPlan");
  assert.equal(statement.Resource, "arn:aws:backup:ap-southeast-2:123456789012:backup-plan:*");
  assert.deepEqual(statement.Condition, { StringEquals: { "aws:ResourceTag/Deployment": deploymentId } });
  for (const action of ["CreateBackupSelection", "GetBackupSelection", "ListBackupSelections"]) assert.ok(actions(statement).includes("backup:" + action));
});

test("KMS ViaService retains the documented .amazonaws.com suffix in every partition", () => {
  // https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html#conditions-kms-via-service
  // Both EFS and Backup are listed; AWS requires .amazonaws.com in all partitions.
  for (const partition of ["aws", "aws-us-gov", "aws-cn"]) {
    const { resources } = resolveTemplate({ ...enabled, "AWS::Partition": partition, "AWS::URLSuffix": partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com" });
    const statements = resources.RunnerSupplementalPolicy.Properties.PolicyDocument.Statement.filter((statement) => actions(statement).some((action) => action.startsWith("kms:")));
    assert.equal(statements.length, 4);
    for (const statement of statements) {
      const service = statement.Sid.startsWith("RunnerStorageKey") ? "elasticfilesystem" : "backup";
      assert.equal(statement.Condition.StringEquals["kms:ViaService"], `${service}.${values["AWS::Region"]}.amazonaws.com`);
      assert.equal(statement.Resource, `arn:${partition}:kms:${values["AWS::Region"]}:123456789012:key/*`);
    }
  }
});

test("every resolved role respects the aggregate inline IAM limit and each managed policy its own limit", (context) => {
  const maximums = new Map();
  for (const NetworkMode of ["dedicated", "existing"]) for (const runner of [false, true]) for (const partition of ["aws", "aws-us-gov", "aws-cn"]) for (const ManagedRuntimeProfile of ["legacy", "gateway"]) {
    const { resources } = resolveTemplate({ NetworkMode, ManagedRuntimeProfile, "AWS::Partition": partition, ...(runner ? enabled : {}) });
    for (const [key, resource] of Object.entries(resources)) {
      if (resource.Type === "AWS::IAM::Role") {
        const bytes = resource.Properties.Policies.reduce((total, policy) => total + Buffer.byteLength(JSON.stringify(policy.PolicyDocument)), 0);
        assert.ok(bytes <= 10_240, `${key} aggregate inline policies: ${bytes} bytes (${NetworkMode})`);
        maximums.set(key, Math.max(maximums.get(key) ?? 0, bytes));
      }
      if (resource.Type === "AWS::IAM::ManagedPolicy") {
        const bytes = Buffer.byteLength(JSON.stringify(resource.Properties.PolicyDocument));
        assert.ok(bytes <= 6_144, `${key}: ${bytes} bytes`);
        maximums.set(key, Math.max(maximums.get(key) ?? 0, bytes));
      }
    }
  }
  for (const [key, bytes] of maximums) context.diagnostic(`${key} maximum resolved policy size: ${bytes} bytes`);
});
