import type { AwsTarget, DeploymentConfigurationChange } from "@openwork/managed-deployments/schema"
import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, organizationParent, targetResource, type AuditSnapshot } from "./snapshot.js"

export type ManagedDeploymentAuditSubject = { organizationId: string; deploymentId: string; name: string }
export type ManagedDeploymentAuditConfiguration = { ownerEmail: string; target: AwsTarget }
type ConfigurationChangeEvidence = {
  recorded: ManagedDeploymentAuditConfiguration
  requested: ManagedDeploymentAuditConfiguration
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

export function managedDeploymentRenamedEvent(subject: ManagedDeploymentAuditSubject, previousName: string, configuration: ManagedDeploymentAuditConfiguration): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "managed_deployment.renamed", resources: resources(subject),
    before: snapshot(previousName, configuration), after: snapshot(subject.name, configuration),
  })
}

export function managedDeploymentConfigurationChangeRequestedEvent(subject: ManagedDeploymentAuditSubject, evidence: ConfigurationChangeEvidence & { supersedesRunId: string | null }): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "managed_deployment.configuration_change_requested", resources: resources(subject),
    before: snapshot(subject.name, evidence.recorded), after: snapshot(subject.name, evidence.requested), markers: changedFieldNames(evidence.changes),
    annotations: { runId: evidence.runId, installerVersion: evidence.installerVersion, ...(evidence.supersedesRunId ? { supersedesRunId: evidence.supersedesRunId } : {}) },
  })
}

export function managedDeploymentConfigurationChangeWithdrawnEvent(subject: ManagedDeploymentAuditSubject, evidence: ConfigurationChangeEvidence): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "managed_deployment.configuration_change_withdrawn", resources: resources(subject),
    before: snapshot(subject.name, evidence.requested), after: snapshot(subject.name, evidence.recorded), markers: changedFieldNames(evidence.changes),
    annotations: { runId: evidence.runId, installerVersion: evidence.installerVersion },
  })
}
