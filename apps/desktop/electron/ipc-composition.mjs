const IPC_REGISTRATION_KINDS = new Set(["handle", "listen"]);

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function defineIpcRegistration(kind, channel, handler) {
  if (!IPC_REGISTRATION_KINDS.has(kind)) {
    throw new Error(`Unsupported Electron IPC registration kind: ${kind}`);
  }
  const normalizedChannel = requireNonEmptyString(channel, "Electron IPC channel");
  if (typeof handler !== "function") {
    throw new Error(`Electron IPC handler for ${normalizedChannel} must be a function.`);
  }
  return Object.freeze({
    descriptor: Object.freeze({ kind, channel: normalizedChannel }),
    handler,
  });
}

export function ipcHandle(channel, handler) {
  return defineIpcRegistration("handle", channel, handler);
}

export function ipcListener(channel, handler) {
  return defineIpcRegistration("listen", channel, handler);
}

export function defineIpcContribution({ id, registrations }) {
  const normalizedId = requireNonEmptyString(id, "Electron IPC contribution id");
  if (!Array.isArray(registrations) || registrations.length === 0) {
    throw new Error(`Electron IPC contribution ${normalizedId} must declare at least one registration.`);
  }
  return Object.freeze({
    id: normalizedId,
    registrations: Object.freeze([...registrations]),
  });
}

function inventoryEntries(owner, kind, channels) {
  return channels.map((channel) => Object.freeze({ owner, kind, channel }));
}

// Compatibility inventory captured from the Electron shell before registration
// was centralized. The composition root asserts this exact ordered inventory at
// startup, so moving or removing an IPC surface must be an explicit contract
// change rather than an incidental refactor.
export const ELECTRON_IPC_INVENTORY_V1 = Object.freeze([
  ...inventoryEntries("openwork.desktop-command-bridge.v1", "handle", [
    "openwork:desktop",
  ]),
  ...inventoryEntries("openwork.shell.v1", "handle", [
    "openwork:shell:openExternal",
    "openwork:shell:relaunch",
  ]),
  ...inventoryEntries("openwork.system.v1", "handle", [
    "openwork:system:architecture",
    "openwork:system:microphoneStatus",
    "openwork:system:askMicrophoneAccess",
  ]),
  ...inventoryEntries("openwork.terminal.v1", "handle", [
    "openwork:terminal:create",
    "openwork:terminal:write",
    "openwork:terminal:resize",
    "openwork:terminal:kill",
  ]),
  ...inventoryEntries("openwork.browser-panel.v1", "handle", [
    "openwork:browser:show",
    "openwork:browser:hide",
    "openwork:browser:openUrl",
    "openwork:browser:navigate",
    "openwork:browser:back",
    "openwork:browser:forward",
    "openwork:browser:reload",
    "openwork:browser:bounds",
    "openwork:browser:state",
    "openwork:browser:createTab",
    "openwork:browser:closeTab",
    "openwork:browser:closeAllTabs",
    "openwork:browser:selectTab",
    "openwork:browser:reorderTabs",
    "openwork:browser:listTabs",
    "openwork:browser:setProxy",
    "openwork:browser:getProxy",
    "openwork:browser:tabContextMenu",
    "openwork:browser:destroy",
  ]),
  ...inventoryEntries("openwork.browser-panel.v1", "listen", [
    "openwork:menu-overlay:ready",
    "openwork:menu-overlay:choose",
    "openwork:menu-overlay:close",
    "openwork:menu-overlay:dismiss",
  ]),
  ...inventoryEntries("openwork.tauri-migration.v1", "handle", [
    "openwork:migration:read",
    "openwork:migration:ack",
  ]),
  ...inventoryEntries("openwork.updater.v1", "handle", [
    "openwork:updater:getChannel",
    "openwork:updater:setChannel",
    "openwork:updater:check",
    "openwork:updater:download",
    "openwork:updater:installAndRestart",
  ]),
]);

export function assertIpcInventory(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    throw new Error("Electron IPC inventories must be arrays.");
  }
  if (actual.length !== expected.length) {
    throw new Error(`Electron IPC inventory mismatch: expected ${expected.length} registrations, received ${actual.length}.`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actualEntry = actual[index];
    const expectedEntry = expected[index];
    if (
      actualEntry?.owner !== expectedEntry?.owner ||
      actualEntry?.kind !== expectedEntry?.kind ||
      actualEntry?.channel !== expectedEntry?.channel
    ) {
      throw new Error(
        `Electron IPC inventory mismatch at index ${index}: expected ` +
        `${expectedEntry?.owner}/${expectedEntry?.kind}/${expectedEntry?.channel}, received ` +
        `${actualEntry?.owner}/${actualEntry?.kind}/${actualEntry?.channel}.`,
      );
    }
  }
}

export function composeElectronIpc({ ipcMain, contributions, expectedInventory = undefined }) {
  if (!ipcMain || typeof ipcMain.handle !== "function" || typeof ipcMain.on !== "function") {
    throw new Error("Electron IPC composition requires ipcMain.handle and ipcMain.on.");
  }
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw new Error("Electron IPC composition requires at least one contribution.");
  }

  const contributionIds = new Set();
  const channels = new Set();
  const inventory = [];

  // Validate the complete graph before touching ipcMain. Duplicate, malformed,
  // or incompatible inventories therefore leave no partial registration.
  for (const contribution of contributions) {
    const id = requireNonEmptyString(contribution?.id, "Electron IPC contribution id");
    if (contributionIds.has(id)) {
      throw new Error(`Duplicate Electron IPC contribution id: ${id}`);
    }
    contributionIds.add(id);

    if (!Array.isArray(contribution?.registrations) || contribution.registrations.length === 0) {
      throw new Error(`Electron IPC contribution ${id} must declare at least one registration.`);
    }
    for (const registration of contribution.registrations) {
      const kind = registration?.descriptor?.kind;
      const channel = requireNonEmptyString(registration?.descriptor?.channel, "Electron IPC channel");
      if (!IPC_REGISTRATION_KINDS.has(kind) || typeof registration?.handler !== "function") {
        throw new Error(`Malformed Electron IPC registration in ${id}: ${channel}`);
      }
      if (channels.has(channel)) {
        throw new Error(`Duplicate Electron IPC channel: ${channel}`);
      }
      channels.add(channel);
      inventory.push(Object.freeze({ owner: id, kind, channel }));
    }
  }

  if (expectedInventory) {
    assertIpcInventory(inventory, expectedInventory);
  }

  for (const contribution of contributions) {
    for (const registration of contribution.registrations) {
      const { kind, channel } = registration.descriptor;
      if (kind === "handle") ipcMain.handle(channel, registration.handler);
      else ipcMain.on(channel, registration.handler);
    }
  }

  return Object.freeze({ inventory: Object.freeze(inventory) });
}
