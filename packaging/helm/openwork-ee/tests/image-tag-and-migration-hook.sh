#!/usr/bin/env bash
# Image tag pinning and migration hook defaults.
#
# - With image.tag unset, every image renders with the chart appVersion, which
#   the publish workflow stamps via `helm package --app-version <release>`.
# - image.tag and per-component tags still override that default.
# - Every shipped example values file renders the same tag for every image.
# - The migration hook keeps a retry-safe delete policy and a deadline sized for
#   a cold image pull.
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -F -q -- "$needle" "$file"; then
    printf 'Expected rendered chart to contain %s\n' "$needle" >&2
    return 1
  fi
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -F -q -- "$needle" "$file"; then
    printf 'Expected rendered chart not to contain %s\n' "$needle" >&2
    return 1
  fi
}

# Every `image:` line in the rendered output must end with the expected tag.
assert_all_image_tags() {
  local file="$1"
  local expected_tag="$2"
  local images
  images="$(grep -E '^[[:space:]]+image: ' "$file" | sed -E 's/^[[:space:]]+image: "?([^"]+)"?$/\1/')"
  if [[ -z "$images" ]]; then
    printf 'Expected rendered chart to contain image lines\n' >&2
    return 1
  fi
  while IFS= read -r image; do
    if [[ "$image" != *":$expected_tag" ]]; then
      printf 'Expected image %s to use tag %s\n' "$image" "$expected_tag" >&2
      return 1
    fi
  done <<< "$images"
}

# 1. Checkout default: image.tag is blank and falls back to Chart.yaml appVersion.
chart_app_version="$(sed -n -E 's/^appVersion: *"?([^"]+)"?$/\1/p' "$chart_dir/Chart.yaml")"
default_rendered="$tmp_dir/default.yaml"
helm template openwork-ee "$chart_dir" --set inference.enabled=true > "$default_rendered"
assert_all_image_tags "$default_rendered" "$chart_app_version"
assert_not_contains "$default_rendered" ':latest"'

# 2. Published shape: `helm package --version X --app-version X` pins images to X.
published_version="0.99.123"
helm package "$chart_dir" --version "$published_version" --app-version "$published_version" --destination "$tmp_dir" > /dev/null
published_rendered="$tmp_dir/published.yaml"
helm template openwork-ee "$tmp_dir/openwork-ee-$published_version.tgz" --set inference.enabled=true > "$published_rendered"
assert_all_image_tags "$published_rendered" "$published_version"
assert_contains "$published_rendered" "ghcr.io/different-ai/openwork-den-api:$published_version"
assert_contains "$published_rendered" "ghcr.io/different-ai/openwork-den-web:$published_version"
assert_contains "$published_rendered" "ghcr.io/different-ai/openwork-inference:$published_version"

# 3. image.tag overrides appVersion; a component tag overrides image.tag.
override_rendered="$tmp_dir/override.yaml"
helm template openwork-ee "$tmp_dir/openwork-ee-$published_version.tgz" \
  --set image.tag=1.2.3 --set denWeb.image.tag=9.9.9 > "$override_rendered"
assert_contains "$override_rendered" 'ghcr.io/different-ai/openwork-den-api:1.2.3"'
assert_contains "$override_rendered" 'ghcr.io/different-ai/openwork-den-web:9.9.9"'
assert_not_contains "$override_rendered" ":$published_version\""

# 4. Every shipped example values file renders one consistent tag for all images.
for example in "$chart_dir"/examples/values.*.yaml; do
  example_rendered="$tmp_dir/$(basename "$example").rendered.yaml"
  helm template openwork-ee "$chart_dir" -f "$example" > "$example_rendered"
  example_tag="$(sed -n -E 's/^  tag: *"?([^"]+)"?$/\1/p' "$example" | head -n 1)"
  if [[ -z "$example_tag" ]]; then
    printf 'Expected %s to set image.tag\n' "$example" >&2
    exit 1
  fi
  assert_all_image_tags "$example_rendered" "$example_tag"
done

# 5. Migration hook: retry-safe delete policy and a deadline that survives a cold pull.
assert_contains "$default_rendered" '"helm.sh/hook": pre-install,pre-upgrade'
assert_contains "$default_rendered" '"helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded"'
assert_contains "$default_rendered" 'activeDeadlineSeconds: 1800'
assert_contains "$default_rendered" 'backoffLimit: 2'

printf 'image-tag-and-migration-hook chart checks passed\n'
