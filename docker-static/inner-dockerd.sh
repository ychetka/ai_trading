#!/bin/bash
# Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
# Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
# For commercial use, please contact the author.

# Runs INSIDE userns (spawned by supervisor). Creates netns + mountns and starts dockerd.
D="$(cd "$(dirname "$0")" && pwd)"
exec unshare -nm --propagation unchanged bash -c '
  set -e
  echo $$ > '"$D"'/inner.pid
  mount -t tmpfs tmpfs /run
  mkdir -p /run/docker/plugins
  mount --bind '"$D"'/resolv-inner.conf /etc/resolv.conf
  mkdir -p /sys/kernel/security 2>/dev/null
  mount -t tmpfs tmpfs /sys/kernel/security 2>/dev/null || true
  export PATH="'"$D"'/docker:$PATH"
  exec dockerd \
    --host=unix://'"$D"'/run/docker.sock \
    --data-root='"$D"'/../docker-data \
    --exec-root='"$D"'/run/exec \
    --pidfile='"$D"'/run/dockerd.pid \
    --iptables=false --ip6tables=false --bridge=none \
    --ip-forward=false --ip-masq=false \
    --storage-driver=overlay2 \
    --dns=10.0.2.3 \
    --cgroup-parent=user.slice/user-1000.slice/user@1000.service/app.slice/docker-containers \
    --add-runtime=rwrap='"$D"'/runc-wrapper.sh \
    --default-runtime=rwrap
'
