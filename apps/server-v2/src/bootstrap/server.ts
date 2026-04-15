import { createApp } from "../app.js";
import { createAppDependencies, type AppDependencies } from "../context/app-dependencies.js";

export type StartServerOptions = {
  dependencies?: AppDependencies;
  host?: string;
  port?: number;
  silent?: boolean;
};

export type StartedServer = {
  app: ReturnType<typeof createApp>;
  dependencies: AppDependencies;
  host: string;
  port: number;
  server: Bun.Server<unknown>;
  stop(): Promise<void>;
  url: string;
};

function resolvePort(value: number | undefined) {
  if (value === undefined) {
    return 3100;
  }

  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return value;
}

export function startServer(options: StartServerOptions = {}): StartedServer {
  const dependencies = options.dependencies ?? createAppDependencies();
  const host = options.host ?? process.env.OPENWORK_SERVER_V2_HOST ?? "127.0.0.1";
  const port = resolvePort(options.port ?? Number.parseInt(process.env.OPENWORK_SERVER_V2_PORT ?? "3100", 10));
  const app = createApp({ dependencies });
  const server = Bun.serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });
  const url = server.url.toString();
  const resolvedPort = new URL(url).port;

  if (!options.silent) {
    console.info(
      JSON.stringify({
        host,
        port: Number(resolvedPort || port),
        scope: "openwork-server-v2.start",
        url,
      }),
    );
  }

  return {
    app,
    dependencies,
    host,
    port: Number(resolvedPort || port),
    server,
    async stop() {
      server.stop(true);
    },
    url,
  };
}
