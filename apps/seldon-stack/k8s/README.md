# Deploy — seldon-stack on home-k3s

Mirrors the `anatomy` pattern: a ghcr image built in CI, served by nginx behind
Traefik at `seldon.gorlitzerpark.com` (internal / tailnet only, no public URL).

## Flow
1. Merge to `main` → `.github/workflows/deploy-seldon-stack.yml` builds
   `ghcr.io/gorlitzer-labs/seldon-stack:<sha>` + `:latest`.
2. Apply the manifests (once): the `seldon` namespace needs a `ghcr-pull-secret`
   (copy from another namespace, or `kubectl create secret docker-registry`).
   ```bash
   kubectl apply -f k8s/namespace.yaml
   kubectl -n seldon create secret docker-registry ghcr-pull-secret \
     --docker-server=ghcr.io --docker-username=<user> --docker-password=<ghcr-PAT>
   kubectl apply -f k8s/
   kubectl -n seldon set image deploy/seldon-stack seldon-stack=ghcr.io/gorlitzer-labs/seldon-stack:<sha>
   kubectl -n seldon rollout status deploy/seldon-stack
   ```
3. Verify: `curl -H 'Host: seldon.gorlitzerpark.com' http://<node-ip>/healthz` → `ok`.
