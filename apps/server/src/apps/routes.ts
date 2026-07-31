import { appPermissionSchema, type AppPermission } from "@openwork/app-contract";

import { ApiError } from "../errors.js";
import { addRoute, type RequestContext, type Route } from "../routes/registry.js";
import { AppInstaller, InstallError } from "./installer.js";
import { SourceError } from "./source-github.js";
import type { InstalledAppStore } from "./store.js";

// HTTP surface for the OpenWork Apps platform.
//
// Every route is `host` auth: app management is a desktop-shell action, not
// something a workspace client or a remote collaborator can drive. An app itself
// never reaches these routes at all — apps talk to the capability broker, which
// is a different, much narrower surface.

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

export interface RegisterAppRoutesOptions {
  routes: Route[];
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  installer: AppInstaller;
  store: InstalledAppStore;
  /** Called after any change that must stop a running app immediately. */
  onLifecycleChange: (appId: string, reason: "disabled" | "revoked" | "uninstalled" | "updated") => void;
}

/** Translate the module's typed errors into the server's error shape. */
function toApiError(error: unknown): ApiError {
  if (error instanceof InstallError) {
    const status =
      error.code === "candidate_not_found"
        ? 404
        : error.code === "already_installed" || error.code === "candidate_replayed"
          ? 409
          : error.code === "candidate_expired"
            ? 410
            : 400;
    return new ApiError(status, `app_${error.code}`, error.message, {
      diagnostics: error.diagnostics,
    });
  }
  if (error instanceof SourceError) {
    const status = error.code === "rate_limited" ? 429 : error.code.endsWith("not_found") ? 404 : 400;
    return new ApiError(status, `app_source_${error.code}`, error.message);
  }
  return error instanceof ApiError
    ? error
    : new ApiError(500, "app_internal_error", "That app operation could not be completed.");
}

async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toApiError(error);
  }
}

function readPermissions(body: Record<string, unknown>): AppPermission[] {
  const raw = body.approvedPermissions;
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "app_permission_mismatch", "Approved permissions are required.");
  }
  const parsed = appPermissionSchema.array().safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, "app_permission_mismatch", "The approved permissions were not readable.");
  }
  return parsed.data;
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "app_invalid_request", `${key} is required.`);
  }
  return value.trim();
}

export function registerAppRoutes(options: RegisterAppRoutesOptions): void {
  const { routes, jsonResponse, readJsonBody, installer, store, onLifecycleChange } = options;

  addRoute(routes, "GET", "/apps", "host", async () => {
    const installed = await store.list();
    // Requirements travel with the list so Preferences can explain a
    // "needs setup" state rather than only naming it, without a request per app.
    const requirements: Record<string, unknown> = {};
    for (const record of installed) {
      requirements[record.app_id] = await installer.requirements(record);
    }
    return jsonResponse({ items: installed, requirements, rejected: store.rejectedOnLoad });
  });

  addRoute(routes, "GET", "/apps/:id", "host", async (ctx) => {
    const loaded = await installer.loadInstalled(ctx.params.id);
    if (!loaded) throw new ApiError(404, "app_not_installed", "That app is not installed.");
    return jsonResponse({ record: loaded.record, manifest: loaded.manifest });
  });

  // Preview resolves and verifies without executing anything from the repository.
  addRoute(routes, "POST", "/apps/preview", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const repositoryUrl = readString(body, "repositoryUrl");
    const tag = typeof body.tag === "string" && body.tag.trim() ? body.tag.trim() : undefined;
    const preview = await guard(() =>
      installer.preview({ repositoryUrl, ...(tag === undefined ? {} : { tag }) }),
    );
    return jsonResponse(preview);
  });

  addRoute(routes, "POST", "/apps/install", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const record = await guard(() =>
      installer.install({
        candidateId: readString(body, "candidateId"),
        approvedPermissions: readPermissions(body),
      }),
    );
    return jsonResponse({ record }, 201);
  });

  addRoute(routes, "POST", "/apps/:id/enable", "host", async (ctx) => {
    const record = await guard(() => installer.enable(ctx.params.id));
    return jsonResponse({ record });
  });

  addRoute(routes, "POST", "/apps/:id/disable", "host", async (ctx) => {
    const record = await guard(() => installer.disable(ctx.params.id));
    onLifecycleChange(ctx.params.id, "disabled");
    return jsonResponse({ record });
  });

  addRoute(routes, "POST", "/apps/:id/setup/refresh", "host", async (ctx) => {
    const record = await guard(() => installer.refreshSetup(ctx.params.id));
    if (!record) throw new ApiError(404, "app_not_installed", "That app is not installed.");
    if (record.enablement === "disabled") onLifecycleChange(ctx.params.id, "disabled");
    return jsonResponse({ record });
  });

  addRoute(routes, "POST", "/apps/:id/permissions/revoke", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const record = await guard(() =>
      installer.revokePermission(ctx.params.id, readString(body, "permission")),
    );
    onLifecycleChange(ctx.params.id, "revoked");
    return jsonResponse({ record });
  });

  addRoute(routes, "POST", "/apps/:id/update", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const result = await guard(() =>
      installer.update({
        appId: ctx.params.id,
        candidateId: readString(body, "candidateId"),
        approvedPermissions: readPermissions(body),
        permissionsReviewed: body.permissionsReviewed === true,
      }),
    );
    if (result.applied) onLifecycleChange(ctx.params.id, "updated");
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/apps/:id/update/approve", "host", async (ctx) => {
    const record = await guard(() => installer.approvePendingUpdate(ctx.params.id));
    onLifecycleChange(ctx.params.id, "updated");
    return jsonResponse({ record });
  });

  addRoute(routes, "POST", "/apps/:id/rollback", "host", async (ctx) => {
    const record = await guard(() => installer.rollback(ctx.params.id));
    onLifecycleChange(ctx.params.id, "updated");
    return jsonResponse({ record });
  });

  addRoute(routes, "DELETE", "/apps/:id", "host", async (ctx) => {
    // The retention choice is explicit. Defaulting to deletion would destroy
    // data a user may want when they reinstall; defaulting to keeping it would
    // leave data behind after someone asked for the app to be gone. So the
    // client must say which, and the audit trail records the answer.
    const deleteData = ctx.url.searchParams.get("deleteData");
    if (deleteData !== "true" && deleteData !== "false") {
      throw new ApiError(
        400,
        "app_invalid_request",
        "Say whether to delete this app's data: deleteData=true or deleteData=false.",
      );
    }
    onLifecycleChange(ctx.params.id, "uninstalled");
    const result = await guard(() =>
      installer.uninstall(ctx.params.id, { deleteData: deleteData === "true" }),
    );
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/apps/:id/audit", "host", async (ctx) => {
    const limitRaw = Number(ctx.url.searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 100;
    return jsonResponse({ items: await store.auditHistory(limit, ctx.params.id) });
  });
}

export type { RequestContext };
