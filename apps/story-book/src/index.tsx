const LOCAL_UI_KEY = "openwork.global.dat:local.ui";
const LOCAL_PREFS_KEY = "openwork.global.dat:local.preferences";

try {
  if (!window.localStorage.getItem(LOCAL_UI_KEY)) {
    window.localStorage.setItem(
      LOCAL_UI_KEY,
      JSON.stringify({ view: "dashboard", tab: "settings" }),
    );
  }

  if (!window.localStorage.getItem(LOCAL_PREFS_KEY)) {
    window.localStorage.setItem(
      LOCAL_PREFS_KEY,
      JSON.stringify({
        showThinking: false,
        modelVariant: null,
        defaultModel: null,
      }),
    );
  }
} catch {
  // ignore storage errors in the wrapper app
}

void import("../../app/src/index");
