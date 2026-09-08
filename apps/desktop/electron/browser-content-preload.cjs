const { ipcRenderer } = require("electron");

// Only the main frame's isolated world can report safety. No bridge is exposed
// to page scripts. Latches start before DOMContentLoaded and live for the whole
// document, including controls/scripts that are subsequently removed.
if (process.isMainFrame) {
  let generation = null;
  let interaction = false;
  let documentRisk = false;
  let lastReason;
  let armedClose = null;
  let cancelledClose = null;
  let lastCloseToken = 0;
  const riskySelector = "script,noscript,form,input,textarea,select,button,[contenteditable],iframe,frame,frameset,audio,video,object,embed,canvas,svg,template,[download]";
  function protectDocument() {
    documentRisk = true;
    observer.disconnect();
  }
  function inspectElement(root) {
    if (root.nodeType === 1 && (root.matches(riskySelector) || root.localName.includes("-") || root.shadowRoot ||
        [...root.attributes].some((attr) => attr.name.startsWith("on")))) protectDocument();
  }
  function inspectSubtree(root, seen = new Set()) {
    const pending = [root];
    while (pending.length && !documentRisk && !interaction) {
      const node = pending.pop();
      if (seen.has(node)) continue;
      seen.add(node);
      inspectElement(node);
      if (documentRisk) return;
      for (const child of node.children ?? []) pending.push(child);
    }
  }
  function report(token, fullScan = false) {
    if (!documentRisk && !interaction) {
      try {
        inspectMutations(observer.takeRecords());
        if (fullScan) inspectSubtree(document);
      } catch { protectDocument(); }
    }
    return { generation, token, url: location.href,
      reason: interaction ? "interaction" : documentRisk ? "document-risk" :
        document.readyState !== "complete" ? "loading" :
        document.designMode !== "off" || history.state !== null ? "document-state" : null };
  }
  function send(fullScan = false) {
    if (generation === null) return;
    const next = report(undefined, fullScan);
    if (next.reason === lastReason) return;
    lastReason = next.reason;
    ipcRenderer.send("openwork:browser:safety-report", next);
  }
  for (const event of ["pointerdown", "keydown", "beforeinput", "input", "change", "drop", "paste", "submit"]) {
    window.addEventListener(event, () => {
      if (interaction) return;
      interaction = true;
      observer.disconnect();
      send();
    }, { capture: true });
  }
  function inspectMutations(records) {
    // A batch can mention overlapping added/removed trees. Visit each node at
    // most once, and never walk the unchanged subtree of a mutation's target.
    const seen = new Set();
    for (const record of records) {
      if (documentRisk || interaction) return;
      if (record.attributeName?.startsWith("on") || record.attributeName === "contenteditable" || record.attributeName === "download") {
        protectDocument();
        return;
      }
      inspectElement(record.target);
      for (const nodes of [record.addedNodes, record.removedNodes]) {
        for (const node of nodes) {
          if (documentRisk || interaction) return;
          inspectSubtree(node, seen);
        }
      }
    }
  }
  const observer = new MutationObserver((records) => {
    if (documentRisk || interaction) return;
    try { inspectMutations(records); }
    catch { protectDocument(); }
    send();
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true });
  ipcRenderer.on("openwork:browser:safety-init", (_event, payload) => {
    // A document cannot adopt a later navigation's generation.
    const initial = generation === null;
    if (initial) generation = payload.generation;
    send(initial);
  });
  ipcRenderer.on("openwork:browser:safety-probe", (_event, payload) => {
    if (generation === null || payload.generation !== generation) return;
    if (payload.arm === true && Number.isSafeInteger(payload.token) && payload.token > lastCloseToken && !armedClose && !cancelledClose) {
      lastCloseToken = payload.token;
      armedClose = { token: payload.token, generation };
      window.addEventListener("beforeunload", checkSuspensionClose, { capture: true });
    }
    ipcRenderer.send("openwork:browser:safety-report", {
      ...report(payload.token, true), armed: Boolean(armedClose && armedClose.token === payload.token),
    });
  });
  ipcRenderer.on("openwork:browser:safety-disarm", (_event, payload) => {
    const attempt = armedClose || cancelledClose;
    if (!attempt || payload.generation !== generation || payload.generation !== attempt.generation || payload.token !== attempt.token) return;
    armedClose = null;
    // A timed-out native close cannot be recalled. Disable IPC but retain a
    // local veto until main acknowledges cancellation, rather than allow an
    // unchecked late close. This listener exists only for that pending attempt.
    cancelledClose = payload.closePending === true ? attempt : null;
    if (!cancelledClose) window.removeEventListener("beforeunload", checkSuspensionClose, { capture: true });
  });
  function checkSuspensionClose(event) {
    const attempt = armedClose;
    let allowed = false;
    if (attempt && !cancelledClose) {
      armedClose = null;
      window.removeEventListener("beforeunload", checkSuspensionClose, { capture: true });
      // Consume the arm before calling main. Ordinary marker navigation never
      // installs this listener or sends synchronous IPC, and retries need a new
      // token. Unknown replies, stale generations and exceptions all veto.
      try {
        const next = { ...report(attempt.token, true), armed: true };
        if (attempt.generation === generation) {
          const authorized = ipcRenderer.sendSync("openwork:browser:safety-close", next);
          allowed = authorized === true && next.reason === null;
        }
      } catch { /* Fail closed without leaving a synchronous unload listener. */ }
    }
    if (!allowed) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
}

function dismissMenuOverlay() {
  ipcRenderer.send("openwork:menu-overlay:dismiss");
}

function installDismissListeners() {
  window.addEventListener("pointerdown", dismissMenuOverlay, { capture: true });
  window.addEventListener("wheel", dismissMenuOverlay, { capture: true, passive: true });
  window.addEventListener("keydown", dismissMenuOverlay, { capture: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installDismissListeners, { once: true });
} else {
  installDismissListeners();
}
