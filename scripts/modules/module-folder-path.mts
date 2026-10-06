// The module folder convention, owned by W0-08 and used only by the graph generator.
// Every consumer (den-api registry test, den-web module UI, the dependency-cruiser
// config, the folder check) reads the `folder` the generator writes into
// module-graph.generated.json, so the convention is implemented once.
//
// Ids are location paths (discovery D44). Each dot-separated segment becomes one folder,
// camelCase -> kebab-case. Group segments (pure namespaces such as `org` or
// `library.connectors.native`) are plain folders that hold module folders and nothing else;
// they are never modules. A sub-module's folder is always inside its parent's folder,
// because the parent is the nearest ancestor id that is a module.
//
//   org.members.teams                          -> org/members/teams
//   ai.gateway                                 -> ai/gateway
//   ai.gateway.openworkModels.analytics        -> ai/gateway/openwork-models/analytics
//   library.connectors.native.googleWorkspace  -> library/connectors/native/google-workspace
//   openworkWeb                                -> openwork-web
export function moduleFolderPath(id: string): string {
  return id
    .split(".")
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())
    .join("/");
}
