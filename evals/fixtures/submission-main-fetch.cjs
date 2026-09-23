if (process.versions.electron && process.type === "browser") {
  const delegate = globalThis.fetch.bind(globalThis);
  const control = "http://127.0.0.1/__openwork_submission_test_control";
  const state = { armed: false, attempts: 0, release: () => {} };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === control) {
      const command = await new Request(input, init).json();
      if (command.action === "hold") { state.armed = true; state.attempts = 0; }
      else if (command.action === "reject") { state.armed = false; state.release(); }
      else if (command.action !== "state") throw new Error("Invalid submission witness command");
      return Response.json({ witness: "submission-main-fetch-v1", attempts: state.attempts });
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!state.armed || method !== "POST" || !/\/session\/[^/]+\/(prompt_async|prompt)$/.test(url.pathname)) return delegate(input, init);
    state.armed = false;
    state.attempts++;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      state.release = () => { clearTimeout(timer); resolve(); };
    });
    return Response.json({ name: "SubmissionUnavailable", message: "Submission unavailable" }, { status: 503 });
  };
}
