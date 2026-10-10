import QRCode from "qrcode";
import { BridgeError, record, type Host } from "../contract/index.js";
import type { OpenWorkAdapter } from "../adapters/types.js";
import type { Store } from "../storage/store.js";
import type { Pairing } from "../auth/pairing.js";

interface Options {
  store: Store;
  pairing: Pairing;
  adapter: OpenWorkAdapter;
  origin: string;
  host(): Host;
  closeDeviceStreams(id: string): void;
}

/** Host-local controls. These operations are never registered on the phone API. */
export function createLocalControls(options: Options) {
  let closed = false;
  const ready = () => {
    if (closed) throw new BridgeError("BRIDGE_STOPPED");
  };
  const deviceId = (id: string) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))
      throw new BridgeError("INVALID_REQUEST", 400);
    return id;
  };
  const scope = async (value: unknown, allowEmpty = false) => {
    ready();
    if (
      !record(value) ||
      Object.keys(value).some(
        (k) => !["workspaceIds", "allWorkspaces"].includes(k),
      ) ||
      !Array.isArray(value.workspaceIds) ||
      value.workspaceIds.length > 100 ||
      value.workspaceIds.some(
        (w) => typeof w !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(w),
      ) ||
      (value.allWorkspaces !== undefined &&
        typeof value.allWorkspaces !== "boolean")
    )
      throw new BridgeError("INVALID_REQUEST", 400);
    const workspaces = await options.adapter.listWorkspaces();
    ready();
    if (
      (!allowEmpty &&
        value.allWorkspaces !== true &&
        !value.workspaceIds.length) ||
      value.workspaceIds.some((id) => !workspaces.some((w) => w.id === id))
    )
      throw new BridgeError("INVALID_REQUEST", 400);
    return {
      workspaceIds: [...new Set(value.workspaceIds)] as string[],
      allWorkspaces: value.allWorkspaces === true,
    };
  };
  return {
    async state() {
      ready();
      const workspaces = await options.adapter.listWorkspaces();
      ready();
      return {
        host: options.host(),
        workspaces,
        pending: options.pairing.pending(),
        devices: options.store.snapshot.devices
          .filter((d) => !d.revoked)
          .map((d) => ({
            id: d.id,
            name: d.name,
            workspaceIds: d.workspaceIds,
            allWorkspaces: d.allWorkspaces ?? false,
            active: d.active,
          })),
      };
    },
    async pair() {
      ready();
      const payload = options.pairing.start(options.origin);
      const qrSvg = await QRCode.toString(JSON.stringify(payload), {
        type: "svg",
        errorCorrectionLevel: "M",
      });
      ready();
      return {
        payload,
        qrSvg,
        qrDataURL:
          "data:image/svg+xml;base64," + Buffer.from(qrSvg).toString("base64"),
      };
    },
    async approve(id: string, value: unknown) {
      deviceId(id);
      const access = await scope(value);
      await options.pairing.approve(
        id,
        access.workspaceIds,
        access.allWorkspaces,
      );
      return { approved: true };
    },
    async deny(id: string) {
      ready();
      options.pairing.deny(deviceId(id));
      return { denied: true };
    },
    async access(id: string, value: unknown) {
      deviceId(id);
      const access = await scope(value, true);
      await options.store.update((s) => {
        const device = s.devices.find(
          (d) => d.id === id && !d.revoked && d.active,
        );
        if (!device) throw new BridgeError("NOT_FOUND", 404);
        device.workspaceIds = access.workspaceIds;
        device.allWorkspaces = access.allWorkspaces;
      });
      options.closeDeviceStreams(id);
      return { updated: true };
    },
    async revoke(id: string) {
      ready();
      await options.pairing.revoke(deviceId(id));
      options.closeDeviceStreams(id);
      return { revoked: true };
    },
    close() {
      closed = true;
      options.pairing.close();
    },
  };
}
export type LocalControls = ReturnType<typeof createLocalControls>;
