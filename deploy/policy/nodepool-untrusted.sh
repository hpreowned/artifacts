#!/usr/bin/env bash
# The "untrusted" node pool for artifact pods, DESIGN §6.7: tainted artifacts.corp.com/untrusted=true:NoSchedule,
# its own subnet, nothing else scheduled there. AKS labels every node agentpool=<pool name> itself, so naming the
# pool "untrusted" is what gives the template's nodeSelector {agentpool: untrusted} its match; passing that
# label explicitly is not allowed. Idempotent: exits 0 if the pool exists (taints are then verified, not changed).
#
#   RESOURCE_GROUP=<rg> CLUSTER_NAME=<aks> SUBNET_ID=<untrusted-subnet-resource-id> ./nodepool-untrusted.sh [--dry-run]
set -euo pipefail

: "${RESOURCE_GROUP:?set RESOURCE_GROUP}"
: "${CLUSTER_NAME:?set CLUSTER_NAME}"
: "${SUBNET_ID:?set SUBNET_ID to the dedicated subnet for the pool}"
POOL_NAME="${POOL_NAME:-untrusted}"
VM_SIZE="${VM_SIZE:-<vm-size>}"           # e.g. a 4 vCPU / 16 GiB general-purpose size; 50 pods at 500m/512Mi fit on ~7
MIN_COUNT="${MIN_COUNT:-1}"
MAX_COUNT="${MAX_COUNT:-6}"
TAINT="artifacts.corp.com/untrusted=true:NoSchedule"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { printf '%s\n' "$*" >&2; }
run() { log "+ $*"; [ "$DRY_RUN" = 1 ] || "$@"; }

existing=""
if [ "$DRY_RUN" = 0 ]; then
  existing="$(az aks nodepool show -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" -n "$POOL_NAME" --query name -o tsv 2>/dev/null || true)"
fi

if [ -n "$existing" ]; then
  taints="$(az aks nodepool show -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" -n "$POOL_NAME" --query 'nodeTaints' -o tsv)"
  case "$taints" in
    *"$TAINT"*) log "pool $POOL_NAME exists with taint $TAINT" ;;
    *) log "pool $POOL_NAME exists WITHOUT taint $TAINT (has: $taints). Fix: az aks nodepool update ... --node-taints $TAINT"; exit 1 ;;
  esac
else
  [ "$VM_SIZE" != "<vm-size>" ] || { log "set VM_SIZE"; exit 2; }
  run az aks nodepool add -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" -n "$POOL_NAME" \
    --mode User \
    --node-vm-size "$VM_SIZE" \
    --os-sku AzureLinux \
    --vnet-subnet-id "$SUBNET_ID" \
    --node-taints "$TAINT" \
    --labels "artifacts.corp.com/pool=untrusted" \
    --enable-cluster-autoscaler --min-count "$MIN_COUNT" --max-count "$MAX_COUNT" --node-count "$MIN_COUNT" \
    --max-pods 30
fi

# Node OS patching: the auto-upgrade channel is a cluster setting, not a pool one (DESIGN §6.7 "auto-upgrade channel patch").
run az aks update -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --auto-upgrade-channel patch --node-os-upgrade-channel NodeImage

if [ "$DRY_RUN" = 0 ]; then
  log "verify from a cluster session:"
  log "  kubectl get nodes -l agentpool=$POOL_NAME -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints[*].key"
fi
