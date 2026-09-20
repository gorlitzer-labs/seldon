#!/usr/bin/env bash
# Roll the live seldon-stack deployment to a commit's image (default: origin/main).
# Run from any tailnet machine with kubectl access to home-k3s.
#   scripts/deploy-seldon-stack.sh            # roll to origin/main
#   scripts/deploy-seldon-stack.sh <sha>      # roll to a specific commit
set -euo pipefail
sha="${1:-$(git rev-parse origin/main)}"
img="ghcr.io/gorlitzer-labs/seldon-stack:${sha}"
echo "→ rolling seldon-stack to ${sha}"
kubectl -n seldon set image deployment/seldon-stack seldon-stack="${img}"
kubectl -n seldon rollout status deployment/seldon-stack --timeout=120s
echo "✓ live on ${sha}"
