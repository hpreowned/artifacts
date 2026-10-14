#!/usr/bin/env bash
# Azure Policy for Kubernetes assignments, DESIGN §6.7, effect deny, scoped to the cluster and (per policy) to
# the artifacts-dynamic namespace. Built-in definitions are resolved by display name at run time, so no
# definition id is hardcoded. Idempotent: assignments are PUT by name. Azure Policy syncs to Gatekeeper in up
# to 20 minutes; then run the Phase 2 negative tests (DESIGN §8).
#
#   CLUSTER_ID=/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ContainerService/managedClusters/<aks> \
#     ./azure-policy-assign.sh [--dry-run]
set -euo pipefail

: "${CLUSTER_ID:?set CLUSTER_ID to the AKS resource id}"
NAMESPACES="${NAMESPACES:-artifacts-dynamic}"          # comma-separated namespaces the image/capability/hostPath rules apply to
ALLOWED_IMAGES_REGEX='^jfrog\.corp\.com/artifacts/python-runtime@sha256:[a-f0-9]{64}$'
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { printf '%s\n' "$*" >&2; }
run() { log "+ $*"; [ "$DRY_RUN" = 1 ] || "$@"; }

ns_json="$(printf '%s' "$NAMESPACES" | awk -F, '{ printf "["; for (i=1;i<=NF;i++) printf "%s\"%s\"", (i>1?",":""), $i; printf "]" }')"

# definition_id <policyDefinition|policySetDefinition> <display name> -> resource id
definition_id() {
  local kind="$1" name="$2"
  if [ "$DRY_RUN" = 1 ]; then
    log "+ az policy ${kind} list --query \"[?displayName=='$name'].id | [0]\""
    printf '<%s:%s>\n' "$kind" "$name"
    return
  fi
  local id
  id="$(az policy "$kind" list --query "[?displayName=='$name'].id | [0]" -o tsv)"
  [ -n "$id" ] && [ "$id" != "None" ] || { log "built-in '$name' not found; display names change, search with az policy $kind list --query \"[?contains(displayName,'allowed images')]\""; exit 1; }
  printf '%s\n' "$id"
}

assign() { # assign <assignment-name> <policy|policy-set-definition flag> <definition id> <params json> <display name>
  run az policy assignment create --name "$1" --display-name "$5" --scope "$CLUSTER_ID" "$2" "$3" --params "$4"
}

if [ "$DRY_RUN" = 0 ]; then
  enabled="$(az aks show --ids "$CLUSTER_ID" --query 'addonProfiles.azurepolicy.enabled' -o tsv 2>/dev/null || echo "")"
  [ "$enabled" = "true" ] || { log "Azure Policy add-on is not enabled on the cluster: az aks enable-addons --addons azure-policy --ids $CLUSTER_ID"; exit 1; }
fi

log "## 1. restricted pod security initiative on $NAMESPACES"
init_id="$(definition_id set-definition 'Kubernetes cluster pod security restricted standards for Linux-based workloads')"
assign artifacts-psa-restricted --policy-set-definition "$init_id" \
  "{\"effect\":{\"value\":\"deny\"},\"namespaces\":{\"value\":$ns_json}}" \
  "artifacts: restricted pod security (deny)"

log "## 2. allowed images in artifacts-dynamic: digest-pinned python-runtime only"
img_id="$(definition_id definition 'Kubernetes cluster containers should only use allowed images')"
assign artifacts-allowed-images --policy "$img_id" \
  "{\"effect\":{\"value\":\"deny\"},\"namespaces\":{\"value\":[\"artifacts-dynamic\"]},\"allowedContainerImagesRegex\":{\"value\":\"$ALLOWED_IMAGES_REGEX\"}}" \
  "artifacts: only python-runtime by digest in artifacts-dynamic (deny)"

log "## 3. no capabilities, drop ALL"
cap_id="$(definition_id definition 'Kubernetes cluster containers should only use allowed capabilities')"
assign artifacts-no-capabilities --policy "$cap_id" \
  "{\"effect\":{\"value\":\"deny\"},\"namespaces\":{\"value\":$ns_json},\"allowedCapabilities\":{\"value\":[]},\"requiredDropCapabilities\":{\"value\":[\"ALL\"]}}" \
  "artifacts: no capabilities, drop ALL (deny)"

log "## 4. no hostPath volumes"
hp_id="$(definition_id definition 'Kubernetes cluster pod hostPath volumes should only use allowed host paths')"
assign artifacts-no-hostpath --policy "$hp_id" \
  "{\"effect\":{\"value\":\"deny\"},\"namespaces\":{\"value\":$ns_json},\"allowedHostPaths\":{\"value\":{\"paths\":[]}}}" \
  "artifacts: no hostPath volumes (deny)"

log "Done. Wait up to 20 minutes, then: kubectl apply a pod in artifacts-dynamic with image docker.io/library/python (expect deny)"
log "and one with privileged: true (expect deny by PSA restricted and by the initiative)."
