export const COMPOSER_SPELLCHECK_ENABLED_KEY = "openwork.react.settings.composer-spellcheck";
export const COMPOSER_SPELLCHECK_CHANGED_EVENT = "openwork-composer-spellcheck-changed";

export function readComposerSpellcheckEnabled() {
  try {
    return window.localStorage.getItem(COMPOSER_SPELLCHECK_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeComposerSpellcheckEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(COMPOSER_SPELLCHECK_ENABLED_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage failures.
  }
}

export function applySpellcheckToEditableRoot(root: ParentNode, enabled: boolean) {
  const selector = '[contenteditable="true"], textarea';
  root.querySelectorAll(selector).forEach((element) => {
    if (!(element instanceof HTMLElement)) return;
    element.spellcheck = enabled;
    element.setAttribute("spellcheck", enabled ? "true" : "false");
  });
}

export function watchSpellcheckOnEditableRoot(root: ParentNode, enabled: boolean) {
  applySpellcheckToEditableRoot(root, enabled);
  const observer = new MutationObserver(() => {
    applySpellcheckToEditableRoot(root, enabled);
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["contenteditable"] });
  return () => observer.disconnect();
}
