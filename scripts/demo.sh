#!/usr/bin/env bash
# A guided run of `plan --from` against a repository it creates and never writes to.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="node $HERE/dist/cli/bin.js"
REPO="${1:-/tmp/idp-demo}"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

rm -rf "$REPO"

say "1. Créer un dépôt de déclarations neuf"
echo "\$ idp-agent init platform $REPO --owner @acme/platform"
$CLI init platform "$REPO" --owner @acme/platform | head -4
echo "  ..."

BEFORE=$(find "$REPO" | sort | shasum -a 256 | cut -d' ' -f1)
BEFORE_BYTES=$(find "$REPO" -type f | sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)

say "2. Prévisualiser un plan : ce qu'il ÉCRIRAIT"
echo "\$ idp-agent plan --from examples/add-access.json --repo $REPO"
$CLI plan --from "$HERE/examples/add-access.json" --repo "$REPO"

say "3. Le dépôt a-t-il bougé ?"
AFTER=$(find "$REPO" | sort | shasum -a 256 | cut -d' ' -f1)
AFTER_BYTES=$(find "$REPO" -type f | sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
if [ "$BEFORE" = "$AFTER" ] && [ "$BEFORE_BYTES" = "$AFTER_BYTES" ]; then
  printf '   \033[32m✓ identique — mêmes fichiers, mêmes octets, mêmes dossiers\033[0m\n'
else
  printf '   \033[31m✗ LE DÉPÔT A CHANGÉ\033[0m\n'; exit 1
fi

say "4. Et si le plan invente un propriétaire ?"
echo "\$ idp-agent plan --from examples/needs-an-owner.json --repo $REPO"
set +e
$CLI plan --from "$HERE/examples/needs-an-owner.json" --repo "$REPO"
echo "   (code de sortie $?  — 3 veut dire : compris, et je n'agirai pas là-dessus)"
set -e

say "Terminé. Le dépôt est dans $REPO, intact."
