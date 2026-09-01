import { existsSync } from "node:fs";
import { atomicWriteJson, machineSetupPath, readJson } from "./paths.ts";

interface MachineSetupMarker {
  version: 1;
  completedAt: string;
}

export function isMachineSetupComplete(): boolean {
  const path = machineSetupPath();
  if (!existsSync(path)) return false;
  try {
    const marker = readJson<Partial<MachineSetupMarker>>(path);
    return marker.version === 1 && Number.isFinite(Date.parse(marker.completedAt ?? ""));
  } catch {
    return false;
  }
}

export function markMachineSetupComplete(): void {
  atomicWriteJson(machineSetupPath(), {
    version: 1,
    completedAt: new Date().toISOString(),
  } satisfies MachineSetupMarker);
}
