#!/bin/bash
# Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
# Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
# For commercial use, please contact the author.

# Rootless docker stack supervisor:
#   userns (single-uid) -> [ inner: netns+mountns+dockerd ] + slirp4netns + port forwarder
# Must run inside a cgroup under the user-delegated subtree
# (launch via: systemctl --user start rootless-docker)
#
# Host resources (ports, netns, subnet) are declared in the
# sessions-bridge allocation registry BEFORE anything binds them:
# `bridge reserve` is the mandatory pre-flight (docs/ALLOCATIONS.md),
# a CONFLICT exits non-zero and we refuse to start - never --force.
# Port forwards are NOT spawned here anymore: the neutral
# host-ingress layer materializes them from the fwd= tokens below.
BRIDGE="${BRIDGE_BIN:-$HOME/.local/bin/bridge}"
[ -x "$BRIDGE" ] || {
  echo "supervisor: bridge binary not found at $BRIDGE" >&2
  echo "  (sessions-bridge >= v0.4.0 provides the host ingress layer;" >&2
  echo "   set BRIDGE_BIN to override the path)" >&2
  exit 1
}
reserve() {
  # reserve <type> <id> <purpose> [fwd-spec]
  if [ -n "${4:-}" ]; then
    "$BRIDGE" reserve "$1" "$2" --project trade-ai --purpose "$3" --fwd "$4"
  else
    "$BRIDGE" reserve "$1" "$2" --project trade-ai --purpose "$3"
  fi || {
    echo "supervisor: allocation conflict on $1/$2 - refusing to start" >&2
    exit 1
  }
}
reserve netns_id trade-ai-inner \
  "anonymous unshare -nm netns for rootless dockerd (docker-static/supervisor.sh)"
reserve docker_network_cidr 10.0.2.0/24 \
  "slirp4netns default subnet inside trade-ai-inner"
D="$(cd "$(dirname "$0")" && pwd)"
export PATH="$D/docker:$PATH"
mkdir -p "$D/run" "$D/../docker-data"
echo "nameserver 10.0.2.3" > "$D/resolv-inner.conf"
rm -f "$D/inner.pid"
# cgroup dir for containers, inside the user-delegated subtree
mkdir -p /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/docker-containers 2>/dev/null || true

export BRIDGE
exec unshare -Ur --propagation unchanged bash -c '
  export PATH="'"$D"'/docker:$PATH"
  D="'"$D"'"
  bash "$D/inner-dockerd.sh" &
  for i in $(seq 1 200); do [ -f "$D/inner.pid" ] && break; sleep 0.1; done
  INNER=$(cat "$D/inner.pid")
  "$D/slirp4netns" --configure --mtu=65520 "$INNER" tap0 > "$D/slirp.log" 2>&1 &
  # Port forwards: declared in the allocation registry, materialized
  # by the neutral host-ingress layer (host-ingress.timer / bridge
  # ingress sync). The fwd spec points at inner.pid so a netns
  # recycle respawns the forwarders automatically.
  "$BRIDGE" reserve tcp_port 5678 --project trade-ai \
    --purpose "n8n UI forward" --fwd "ns-pidfile:$D/inner.pid:5678" || exit 1
  # shared-person TG webhook: opticode.su:8443 (MikroTik DNAT) -> inner :8443
  "$BRIDGE" reserve tcp_port 8443 --project trade-ai \
    --purpose "TG webhook forward" --fwd "ns-pidfile:$D/inner.pid:8443" || exit 1
  # ACME http-01 renewal path: MikroTik dstnat :80 -> host :8080 -> inner :80
  "$BRIDGE" reserve tcp_port 8080 --project trade-ai \
    --purpose "ACME http-01 path" --fwd "ns-pidfile:$D/inner.pid:80" || exit 1
  # zero-wait publication; host-ingress.timer is the 30s safety net
  "$BRIDGE" ingress sync \
    || echo "supervisor: ingress sync failed - host-ingress.timer will retry" >&2
  wait
'
