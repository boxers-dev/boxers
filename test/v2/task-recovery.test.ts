import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { orphanedTaskDir, taskDir } from "../../src/v2/paths.ts";
import { createTaskManifest, initProject, listTasks, updateTask } from "../../src/v2/registry.ts";
import {
  archiveMissingTaskRegistrations,
  missingTaskRegistrationCandidates,
} from "../../src/v2/task-recovery.ts";

const cleanup: string[] = [];
const originalHome = process.env.BOXERS_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = originalHome;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("archives missing runtimes, preserves metadata, and protects a live creator", () => {
  const root = mkdtempSync(join(tmpdir(), "boxers-recovery-project-"));
  const state = mkdtempSync(join(tmpdir(), "boxers-recovery-state-"));
  cleanup.push(root, state);
  process.env.BOXERS_HOME = state;
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  writeFileSync(join(root, "tracked.txt"), "base\n");
  execFileSync("git", ["-C", root, "add", "tracked.txt"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"]);
  const project = initProject({ integration: "local", base: "main", cwd: root });

  const stale = createTaskManifest(project, "stale", "codex");
  updateTask(project, stale, { phase: "idle", agent: "codex" });
  writeFileSync(join(taskDir(project.id, stale.id), "useful.log"), "preserve me\n");
  const creating = createTaskManifest(project, "creating", "codex");

  expect(missingTaskRegistrationCandidates()).toEqual(new Set([stale.id]));
  expect(archiveMissingTaskRegistrations([])).toEqual([
    { project, task: expect.objectContaining({ id: stale.id, name: "stale" }) },
  ]);
  expect(listTasks(project).map((task) => task.name)).toEqual(["creating"]);
  expect(existsSync(taskDir(project.id, stale.id))).toBe(false);
  expect(readFileSync(join(orphanedTaskDir(project.id, stale.id), "useful.log"), "utf8")).toBe(
    "preserve me\n",
  );
  expect(existsSync(taskDir(project.id, creating.id))).toBe(true);

  const replacement = createTaskManifest(project, "stale", "codex");
  expect(replacement.runtime.id).toBe(stale.runtime.id);
});
