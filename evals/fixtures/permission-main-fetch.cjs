if (process.versions.electron && process.type === "browser") {
  const delegate = globalThis.fetch.bind(globalThis);
  const control = "http://127.0.0.1/__openwork_permission_test_control";
  let origin = "";
  let mount = "";
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === control) {
      const command = await new Request(input, init).json();
      if (command.action === "configure") {
        const target = new URL(command.origin);
        if (origin || target.origin !== command.origin || target.protocol !== "http:"
          || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
          || !/^\/workspace\/[^/]+\/opencode$/.test(command.mount)) throw new Error("Invalid permission witness origin");
        origin = target.origin;
        mount = command.mount;
      } else if (command.action !== "state") throw new Error("Invalid permission witness command");
      return Response.json({ witness: "permission-main-fetch-v1", requests });
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin !== origin || !url.pathname.startsWith(`${mount}/permission/`) || method !== "POST") return delegate(input, init);
    const body = await new Request(input instanceof Request ? input.clone() : input, init).text();
    const entry = { path: url.pathname, method, body, reply: JSON.parse(body).reply,
      status: null, elapsedMs: null, failed: false, transport: "main" };
    requests.push(entry);
    const start = performance.now();
    try {
      const response = await delegate(input, init);
      entry.status = response.status;
      return response;
    } catch (error) {
      entry.failed = true;
      throw error;
    } finally { entry.elapsedMs = performance.now() - start; }
  };
}
