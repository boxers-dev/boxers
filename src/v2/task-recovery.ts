import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { notifyDaemonStateChanged } from "./daemon-client.ts";
import { orphanedTaskDir, taskDir } from "./paths.ts";
import { listProjects, listTasks, type RegisteredTask } from "./registry.ts";
import type { RuntimeInfo } from "./runtime/types.ts";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runtimeKey(kind: string, id: string): string {
  return `${kind}\0${id}`;
}

function creationIsActive(task: RegisteredTask["task"]): boolean {
  return (
    task.lastSnapshot?.phase === "creating" &&
    task.creationPid !== undefined &&
    processIsAlive(task.creationPid)
  );
}

/** Freeze the registrations an inventory result is allowed to retire. */
export function missingTaskRegistrationCandidates(options: { name?: string } = {}): Set<string> {
  const normalizedName = options.name?.toLowerCase();
  return new Set(
    listProjects().flatMap((project) =>
      listTasks(project).flatMap((task) =>
        (normalizedName === undefined || task.name.toLowerCase() === normalizedName) &&
        !creationIsActive(task)
          ? [task.id]
          : [],
      ),
    ),
  );
}

/**
 * Move registrations whose durable runtime no longer exists out of the active
 * task registry. A live creator is exempt because its Sandbox may not be
 * visible until provisioning reaches `sbx create`.
 */
export function archiveMissingTaskRegistrations(
  inventory: readonly RuntimeInfo[],
  options: { name?: string; taskIds?: ReadonlySet<string> } = {},
): RegisteredTask[] {
  const available = new Set(inventory.map((item) => runtimeKey(item.kind, item.id)));
  const normalizedName = options.name?.toLowerCase();
  const archived: RegisteredTask[] = [];

  for (const project of listProjects()) {
    for (const task of listTasks(project)) {
      if (normalizedName !== undefined && task.name.toLowerCase() !== normalizedName) continue;
      if (options.taskIds !== undefined && !options.taskIds.has(task.id)) continue;
      if (available.has(runtimeKey(task.runtime.kind, task.runtime.id))) continue;
      if (creationIsActive(task)) continue;

      const destination = orphanedTaskDir(project.id, task.id);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      renameSync(taskDir(project.id, task.id), destination);
      archived.push({ project, task });
    }
  }

  if (archived.length) notifyDaemonStateChanged();
  return archived;
}
