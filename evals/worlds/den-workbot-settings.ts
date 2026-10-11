import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { preScrollCenterHitTest } from "../helpers/ui-witnesses.ts";
import { enableOrganizationCapabilities } from "./dashboards.ts";
import { isRecord, records } from "./library.ts";

const MODELS = [
  { id: "fixture/atlas", name: "Atlas planning" },
  { id: "fixture/beacon", name: "Beacon reporting" },
  { id: "fixture/cedar", name: "Cedar meeting notes" },
  { id: "fixture/delta", name: "Delta release coordination" },
  { id: "fixture/elm", name: "Elm checklist review" },
  { id: "fixture/finch", name: "Finch account research" },
  { id: "fixture/grove", name: "Grove project planning" },
  { id: "fixture/harbor", name: "Harbor document review" },
  { id: "fixture/iris", name: "Iris follow-ups" },
  { id: "fixture/juniper", name: "Juniper launch readiness" },
  { id: "fixture/kestrel", name: "Kestrel status reporting with a deliberately long model label for narrow screens" },
  { id: "fixture/willow", name: "WillowWithoutAnyWordBreaksToStressNarrowModelMenusAndKeepTheSelectionIndicatorVisible" },
];

/** Only the runner's catalog is a fixture; Den ownership, permissions, save and Undo are real. */
export async function denWorkbotSettings(seed: Seed, { place }: { place: Place }, modelCount = MODELS.length) {
  if (place.kind !== "local") throw new SkipError("the deterministic runner catalog runs next to a local Den");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  const models = MODELS.slice(0, modelCount);
  const defaultModel = models[0];
  if (!defaultModel) throw new Error("The runner catalog needs a default model");
  const token = randomBytes(32).toString("base64url");
  const requests: { method: string; path: string; authorized: boolean }[] = [];
  const runner = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://runner.invalid").pathname;
    const authorized = request.headers.authorization === `Bearer ${token}`;
    requests.push({ method: request.method ?? "GET", path, authorized });
    response.setHeader("content-type", "application/json");
    if (!authorized) {
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    } else if (request.method === "GET" && path === "/v1/models") {
      response.end(JSON.stringify({ defaultModel: defaultModel.id, models }));
    } else {
      response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    runner.once("error", reject);
    runner.listen(0, "127.0.0.1", resolve);
  });
  const address = runner.address();
  if (!address || typeof address === "string") throw new Error("The runner catalog did not bind");
  const stopRunner = async () => {
    runner.closeAllConnections();
    await new Promise<void>((resolve) => runner.close(() => resolve()));
  };

  try {
    const den = await seed.den({
      web: true,
      env: {
        NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
        DEN_HEADLESS_RUNNER_URL: `http://127.0.0.1:${address.port}`, DEN_HEADLESS_RUNNER_TOKEN: token,
        RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
      },
      org: {
        name: "Model settings proof workspace",
        admin: { name: "Model Owner", email: "model-owner@example.test" },
        members: { reader: { name: "Model Reader", email: "model-reader@example.test" } },
      },
    });
    const reader = den.members.reader;
    if (!reader) throw new Error("The read-only member was not provisioned");
    const orgId = await enableOrganizationCapabilities(seed, den.admin, {
      workbot: true, workbotDefaultModel: true, permissions: true,
    });
    const context = await seed.api(den.admin, "/v1/org");
    const membership = isRecord(context.body)
      ? records(context.body.members).find((entry) => isRecord(entry.user) && entry.user.email === reader.email)
      : undefined;
    if (typeof membership?.id !== "string") throw new Error("The reader's membership is missing");
    const team = await seed.api(den.admin, "/v1/teams", {
      method: "POST", body: JSON.stringify({ name: "Model viewers", memberIds: [membership.id] }),
    });
    const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
    if (!team.response.ok || typeof teamId !== "string") throw new Error(`Could not create model viewers: ${team.text}`);
    const permission = await seed.api(den.admin, "/v1/permissions/sets", {
      method: "POST", body: JSON.stringify({ teamId, permissions: [{ key: "inference.view", status: "allow" }] }),
    });
    if (!permission.response.ok) throw new Error(`Could not allow viewing model settings: ${permission.text}`);
    const viewport = { width: 1440, height: 900 };
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport });
    const readerWeb = await seed.web({ den, signedInAs: reader, startPath: "/dashboard/workbot-settings", headless: true, viewport });
    return {
      den, web, reader, readerWeb, orgId, models, defaultModel,
      runnerRequests: () => requests.map((request) => ({ ...request })),
      optionHitTest: (index: number) => preScrollCenterHitTest(web, '[role="option"]', index),
      async [Symbol.asyncDispose]() { await stopRunner(); },
    };
  } catch (error) {
    await stopRunner();
    throw error;
  }
}

/** The same real settings screen with a short catalog and no search field. */
export function denWorkbotSettingsShortList(seed: Seed, context: { place: Place }) {
  return denWorkbotSettings(seed, context, 3);
}
