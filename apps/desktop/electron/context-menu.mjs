// Keep native menu construction in main. The renderer supplies plain action
// descriptions, never Electron templates, roles, callbacks or executable code.
export function contextMenuTemplate(input, select) {
  let count = 0;
  const ids = new Set();
  const visit = (items, depth = 0, parentEnabled = true) => {
    if (!Array.isArray(items) || depth > 4) throw new Error("Invalid context menu.");
    return items.map((item) => {
      if (++count > 256 || !item || typeof item !== "object") throw new Error("Invalid context menu.");
      if (item.type === "separator") return { type: "separator" };
      if (item.type !== "item" || typeof item.id !== "string" || !item.id || item.id.length > 256
        || ids.has(item.id) || typeof item.label !== "string" || !item.label || item.label.length > 1024
        || (item.enabled !== undefined && typeof item.enabled !== "boolean")) throw new Error("Invalid context menu item.");
      ids.add(item.id);
      const enabled = parentEnabled && item.enabled !== false;
      const label = process.platform === "darwin" ? item.label : item.label.replaceAll("&", "&&");
      return {
        id: item.id, label, enabled,
        ...(item.submenu !== undefined
          ? { submenu: visit(item.submenu, depth + 1, enabled) }
          : { click: () => { if (enabled) select(item.id); } }),
      };
    });
  };
  return visit(input);
}

export function editingMenuTemplate(contents, params) {
  const items = [];
  // Chromium flags are authoritative for native context-menu events; composed
  // editor menus use OS editing roles, never commands supplied by the renderer.
  const role = (name, flag) => ({ role: name, ...(params.editFlags ? { enabled: params.editFlags[flag] === true } : {}) });
  if (params.isEditable) {
    if (params.misspelledWord) {
      for (const word of params.dictionarySuggestions.slice(0, 8)) {
        items.push({ label: word, click: () => contents.replaceMisspelling(word) });
      }
      items.push({ label: "Add to Dictionary", click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      items.push({ type: "separator" });
    }
    items.push(role("undo", "canUndo"), role("redo", "canRedo"), { type: "separator" }, role("cut", "canCut"));
  }
  if (params.isEditable || params.selectionText) items.push(role("copy", "canCopy"));
  if (params.isEditable) {
    items.push(role("paste", "canPaste"), { type: "separator" }, role("selectAll", "canSelectAll"));
  }
  return items;
}

// Native popups are invisible to the renderer and to CDP. Describe a template
// with plain data only: no callbacks, and no renderer-supplied fields beyond
// the ones the template builder already whitelisted.
function describeTemplate(template) {
  return template.map((entry) => {
    if (entry.type === "separator") return { type: "separator" };
    return {
      type: "item",
      id: typeof entry.id === "string" ? entry.id : null,
      label: typeof entry.label === "string" ? entry.label : null,
      role: typeof entry.role === "string" ? entry.role : null,
      enabled: entry.enabled !== false,
      ...(Array.isArray(entry.submenu) ? { submenu: describeTemplate(entry.submenu) } : {}),
    };
  });
}

function findTemplateItem(template, id) {
  for (const entry of template) {
    if (entry.type === "separator") continue;
    if (entry.id === id) return entry;
    if (Array.isArray(entry.submenu)) {
      const nested = findTemplateItem(entry.submenu, id);
      if (nested) return nested;
    }
  }
  return null;
}

export function createNativeContextMenus({ Menu, getWindow }) {
  let active = null;
  let last = null;
  const close = () => active?.close();

  /** @returns {Promise<string | null>} */
  function popup(window, build, options, requestId = undefined) {
    close();
    const contents = window.webContents;
    return new Promise((resolve, reject) => {
      let settled = false;
      let menu;
      let shown = null;
      const cleanup = () => {
        window.removeListener("closed", dismiss);
        window.removeListener("blur", dismiss);
        contents.removeListener("destroyed", dismiss);
        contents.removeListener("did-start-navigation", navigate);
        if (active?.menu === menu) active = null;
      };
      const finish = (id) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (shown) last = { ...shown, selectedId: id };
        resolve(id);
      };
      const dismiss = () => {
        finish(null);
        menu?.closePopup(window);
      };
      const navigate = (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) dismiss();
      };
      try {
        const template = build(finish);
        if (!template.length) { finish(null); return; }
        menu = Menu.buildFromTemplate(template);
        shown = { requestId: requestId ?? null, items: describeTemplate(template), point: { x: options.x ?? null, y: options.y ?? null } };
        active = { menu, requestId, close: dismiss, shown, template };
        window.once("closed", dismiss);
        window.once("blur", dismiss);
        contents.once("destroyed", dismiss);
        contents.on("did-start-navigation", navigate);
        menu.popup({ window, ...options, callback: () => finish(null) });
      } catch (error) {
        cleanup();
        settled = true;
        reject(error);
      }
    });
  }

  function show(request) {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(null);
    if (!request || !Number.isFinite(request.point?.x) || !Number.isFinite(request.point?.y)
      || Math.abs(request.point.x) > 100_000 || Math.abs(request.point.y) > 100_000
      || (request.includeEditing !== undefined && typeof request.includeEditing !== "boolean")) {
      return Promise.reject(new Error("Invalid context menu request."));
    }
    const contents = window.webContents;
    const zoom = contents.getZoomFactor();
    const [width, height] = window.getContentSize();
    return popup(window, (select) => {
      const items = contextMenuTemplate(request.items, select);
      if (!request.includeEditing) return items;
      return [...editingMenuTemplate(contents, { isEditable: true }), { type: "separator" }, ...items];
    }, {
      x: Math.max(0, Math.min(width - 1, Math.round(request.point.x * zoom))),
      y: Math.max(0, Math.min(height - 1, Math.round(request.point.y * zoom))),
      ...(contents.focusedFrame ? { frame: contents.focusedFrame } : {}),
    }, request.requestId);
  }

  function isMainFrame(event) {
    const window = getWindow();
    return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  }

  return {
    show,
    close,
    /** Dev-mode observation: the popup on screen and the last one that closed, as plain data. */
    inspect() {
      return { open: active !== null, current: active?.shown ?? null, last };
    },
    /** Dev-mode stand-in for the OS delivering a click on one enabled leaf of the open popup. */
    choose(id) {
      if (!active || typeof id !== "string") return false;
      const item = findTemplateItem(active.template, id);
      if (!item || item.enabled === false || Array.isArray(item.submenu) || typeof item.click !== "function") return false;
      const { close: dismiss } = active;
      item.click();
      // The OS closes the popup after a choice; the selection already settled, so this only tears the menu down.
      dismiss();
      return true;
    },
    showFromRenderer(event, request) {
      if (!isMainFrame(event)) {
        return Promise.reject(new Error("Context menus require the app's main frame."));
      }
      if (typeof request?.requestId !== "string" || !request.requestId || request.requestId.length > 128) {
        return Promise.reject(new Error("A context menu request ID is required."));
      }
      return show(request);
    },
    cancelFromRenderer(event, requestId) {
      if (!isMainFrame(event) || typeof requestId !== "string" || active?.requestId !== requestId) return false;
      close();
      return true;
    },
    showEditing(params) {
      const window = getWindow();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(null);
      return popup(window, () => editingMenuTemplate(window.webContents, params), {
        ...(params.frame ? { frame: params.frame } : {}),
        sourceType: params.menuSourceType,
      });
    },
  };
}
