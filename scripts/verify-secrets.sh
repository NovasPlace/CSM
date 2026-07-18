#!/usr/bin/env bash

set -euo pipefail

readonly GITLEAKS_VERSION='8.30.1'
readonly GITLEAKS_ARCHIVE='gitleaks_8.30.1_linux_x64.tar.gz'
readonly GITLEAKS_SHA256='551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
readonly GITLEAKS_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${GITLEAKS_ARCHIVE}"

tool_dir="$(mktemp -d)"
trap 'rm -rf -- "$tool_dir"' EXIT

curl --fail --silent --show-error --location "$GITLEAKS_URL" --output "$tool_dir/$GITLEAKS_ARCHIVE"
printf '%s  %s\n' "$GITLEAKS_SHA256" "$tool_dir/$GITLEAKS_ARCHIVE" | sha256sum --check --strict
tar -xzf "$tool_dir/$GITLEAKS_ARCHIVE" -C "$tool_dir" gitleaks
"$tool_dir/gitleaks" git --redact --no-banner .
