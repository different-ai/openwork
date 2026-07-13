import {
  CONTRIBUTION_CONTRACT_VERSION,
  createContributionRegistry,
  type ContributionDescriptor,
} from "@openwork/contribution-registry";

import type {
  ExtensionActionContribution,
  ExtensionActionDescriptor,
} from "./action-contract.js";
import type { ExtensionActionRegistryPort } from "./action-service.js";

interface ServerActionRegistrationDescriptor extends ContributionDescriptor {
  readonly kind: "server-extension-action";
  readonly extensionId: string;
  readonly action: string;
  readonly publicDescriptor: ExtensionActionDescriptor;
}

type ServerActionRuntimeBinding = Pick<
  ExtensionActionContribution,
  "execute" | "isListed"
>;

const SERVER_ACTION_PROVENANCE = {
  packageName: "openwork-server",
  source: "bundled",
};

export function extensionActionRegistrationId(extensionId: string, action: string): string {
  return `${extensionId}/${action}`;
}

export function createExtensionActionRegistry(
  contributions: readonly ExtensionActionContribution[],
): ExtensionActionRegistryPort {
  const registry = createContributionRegistry<
    ServerActionRegistrationDescriptor,
    undefined,
    ServerActionRuntimeBinding
  >({ supportedContractVersions: [CONTRIBUTION_CONTRACT_VERSION] });

  contributions.forEach((contribution, order) => {
    const descriptor: ServerActionRegistrationDescriptor = {
      id: extensionActionRegistrationId(
        contribution.descriptor.extensionId,
        contribution.descriptor.action,
      ),
      kind: "server-extension-action",
      contractVersion: CONTRIBUTION_CONTRACT_VERSION,
      provenance: SERVER_ACTION_PROVENANCE,
      order,
      extensionId: contribution.descriptor.extensionId,
      action: contribution.descriptor.action,
      publicDescriptor: contribution.descriptor,
    };
    const result = registry.register(descriptor, {
      status: "ready",
      create: () => Object.freeze({
        execute: contribution.execute,
        isListed: contribution.isListed,
      }),
    });
    if (result.status === "rejected") {
      throw new Error(`Invalid server extension action composition: ${result.diagnostic.message}`);
    }
  });

  const frozen = registry.freeze();
  if (frozen.status === "invalid") {
    const message = frozen.snapshot.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
    throw new Error(`Invalid server extension action composition: ${message}`);
  }

  const ordered: ExtensionActionContribution[] = [];
  const byId = new Map<string, ExtensionActionContribution>();
  for (const result of registry.constructAll(undefined)) {
    if (result.status !== "constructed") {
      const id = "descriptor" in result ? result.descriptor.id : result.id;
      throw new Error(`Server extension action ${id} could not be constructed.`);
    }
    const contribution = Object.freeze({
      descriptor: result.descriptor.publicDescriptor,
      ...result.value,
    });
    ordered.push(contribution);
    byId.set(result.descriptor.id, contribution);
  }

  return {
    list: () => [...ordered],
    lookup: (extensionId, action) => byId.get(extensionActionRegistrationId(extensionId, action)),
  };
}
