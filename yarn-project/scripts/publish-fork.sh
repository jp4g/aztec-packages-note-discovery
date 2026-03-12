#!/usr/bin/env bash
set -euo pipefail

# Publish forked @aztec/pxe and @aztec/wallets to npmjs.org
# under the @jp4g scope as @jp4g/aztec-pxe and @jp4g/aztec-wallets.
#
# Usage:
#   ./yarn-project/scripts/publish-fork.sh [version]
#
# If no version is given, derives one from `git describe` on the fork branch.
# Requires `npm login` to the @jp4g scope (or NPM_TOKEN env var).

PACKAGES=("pxe" "wallets")
SCOPE="@jp4g"
REGISTRY="https://registry.npmjs.org"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YARN_PROJECT="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$YARN_PROJECT")"

# Resolve version and upstream base
RAW=$(cd "$REPO_ROOT" && git describe --tags --always)
RAW="${RAW#v}"

if [[ "$RAW" =~ ^(.+)-([0-9]+)-g[0-9a-f]+$ ]]; then
  UPSTREAM_VERSION="${BASH_REMATCH[1]}"
  COMMITS="${BASH_REMATCH[2]}"
  AUTO_VERSION="${UPSTREAM_VERSION}-fork.${COMMITS}"
else
  UPSTREAM_VERSION="$RAW"
  AUTO_VERSION="$RAW"
fi

if [[ -n "${1:-}" ]]; then
  VERSION="$1"
else
  VERSION="$AUTO_VERSION"
fi

echo "Publishing version: $VERSION"
echo "Upstream base:     $UPSTREAM_VERSION"
echo "Registry:          $REGISTRY"
echo ""

for pkg in "${PACKAGES[@]}"; do
  dir="$YARN_PROJECT/$pkg"
  PUBLISH_NAME="$SCOPE/aztec-$pkg"

  if [[ ! -d "$dir/dest" ]]; then
    echo "Building $pkg..."
    (cd "$dir" && yarn build)
  else
    echo "Using existing build for $pkg (dest/ exists)"
  fi

  # Create temp publish directory
  tmp=$(mktemp -d)
  trap "rm -rf $tmp" EXIT

  # Copy built output and package.json
  cp -r "$dir/dest" "$tmp/dest"
  cp "$dir/package.json" "$tmp/package.json"

  # Write .npmrc for auth if NPM_TOKEN is set
  if [[ -n "${NPM_TOKEN:-}" ]]; then
    cat > "$tmp/.npmrc" <<EOF
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
EOF
  fi

  # Rewrite package.json for publish
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$tmp/package.json', 'utf8'));

    // Rename to @jp4g scope
    pkg.name = '$PUBLISH_NAME';
    pkg.version = '$VERSION';

    // Point to npmjs
    pkg.publishConfig = { registry: '$REGISTRY', access: 'public' };

    // Pin workspace/portal deps to the upstream base version
    for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (!pkg[depType]) continue;
      for (const [name, ver] of Object.entries(pkg[depType])) {
        if (typeof ver === 'string' && (ver.startsWith('workspace:') || ver.startsWith('portal:'))) {
          pkg[depType][name] = '$UPSTREAM_VERSION';
        }
      }
    }

    // Remove monorepo-only fields
    delete pkg.inherits;
    delete pkg.jest;
    delete pkg.scripts;
    delete pkg.devDependencies;
    delete pkg.typedocOptions;
    delete pkg.bin;

    fs.writeFileSync('$tmp/package.json', JSON.stringify(pkg, null, 2) + '\n');
  "

  echo ""
  echo "--- $PUBLISH_NAME@$VERSION ---"
  echo "Contents of $tmp/package.json:"
  cat "$tmp/package.json"
  echo ""

  # Publish from temp dir
  echo "Publishing $PUBLISH_NAME@$VERSION..."
  (cd "$tmp" && npm publish --access public --tag fork)

  echo "Published $PUBLISH_NAME@$VERSION"
  rm -rf "$tmp"
  trap - EXIT
  echo ""
done

echo "Done! Packages published:"
for pkg in "${PACKAGES[@]}"; do
  echo "  $SCOPE/aztec-$pkg@$VERSION"
done
