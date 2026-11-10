# Zones of Responsibility

Draft registry: which repo/session owns which layer of the host's
running infrastructure, and the procedure for incidents that cross
repo boundaries.

Motivation: the 2026-11-07 incident (Telegram webhook `:8443`
Connection refused at the host -> netns dockerd seam) showed that
responsibility was smeared across repos and there was no defined
way to trace a chain that crosses ownership boundaries. This
document fixes the map and the seam protocol.

## End-to-end ingress chain (factual, verified 2026-11-10)

Telegram webhook path, `opticode.su:8443`:

```
Internet
  -> MikroTik router DNAT :8443                    [host network]
  -> host listener 0.0.0.0:8443                    [sessions-bridge]
       session_bridge.ingress.forwarder process
  -> setns() into netns `trade-ai-inner` :8443     [trade-ai-analitic]
       (anonymous unshare -nm netns owned by dockerd's userns)
  -> dockerd host-network container
       shared-person-edge :8443                    [shared_person]
  -> shared-person-n8n workflow                    [shared_person]
  -> Telegram bot delivery                         [devin-telegram]
```

The same shape applies to the other declared forwards:

| port | bind | target | purpose |
|------|------|--------|---------|
| 5678 | 127.0.0.1 | inner :5678 | n8n UI (loopback only - no public ingress) |
| 8080 | 0.0.0.0 | inner :80 | ACME http-01 renewal path (MikroTik :80 -> :8080) |
| 8443 | 0.0.0.0 | inner :8443 | TG webhook (MikroTik DNAT :8443) |
| 9223 | - | - | shared_person chrome debug port (their row) |

Only the 5678 row carries an explicit `bind=` token; the other two
default to `0.0.0.0` because they serve real external traffic.

## Zones table

| layer | owner | artifacts |
|-------|-------|-----------|
| Router DNAT, host firewall, physical NIC | host / developer infra | MikroTik config (outside repos) |
| Host listen sockets + forwarder processes + allocation registry | sessions-bridge | `bridge reserve`, `bridge ingress sync`, `host-ingress.timer`, docs/ALLOCATIONS.md |
| userns + netns + mountns + dockerd + slirp4netns + fwd declarations | trade-ai-analitic (this repo) | `docker-static/supervisor.sh`, `inner-dockerd.sh`, `runc-wrapper.sh`, `slirp4netns`, `docker-data/` |
| Container payload: workflows, app code inside n8n/edge | shared_person | their workflows + compose services |
| Neutral ingress reconciler (host side) | sessions-bridge | `host-ingress.timer`, `SESSIONS_BRIDGE_INGRESS_KINDS=tcp` |
| Session bus, mailbox, task dispatch, allocations | sessions-bridge | `bridge` CLI, queue dirs |
| Telegram message delivery daemon | devin-telegram | `devin-telegram.service` |
| Fleet orchestration, daemon host | ai_controller | orchestrator session |
| Host systemd units not owned by a project | host-services | retro-declared: copilot-api, vk-token, filter-chain |

Registry caveat: `bridge allocations` currently shows
`voltrack-watch` under host-services - a retro-declaration predating
this registry. The unit file lives in this repo (`systemd/`), so
this table assigns it to trade-ai-analitic; re-registering the row
is a follow-up cleanup, not a functional difference.

Important nuance about the container layer: the *runtime*
(dockerd, images, restart policy, netns) is owned by
trade-ai-analitic even for shared_person's containers - they run
inside our rootless dockerd. The *payload* (what the workflows do)
is theirs. A container that is down is our zone; a workflow that
misbehaves inside a running container is theirs.

## trade-ai-analitic real boundaries

Owned here:

- `rootless-docker.service` -> `docker-static/supervisor.sh`
  (`unshare -Ur` -> inner `unshare -nm` + dockerd + slirp4netns +
  inner ingress reconcile loop)
