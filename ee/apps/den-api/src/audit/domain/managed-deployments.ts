import type { AwsTarget, DeploymentConfigurationChange } from "@openwork/managed-deployments/schema"
import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, organizationParent, targetResource, type AuditSnapshot } from "./snapshot.js"

// managed_deployment.renamed / .configuration_change_requested /
// .configuration_change_withdrawn. A request and a withdrawal describe the
// pending change, not the deployment: its recorded configuration changes only
// when the customer-approved installer run verifies health, which the run row
// and its milestones record. Secret ARNs are references, never secret values.

export type ManagedDeploymentAuditSubject = { organizationId: string; deploymentId: string; name: string }
export type ManagedDeploymentAuditConfiguration = { ownerEmail: string; target: AwsTarget }
type ConfigurationChangeEvidence = {
  recorded: ManagedDeploymentAuditConfiguration
  requested: ManagedDeploymentAuditConfiguration
  /** The request's changes; they name what differs even where a value is withheld. */
  changes: readonly DeploymentConfigurationChange[]
  runId: string
  installerVersion: string
}

function snapshot(name: string, configuration: ManagedDeploymentAuditConfiguration): AuditSnapshot {
  const assistants = configuration.target.assistants
  return {
    name: auditText(name), ownerEmail: auditText(configuration.ownerEmail), runtimeProfile: configuration.target.runtimeProfile,
    computerProvider: assistants.computerProvider, computerSecretArn: auditText(assistants.computerSecretArn, 2048),
    computerSnapshot: auditText(assistants.computerSnapshot), daytonaApiUrl: auditText(assistants.daytonaApiUrl, 2048), daytonaTarget: auditText(assistants.daytonaTarget),
  }
}

function resources(subject: ManagedDeploymentAuditSubject) {
  return [targetResource("managed_deployment", subject.deploymentId, subject.name), organizationParent(subject.organizationId)]
}

function changedFieldNames(changes: readonly DeploymentConfigurationChange[]) {
  return changes.map((change) => change.field.split(".").at(-1) ?? change.field)
}

/** A rename is saved at once; nothing in the customer's cloud changes. */
export function managedDeploymentRenamedEvent(subject: ManagedDeploymentAuditSubject, previousName: string, configuration: ManagedDeploymentAuditConfiguration): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "managed_deployment.renamed", resources: resources(subject),
    before: snapshot(previousName, configuration), after: snapshot(subject.name, configuration),
  })
}

/** A change was prepared for the customer's approval; `supersedesRunId` names a pending change it replaced. */
export function managedDeploymentConfigurationChangeRequestedEvent(subject: ManagedDeploymentAuditSubject, evidence: ConfigurationChangeEvidence & { supersedesRunId: string | null }): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "managed_deployment.configuration_change_requested", resources: resources(subject),
    before: snapshot(subject.name, evidence.recorded), after: snapshot(subject.name, evidence.requested), markers: changedFieldNames(evidence.changes),
    annotations: { runId: evidence.runId, installerVersion: evidence.installerVersion, ...(evidence.supersedesRunId ? { supersedesRunId: evidence.supersedesRunId } : {}) },
  })
}

/** A prepared change was discarded before it reached the customer's cloud; the recorded configuration stays. */
export function managedDeploymentConfigurationChangeWithdrawnEvent(subject: ManagedDeploymentAuditSubject, evidence: ConfigurationChangeEvidence): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "managed_deployment.configuration_change_withdrawn", resources: resources(subject),
    before: snapshot(subject.name, evidence.requested), after: snapshot(subject.name, evidence.recorded), markers: changedFieldNames(evidence.changes),
    annotations: { runId: evidence.runId, installerVersion: evidence.installerVersion },
  })
}
