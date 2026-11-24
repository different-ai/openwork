import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { z } from "zod"
import { quickCreateDefaults, quickCreateUrl, stackName, throughAccessPortal, updateStackCommand, type AwsLaunch } from "@openwork/managed-deployments/aws"
import { awsTargetSchema } from "@openwork/managed-deployments/schema"

const template = z.object({ Parameters: z.record(z.string(), z.object({ Default: z.string().optional() })) }).parse(JSON.parse(readFileSync(new URL("../../../infra/managed-deployments/aws/bootstrap/cloudformation.json", import.meta.url), "utf8")))
const target = { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" }
const launch: AwsLaunch = {
  deploymentId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002", challenge: "a".repeat(64),
  target: awsTargetSchema.parse({ ...target, runtimeProfile: "gateway" }), domainName: "openwork.example.test", ownerEmail: "admin@example.test", size: "small",
  release: { templateUrl: "https://releases.example.test/aws/1.0.2/cloudformation.json", bundleUrl: "https://releases.example.test/aws/1.0.2/bundle.tar.gz", bundleSha256: "b".repeat(64), version: "1.0.2", apiOrigin: "https://control.example.test" },
}

function explicitParameters(input: AwsLaunch) {
  const encoded = updateStackCommand(input).split("--parameters '")[1]?.slice(0, -1)
  assert.ok(encoded)
  return z.array(z.object({ ParameterKey: z.string(), ParameterValue: z.string() })).parse(JSON.parse(encoded))
}

function defaults() {
  return Object.fromEntries(Object.entries(template.Parameters).flatMap(([name, parameter]) => parameter.Default === undefined ? [] : [[name, parameter.Default]]))
}

test("quick-create defaults match the installer template", () => {
  assert.deepEqual(Object.fromEntries(quickCreateDefaults), defaults())
})

for (const [name, configuration] of Object.entries({
  legacy: { ...launch, target: awsTargetSchema.parse(target), includeAssistantParameters: true, includeRuntimeProfileParameter: true },
  gateway: launch,
  "existing-network": { ...launch, target: awsTargetSchema.parse({ ...target, runtimeProfile: "gateway", network: { mode: "existing", vpcId: "vpc-12345678", serviceSubnetIds: ["subnet-12345678", "subnet-23456789"], loadBalancerSubnetIds: ["subnet-34567890", "subnet-45678901"], ecsClusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/shared" } }) },
  Daytona: { ...launch, target: awsTargetSchema.parse({ ...target, runtimeProfile: "gateway", assistants: { computerProvider: "daytona", computerSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ab12Cd", computerSnapshot: "computer-snapshot", daytonaApiUrl: "https://daytona.example.test/api", daytonaTarget: "eu" } }) },
})) {
  test(`${name}: sent plus defaulted install values equal the complete update parameters`, () => {
    const params = new URLSearchParams(new URL(quickCreateUrl(configuration)).hash.split("?")[1])
    const sent = Object.fromEntries([...params].filter(([key]) => key.startsWith("param_")).map(([key, value]) => [key.slice(6), value]))
    const complete = Object.fromEntries(explicitParameters(configuration).map(({ ParameterKey, ParameterValue }) => [ParameterKey, ParameterValue]))
    assert.deepEqual({ ...defaults(), ...sent }, { ...defaults(), ...complete })
    for (const [key, value] of Object.entries(complete)) {
      assert.equal(params.has(`param_${key}`), quickCreateDefaults.get(key) !== value, key)
    }
    assert.equal(params.get("param_HeadlessModelBaseUrl"), "", "empty base URL must not become the nonempty template default")
    for (const [key, parameter] of Object.entries(template.Parameters)) {
      if (parameter.Default === undefined) {
        assert.equal(params.has(`param_${key}`), true, key)
        assert.equal(sent[key], complete[key], key)
      }
    }
  })
}

test("typical gateway link is shorter without changing the pinned release", (context) => {
  const before = new URLSearchParams({ templateURL: launch.release.templateUrl, stackName: stackName(launch.deploymentId) })
  for (const { ParameterKey, ParameterValue } of explicitParameters(launch)) before.set(`param_${ParameterKey}`, ParameterValue)
  const oldUrl = `https://${launch.target.region}.console.aws.amazon.com/cloudformation/home?region=${launch.target.region}#/stacks/quickcreate?${before}`
  const newUrl = quickCreateUrl(launch)
  assert.ok(newUrl.length < oldUrl.length)
  assert.equal(new URLSearchParams(new URL(newUrl).hash.split("?")[1]).get("templateURL"), launch.release.templateUrl)
  context.diagnostic(`Typical gateway install: ${oldUrl.length} -> ${newUrl.length} characters`)
  const signIn = { portalUrl: "https://example.awsapps.com/start", roleName: "AdministratorAccess" }
  context.diagnostic(`Through access portal: ${throughAccessPortal(oldUrl, launch.target.accountId, signIn).length} -> ${throughAccessPortal(newUrl, launch.target.accountId, signIn).length} characters`)
})
