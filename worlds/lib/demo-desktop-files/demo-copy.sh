#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || { echo 'Usage: demo-copy.sh <prompt-name>' >&2; exit 2; }
jq -e -j --arg name "$1" '.[$name] | select(type == "string")' "$HOME/demo/prompts.json" | "$HOME/demo/type-file.sh" -
