import { createHash } from "node:crypto";
import {
  BridgeError,
  PreflightError,
  record,
  type ModelSelection,
  type ModelSettings,
  type SavedPermissions,
} from "../contract/index.js";
type Request = (
  route: string,
  method?: string,
  body?: unknown,
) => Promise<unknown>;
const object = (v: unknown) => {
  if (!record(v)) throw new BridgeError("INVALID_UPSTREAM", 502);
  return v;
};
const array = (v: unknown) => {
  if (!Array.isArray(v) || v.length > 2000)
    throw new BridgeError("INVALID_UPSTREAM", 502);
  return v;
};
const text = (v: unknown, max = 200) => {
  if (typeof v !== "string" || !v.length || v.length > max)
    throw new BridgeError("INVALID_UPSTREAM", 502);
  return v;
};
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class UpstreamControls {
  constructor(
    private request: Request,
    private base: string,
  ) {}
  private async rawSession(sid: string) {
    const s = object(
      object(await this.request(this.base + "/session/" + sid)).data,
    );
    if (s.id !== sid) throw new BridgeError("NOT_FOUND", 404);
    return s;
  }
  async model(sid: string): Promise<ModelSettings> {
    const session = await this.rawSession(sid),
      m = object(session.model);
    const current: ModelSelection = {
      providerId: text(m.providerID),
      modelId: text(m.id),
      variant:
        typeof m.variant === "string" && m.variant !== "default"
          ? text(m.variant, 80)
          : null,
    };
    const catalog = object(await this.request(this.base + "/model"));
    const models = array(catalog.data)
      .map(object)
      .filter((m) => m.enabled === true)
      .map((m) => ({
        providerId: text(m.providerID),
        modelId: text(m.id),
        name: text(m.name ?? m.id, 256),
        variants: [
          ...new Set(
            array(m.variants ?? []).map((v) => text(object(v).id, 80)),
          ),
        ],
      }));
    return { current, models, revision: hash(current) };
  }
  private async idle(sid?: string) {
    const active = object(
      object(await this.request(this.base + "/session/active")).data,
    );
    if (
      sid
        ? record(active[sid]) && active[sid].type === "running"
        : Object.values(active).some((v) => record(v) && v.type === "running")
    )
      throw new PreflightError("CHAT_BUSY", 409);
  }
  async setModel(sid: string, model: ModelSelection, revision: string) {
    const current = await this.model(sid);
    if (current.revision !== revision)
      throw new PreflightError("STALE_SETTINGS", 409);
    const choice = current.models.find(
      (m) => m.providerId === model.providerId && m.modelId === model.modelId,
    );
    if (
      !choice ||
      (model.variant !== null && !choice.variants.includes(model.variant))
    )
      throw new PreflightError("INVALID_MODEL", 422);
    await this.idle(sid);
    await this.request(this.base + "/session/" + sid + "/model", "POST", {
      model: {
        providerID: model.providerId,
        id: model.modelId,
        ...(model.variant === null ? {} : { variant: model.variant }),
      },
    });
  }
  async permissions(sid: string): Promise<SavedPermissions> {
    const session = await this.rawSession(sid),
      project = text(session.projectID);
    const saved = object(await this.request(this.base + "/permission/saved"));
    const grants = array(saved.data)
      .map(object)
      .filter((g) => g.projectID === project)
      .map((g) => ({
        id: text(g.id),
        action: text(g.action),
        resource: text(g.resource, 32768),
        revision: hash({
          id: g.id,
          projectID: g.projectID,
          action: g.action,
          resource: g.resource,
        }),
      }));
    return {
      grants,
      modeSupported: false,
      modeReason:
        "Workspace approval modes are unavailable in OpenWork v2. You can revoke saved permissions below; pending requests still require your decision.",
    };
  }
  async revoke(sid: string, id: string, revision: string) {
    const current = await this.permissions(sid);
    if (!current.grants.some((g) => g.id === id && g.revision === revision))
      throw new PreflightError("STALE_PERMISSION", 409);
    await this.idle();
    await this.request(this.base + "/permission/saved/" + id, "DELETE");
  }
}
