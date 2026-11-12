import { Server } from "lucide-react";
import { getDeploymentsRoute, permissionLockReason } from "../../../../_lib/den-org";
import { defineFeatureIntro, type FeatureIntroContext } from "../types";
import { docsPage } from "./docs";
import { DeploymentsExample } from "./examples/settings/deployments-example";

/**
 * Facts Manage › Deployments reports from data it already loads
 * (`GET /v1/managed-deployments` and `/configuration`). Only reported while the
 * `managedDeployments` feature is on and the viewer can see deployments.
 */
export type DeploymentsFacts = {
  deployments?: number;
  /** AWS or Google Cloud has a published, configured installer (`providers[].available`). */
  cloudReady?: boolean;
};

type Ctx = FeatureIntroContext<DeploymentsFacts>;

const PATH = getDeploymentsRoute();
/** `?new=1` opens the Create deployment form (DESIGN.md I5). */
export const DEPLOYMENTS_NEW_ROUTE = `${PATH}?new=1`;

export const deploymentsIntros = [
  defineFeatureIntro<DeploymentsFacts>({
    key: "deployments",
    version: 1,
    match: { path: PATH },
    icon: Server,
    title: "Deployments",
    summary: "Run your own OpenWork in your company's cloud account, at your own address.",
    highlights: [
      { title: "AWS or Google Cloud.", text: "OpenWork installs in your account or project. Your cloud bills you for what it runs." },
      { title: "You approve every change.", text: "Installs and updates start only after you approve them in your cloud account." },
      { title: "Health at a glance.", text: "API, database, backups and the HTTPS certificate, reported every 5 minutes." },
      { title: "Your sign-in stays yours.", text: "The first administrator's sign-in code stays in your cloud's secret store." },
    ],
    example: {
      Component: DeploymentsExample,
      alt: "Example: Production at openwork.acme.com on AWS in us-east-1, version 0.18.4, operational, with API, database, backups and HTTPS certificate checks passing.",
    },
    docsUrl: docsPage("self-host/deploy-to-your-cloud/managed-installer"),
    ctas: [
      { when: (ctx: Ctx) => ctx.can("canManageDeployments") && ctx.facts.cloudReady === true, label: "Create a deployment", href: DEPLOYMENTS_NEW_ROUTE },
      {
        when: (ctx: Ctx) => ctx.can("canManageDeployments"),
        label: "Create a deployment",
        href: DEPLOYMENTS_NEW_ROUTE,
        locked: { reason: "No cloud installer is ready yet. An OpenWork operator must publish and configure one." },
      },
      { when: () => true, label: "Create a deployment", href: DEPLOYMENTS_NEW_ROUTE, locked: { reason: permissionLockReason("deployments.manage") } },
    ],
    setupState: (ctx) => {
      if (ctx.facts.deployments === undefined) return "done";
      return ctx.facts.deployments > 0 ? "done" : "none";
    },
  }),
];
