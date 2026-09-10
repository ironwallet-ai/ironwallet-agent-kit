#!/usr/bin/env bash
# Build ironwallet-mcp-${VERSION}.mcpb from an already-built packages/mcp-server.
# Staging copy of the allow-list, then npm ci --omit=dev, then zip at archive root.
# Does not publish. Output path is printed to stdout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${ROOT}/packages/mcp-server"
OUT_DIR="$(cd "${1:-.}" && pwd)"
MAX_BYTES=$((25 * 1024 * 1024))

for f in manifest.json package.json package-lock.json README.md LICENSE; do
  if [[ ! -f "${SRC}/${f}" ]]; then
    echo "missing ${SRC}/${f}" >&2
    exit 1
  fi
done
if [[ ! -f "${SRC}/dist/cli.js" ]]; then
  echo "missing ${SRC}/dist/cli.js; npm run build first" >&2
  exit 1
fi
if [[ ! -d "${SRC}/assets" ]]; then
  echo "missing ${SRC}/assets" >&2
  exit 1
fi

VERSION="$(node -p "require('${SRC}/package.json').version")"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "package.json version must be X.Y.Z (got ${VERSION:-empty})" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

cp "${SRC}/manifest.json" "${SRC}/package.json" "${SRC}/package-lock.json" \
  "${SRC}/README.md" "${SRC}/LICENSE" "${STAGE}/"
cp -a "${SRC}/dist" "${STAGE}/dist"
cp -a "${SRC}/assets" "${STAGE}/assets"

# Runtime deps only. Do not copy .npmrc (Nexus); always fetch public packages.
# Keep stdout as the mcpb path only — CI captures it.
(
  cd "${STAGE}"
  npm ci --omit=dev --registry=https://registry.npmjs.org >&2
)

if [[ -d "${STAGE}/node_modules/typescript" ]] || [[ -d "${STAGE}/node_modules/tsx" ]]; then
  echo "devDependencies leaked into node_modules" >&2
  exit 1
fi

MCPB="${OUT_DIR}/ironwallet-mcp-${VERSION}.mcpb"
rm -f "${MCPB}"

python3 - "${STAGE}" "${MCPB}" <<'PY'
import os
import sys
import zipfile

stage, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(stage):
        dirs[:] = [d for d in dirs if d not in {".git", "__pycache__"}]
        for name in files:
            if name.endswith((".mcpb", ".log", ".npmrc")):
                continue
            full = os.path.join(root, name)
            zf.write(full, os.path.relpath(full, stage))
PY

python3 - "${MCPB}" <<'PY'
import sys
import zipfile

path = sys.argv[1]
need = {
    "manifest.json",
    "package.json",
    "package-lock.json",
    "README.md",
    "LICENSE",
    "dist/cli.js",
    "assets/logo-mark.png",
}
forbid_prefix = ("src/",)
forbid_exact = {"tools.json", "server.json", "tsconfig.json", ".npmrc"}
with zipfile.ZipFile(path) as zf:
    names = zf.namelist()
missing = [n for n in sorted(need) if n not in names]
if missing:
    raise SystemExit("mcpb missing: " + ", ".join(missing))
if "node_modules/" not in names and not any(n.startswith("node_modules/") for n in names):
    raise SystemExit("mcpb missing node_modules/")
bad = [
    n
    for n in names
    if n in forbid_exact or n.startswith(forbid_prefix) or n.endswith(".mcpb")
]
if bad:
    raise SystemExit("mcpb must not contain: " + ", ".join(sorted(bad)[:20]))
PY

BYTES="$(wc -c <"${MCPB}")"
if (( BYTES > MAX_BYTES )); then
  echo "mcpb is ${BYTES} bytes; Smithery limit is ${MAX_BYTES}" >&2
  exit 1
fi

echo "${MCPB}"
echo "packed ${MCPB} (${BYTES} bytes)" >&2