- Resource declarations pre-flight: `bridge reserve` for
  `netns_id trade-ai-inner`, `docker_network_cidr 10.0.2.0/24`,
  and the three `tcp_port` rows with `fwd=`/`bind=` tokens.
  Failure to reserve = refuse to start (fail-fast).
- The ns-* forwarder *lifecycle*: the supervisor's in-userns
  `bridge ingress sync` loop owns spawning/respawning them;
  the host timer (`SESSIONS_BRIDGE_INGRESS_KINDS=tcp`) cannot
  setns() into our userns-owned netns.
- Data collectors on this host: `voltrack-watch.service`,
  `voltrack-join.timer`, `voltrack-report.timer`,
  `crypto-heartbeat.timer`.
- `docker-static/webhook_canary.sh`: Telegram `getWebhookInfo`
  error-state probe for the shared-person bot.

NOT owned here:

- Anything inside a container's application layer.
- The forwarder *processes* on the host side (sessions-bridge
  spawns them from our declarations).
- Router/DNAT, the Telegram API itself, the bus.

## Cross-repo incident procedure

Seam principle: an outage is visible at the *last externally
reachable hop*; debugging walks the chain backward hop by hop
until the first broken link, then the zone owner of that link
owns the fix.

Trace order for ingress-class incidents (8443-style):

0. Split router-vs-host FIRST: probe the host's LAN address
   directly (`curl http://<lan-ip>:8443/`, bypassing DNAT). If the
   LAN probe works but the public one fails, the break is UPSTREAM
   of the host - MikroTik DNAT / ISP / DNS - and the trace below is
   pointless. Only continue if the LAN probe also fails.
1. External probe: `curl -s -o /dev/null -w '%{http_code}'
   https://opticode.su:8443/...` (or the canary) - confirms the
   outage is real end-to-end.
2. Host listener: `bridge ingress status` (UP/DOWN per port) and
   `ss -tlnp | grep <port>` - is anything listening?
3. Forwarder process: `bridge ingress status` pid column -
   alive? (`pgrep -f session_bridge.ingress.forwarder`)
4. Netns target: `cat docker-static/inner.pid` IS the dockerd pid
   (inner-dockerd.sh writes `$$` then `exec`s dockerd;
   `docker-static/run/dockerd.pid` is dockerd's own pidfile - the
   two must agree). Compare against the live process
   (`pgrep -f dockerd`): a stale inner.pid or a dead pid = the
   netns owner is gone and forwarders point nowhere.
5. dockerd: `systemctl --user status rootless-docker` +
   `docker ps` (DOCKER_HOST=unix://docker-static/run/docker.sock).
6. Container + app: `docker ps` -> container up? then app-level
   probe (healthz/webhook test inside the netns or via 127.0.0.1
   forward).

Seam record format (write it into the incident note / issue):

```
chain: <external> -> <host:PORT> -> <fwd pid> -> <netns> -> <dockerd> -> <container> -> <app>
break: <first failing hop>
zone:  <owning repo per this table>
```

Escalation:

- Broken hop owned by a repo -> that repo's session owns the fix.
- Break ON the seam, split by context:
  - forwarder *process* missing/misbound, registry state, tcp:
    specs -> sessions-bridge owns;
  - ns-* forwarder not (re)spawned while the supervisor loop
    should own it, setns permission errors inside our userns ->
    trade-ai-analitic owns.
- Ownership contested or a zone missing from this table ->
  ai_controller arbitrates; outcome is appended to this table.

## Deployment acceptance gate (external inputs)

Any deploy/restart touching a chain with external inputs is NOT
done until an external-path probe returns the expected code -
`localhost` probes alone are insufficient (they bypass DNAT,
the forwarder and, partially, the netns seam).

- 8443: `curl` through `opticode.su:8443` (or MikroTik-side
  address) -> expected response, plus `webhook_canary.sh`
  CANARY OK.
- 5678: loopback `curl localhost:5678/healthz` -> 200 AND a
  LAN-address probe MUST FAIL (loopback bind is a security
  invariant, not a courtesy).
- 8080: external-path request -> any HTTP response from inner :80.
