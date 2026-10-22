#!/bin/bash
# Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
# Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
# For commercial use, please contact the author.

# Rootless docker stack supervisor:
#   userns (single-uid) -> [ inner: netns+mountns+dockerd ] + slirp4netns + port forwarder
# Must run inside a cgroup under the user-delegated subtree
# (launch via: systemctl --user start rootless-docker)
D="$(cd "$(dirname "$0")" && pwd)"
export PATH="$D/docker:$PATH"
mkdir -p "$D/run" "$D/../docker-data"
echo "nameserver 10.0.2.3" > "$D/resolv-inner.conf"
rm -f "$D/inner.pid"
# cgroup dir for containers, inside the user-delegated subtree
mkdir -p /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/docker-containers 2>/dev/null || true

exec unshare -Ur --propagation unchanged bash -c '
  export PATH="'"$D"'/docker:$PATH"
  D="'"$D"'"
  bash "$D/inner-dockerd.sh" &
  for i in $(seq 1 200); do [ -f "$D/inner.pid" ] && break; sleep 0.1; done
  INNER=$(cat "$D/inner.pid")
  "$D/slirp4netns" --configure --mtu=65520 "$INNER" tap0 > "$D/slirp.log" 2>&1 &
  python3 "$D/port_fwd.py" 5678 5678 "$INNER" >> "$D/fwd.log" 2>&1 &
  wait
'
