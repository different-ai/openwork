#!/usr/bin/env bash
# Deploys this Worker to a celld fleet's bucket or bucket prefix:
#
#   CELLD_BUCKET=s3://bucket/artifact-storage ARTIFACT_STORAGE_TOKEN_FILE=/path/to/token scripts/celld-deploy.sh
#
# The token is the one Den holds as DEN_ARTIFACT_STORAGE_CELLD_TOKEN (24+ characters), read from
# ARTIFACT_STORAGE_TOKEN_FILE or, failing that, ARTIFACT_STORAGE_TOKEN. celld deploy takes bindings only from the
# Wrangler config, so the token goes into a generated config in a private staging directory (.deploy.*, ignored by
# git) that is deleted afterwards, and from there into
# the fleet's bucket with the deployment. It is never printed. Object-store credentials and settings come from the
# environment as celld reads them (the AWS credential chain, S3_ENDPOINT, AWS_REGION).
#
# Extra arguments go to celld deploy: --dry-run bundles and prints the version without writing anything.
set -euo pipefail
umask 077

project=$(cd "$(dirname "$0")/.." && pwd)
binary=${CELLD_BIN:-celld}
bucket=${CELLD_BUCKET:?set CELLD_BUCKET to the fleet bucket or bucket prefix, such as s3://bucket/artifact-storage}
export CELLD_ESBUILD=${CELLD_ESBUILD:-"$project/node_modules/.bin/esbuild"}
# Staged inside the package (ignored by git), not in the system's temporary directory: the bundle names its modules
# by their path from here, and celld's version is a hash of the bundle. From a fixed place in the repository the same
# source gives the same version on any machine, so deploying it again changes nothing on the nodes.
work=$(mktemp -d "$project/.deploy.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp -R "$project/src" "$work/"
ln -s "$project/node_modules" "$work/node_modules"
node - "$project/wrangler.jsonc" "$work/wrangler.json" <<'JS'
const fs = require("node:fs")
const file = process.env.ARTIFACT_STORAGE_TOKEN_FILE
const token = (file ? fs.readFileSync(file, "utf8") : process.env.ARTIFACT_STORAGE_TOKEN ?? "").trim()
if (token.length < 24) {
  console.error("Set ARTIFACT_STORAGE_TOKEN_FILE or ARTIFACT_STORAGE_TOKEN to the 24+ character token Den uses.")
  process.exit(1)
}
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8").replace(/^\s*\/\/.*$/gm, ""))
config.vars = { ...config.vars, ARTIFACT_STORAGE_TOKEN: token }
fs.writeFileSync(process.argv[3], JSON.stringify(config))
console.error(`Deploying ${config.name} (${config.durable_objects.bindings.map((binding) => binding.class_name).join(", ")})`)
JS

# celld's own output is kept in the private directory: only the deployed version is printed.
if ! "$binary" deploy "$work/wrangler.json" --bucket "$bucket" --json "$@" > "$work/deploy.json" 2> "$work/deploy.err"; then
  grep -v 'celld::memory' "$work/deploy.err" | tail -20 >&2
  exit 1
fi
node -e '
const text = require("node:fs").readFileSync(process.argv[1], "utf8")
const deployed = JSON.parse(text.slice(text.indexOf("{")))
if (typeof deployed.version !== "string") throw new Error("celld deploy did not report a version")
console.log(`version ${deployed.version}`)' "$work/deploy.json"
