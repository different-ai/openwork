// The module folder convention, owned by W0-08 and used only by the graph generator.
// Every consumer (den-api registry test, den-web module UI, the dependency-cruiser
// config, the folder check) reads the `folder` the generator writes into
// module-graph.generated.json, so the convention is implemented once.
//
//   aiGateway              -> ai-gateway
//   aiGateway.usageLimits  -> ai-gateway/usage-limits
export function moduleFolderPath(id: string): string {
  return id
    .split(".")
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())
    .join("/");
}
