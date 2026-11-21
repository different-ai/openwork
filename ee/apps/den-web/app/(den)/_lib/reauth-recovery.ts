export function createReauthQueue<T>() {
  let entries: T[] = [];
  let state: "idle" | "prompting" | "paused" = "idle";

  function clear() {
    const pending = entries;
    entries = [];
    state = "idle";
    return pending;
  }

  return {
    first: () => entries[0],
    clearPaused() {
      return state === "paused" ? clear() : [];
    },
    enqueue(pending: T[], first = false) {
      entries = first ? [...pending, ...entries] : [...entries, ...pending];
      state = "prompting";
    },
    pause() {
      if (state !== "prompting") return false;
      state = "paused";
      return true;
    },
    resume() {
      if (state !== "paused") return false;
      state = "prompting";
      return true;
    },
    takeVerified() {
      return state === "prompting" ? clear() : [];
    },
    clear,
  };
}
