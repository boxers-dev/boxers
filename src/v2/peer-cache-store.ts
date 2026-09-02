import { existsSync } from "node:fs";
import { humanTimestamp } from "../core/time.ts";
import { atomicWriteJson, peerCachePath, readJson } from "./paths.ts";
import { readFleet } from "./fleet.ts";
import { localMachineIdentity } from "./registry.ts";
import type { MachineView } from "./types.ts";
import { parseRemoteSnapshot } from "./machines.ts";

interface CachedPeerView {
  version: 1;
  updatedAt: string;
  view: MachineView;
}

const PEER_FRESHNESS_MS = 45_000;

export interface FleetPeerIdentity {
  id: string;
  name: string;
}

export interface PeerCacheWriteResult {
  view: MachineView;
  changed: boolean;
}

function comparablePeerView(view: MachineView): unknown {
  if (!view.snapshot) return view;
  const { servedAt: _servedAt, observedAt, ...snapshot } = view.snapshot;
  return {
    ...view,
    snapshot: {
      ...snapshot,
      // An empty projection uses its service time as observedAt. It is not a
      // state change, so do not turn every heartbeat into a notification.
      ...(view.snapshot.tasks.length ? { observedAt } : {}),
    },
  };
}

function peerViewsEqual(left: MachineView, right: MachineView): boolean {
  return JSON.stringify(comparablePeerView(left)) === JSON.stringify(comparablePeerView(right));
}

export function readCachedPeerView(peer: FleetPeerIdentity): MachineView {
  const path = peerCachePath(peer.id);
  if (!existsSync(path))
    return {
      id: peer.id,
      name: peer.name,
      connection: "offline",
      detail: "Awaiting the first daemon observation.",
    };
  try {
    const cached = readJson<CachedPeerView>(path);
    if (cached.version !== 1 || cached.view.id !== peer.id) throw new Error("invalid cache");
    if (cached.view.snapshot) parseRemoteSnapshot(JSON.stringify(cached.view.snapshot));
    const age = Date.now() - Date.parse(cached.updatedAt);
    if (cached.view.connection === "online" && (!Number.isFinite(age) || age > PEER_FRESHNESS_MS))
      return {
        ...cached.view,
        connection: "stale",
        detail: `Peer observer heartbeat is stale; last contact ${humanTimestamp(cached.updatedAt)}`,
      };
    return cached.view;
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "The cached peer projection is invalid.";
    return {
      id: peer.id,
      name: peer.name,
      connection: detail.startsWith("Unsupported remote task-view protocol version")
        ? "incompatible"
        : "error",
      detail,
    };
  }
}

export function readCachedPeerViews(): MachineView[] {
  const localId = localMachineIdentity().id;
  return (readFleet()?.members ?? [])
    .filter((member) => member.hostId !== localId)
    .map((member) => readCachedPeerView({ id: member.hostId, name: member.name }));
}

export function writeCachedPeerView(
  peer: FleetPeerIdentity,
  next: MachineView,
): PeerCacheWriteResult {
  const previous = readCachedPeerView(peer);
  let newestSnapshot =
    next.snapshot &&
    previous.snapshot &&
    Date.parse(next.snapshot.observedAt) < Date.parse(previous.snapshot.observedAt)
      ? previous.snapshot
      : next.snapshot;
  if (
    newestSnapshot &&
    next.snapshot?.hostStatus &&
    (!newestSnapshot.hostStatus ||
      Date.parse(next.snapshot.hostStatus.observedAt) >=
        Date.parse(newestSnapshot.hostStatus.observedAt))
  )
    newestSnapshot = { ...newestSnapshot, hostStatus: next.snapshot.hostStatus };
  const view: MachineView =
    next.connection === "online" || !previous.snapshot
      ? { ...next, ...(newestSnapshot ? { snapshot: newestSnapshot } : {}) }
      : {
          ...next,
          connection: "stale",
          snapshot: previous.snapshot,
          detail: `${next.detail ?? next.connection}; last state observed ${humanTimestamp(previous.snapshot.observedAt)}`,
        };
  atomicWriteJson(peerCachePath(peer.id), {
    version: 1,
    updatedAt: new Date().toISOString(),
    view,
  } satisfies CachedPeerView);
  return { view, changed: !peerViewsEqual(previous, view) };
}
