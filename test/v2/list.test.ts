import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { list } from "../../src/v2/commands.ts";
import { atomicWriteJson, taskDir, taskIntentLeasePath } from "../../src/v2/paths.ts";
import { createTaskManifest, initProject, updateTask } from "../../src/v2/registry.ts";
import { enrollFleetMember, ensureFleet } from "../../src/v2/fleet.ts";

describe("task list", () => {
  it("lists cached task state without contacting Docker Sandboxes", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-list-project-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-list-state-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-list-bin-"));
    const oldHome = process.env.BOXERS_HOME;
    const oldPath = process.env.PATH;
    try {
      process.env.BOXERS_HOME = state;
      execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      writeFileSync(join(root, "tracked.txt"), "tracked\n");
      execFileSync("git", ["-C", root, "add", "tracked.txt"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"]);
      const project = initProject({ integration: "local", base: "main", cwd: root });
      const task = createTaskManifest(project, "cached-task", "codex");
      updateTask(project, task, {
        phase: "working",
        agent: "codex",
        preview: { state: "running", urls: ["http://localhost:45173"] },
      });
      atomicWriteJson(join(state, "machines.json"), [
        {
          version: 1,
          id: "legacy-id",
          name: "legacy-remote",
          sshHost: "legacy-remote",
          createdAt: "2026-08-10T00:00:00.000Z",
        },
      ]);

      const marker = join(bin, "sbx-called");
      const executable = join(bin, "sbx");
      writeFileSync(
        executable,
        `#!/bin/sh\ntouch "${marker}"\nprintf '{"sandboxes":[{"name":"boxers-my-project-cached-task","status":"stopped"}]}'\n`,
      );
      chmodSync(executable, 0o755);
      const gitProbe = join(bin, "git");
      writeFileSync(gitProbe, `#!/bin/sh\ntouch "${marker}"\nexit 99\n`);
      chmodSync(gitProbe, 0o755);
      process.env.PATH = `${bin}:${oldPath ?? ""}`;
      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await expect(list(false)).resolves.toBe(0);
      const output = write.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("cached-task");
      expect(output).toContain("UNMERGED_CHANGES");
      expect(output).toContain("PREVIEW");
      expect(output).toContain("http://localhost:45173");
      expect(output).toMatch(/cached-task\s+codex\s+no\s+no/);
      expect(output).not.toContain("legacy-remote");
      expect(existsSync(marker)).toBe(false);
      write.mockRestore();
    } finally {
      vi.restoreAllMocks();
      if (oldHome === undefined) delete process.env.BOXERS_HOME;
      else process.env.BOXERS_HOME = oldHome;
      process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("reads remote state from the daemon cache without opening SSH", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-list-stream-project-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-list-stream-state-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-list-stream-bin-"));
    const oldHome = process.env.BOXERS_HOME;
    const oldPath = process.env.PATH;
    try {
      process.env.BOXERS_HOME = state;
      execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      writeFileSync(join(root, "tracked.txt"), "tracked\n");
      execFileSync("git", ["-C", root, "add", "tracked.txt"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"]);
      const project = initProject({ integration: "local", base: "main", cwd: root });
      const task = createTaskManifest(project, "local-task", "codex");
      updateTask(project, task, { phase: "idle", agent: "codex" });
      const fleet = ensureFleet();
      enrollFleetMember(fleet.fleetId, {
        hostId: "remote-id",
        name: "remote",
        publicKey: "remote-public-key",
        endpoints: [{ transport: "ssh", target: "remote-box" }],
        roles: ["observe"],
        enrolledAt: "2026-08-10T00:00:00.000Z",
      });

      const sbx = join(bin, "sbx");
      writeFileSync(
        sbx,
        `#!/bin/sh\nprintf '{"sandboxes":[{"name":"${task.runtime.id}","status":"stopped"}]}'\n`,
      );
      chmodSync(sbx, 0o755);
      const ssh = join(bin, "ssh");
      const sshMarker = join(bin, "ssh-called");
      writeFileSync(
        ssh,
        `#!/bin/sh\ntouch "${sshMarker}"\nprintf '%s\\n' '{"protocolVersion":1,"machine":{"version":1,"id":"remote-id","name":"remote","createdAt":"2026-08-10T00:00:00.000Z","boxersVersion":"0.2.0"},"observedAt":"2026-08-10T00:00:01.000Z","tasks":[{"id":"remote-task-id","projectId":"remote-project-id","project":"remote-project","name":"remote-task","agent":"codex","phase":"idle","activity":"idle","runtimeState":"running"}]}'\n`,
      );
      chmodSync(ssh, 0o755);
      process.env.PATH = `${bin}:${oldPath ?? ""}`;

      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      await expect(list(false)).resolves.toBe(0);
      const complete = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(complete).toContain("Local tasks");
      expect(complete).toContain("local-task");
      expect(complete).toContain("Remote tasks");
      expect(complete).toContain("Awaiting the first daemon observation");
      expect(complete).not.toContain("remote-task");
      expect(existsSync(sshMarker)).toBe(false);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      if (oldHome === undefined) delete process.env.BOXERS_HOME;
      else process.env.BOXERS_HOME = oldHome;
      process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("never probes leased or setup-running tasks while listing", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-list-lease-project-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-list-lease-state-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-list-lease-bin-"));
    const oldHome = process.env.BOXERS_HOME;
    const oldPath = process.env.PATH;
    try {
      process.env.BOXERS_HOME = state;
      execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      writeFileSync(join(root, "tracked.txt"), "tracked\n");
      execFileSync("git", ["-C", root, "add", "tracked.txt"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"]);
      const project = initProject({ integration: "local", base: "main", cwd: root });
      const task = createTaskManifest(project, "leased-task", "codex");
      updateTask(project, task, {
        phase: "checking",
        agent: "codex",
      });
      atomicWriteJson(taskIntentLeasePath(task.name), {
        daemonPid: process.pid,
      });
      const setupTask = createTaskManifest(project, "setup-task", "codex");
      const setup = {
        state: "running" as const,
        command: "npm ci",
        startedAt: "2026-08-26T00:00:00.000Z",
        pid: process.pid,
        logPath: join(taskDir(project.id, setupTask.id), "setup.log"),
      };
      updateTask(project, setupTask, {
        phase: "setting_up",
        agent: "codex",
        targetOid: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        setup,
      });
      atomicWriteJson(join(taskDir(project.id, setupTask.id), "setup.json"), setup);

      const calls = join(bin, "sbx-calls");
      const executable = join(bin, "sbx");
      writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nprintf '{"sandboxes":[{"name":"${task.runtime.id}","status":"running"},{"name":"${setupTask.runtime.id}","status":"running"}]}'\n`,
      );
      chmodSync(executable, 0o755);
      process.env.PATH = `${bin}:${oldPath ?? ""}`;

      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await expect(list(true)).resolves.toBe(0);
      const parsed = JSON.parse(write.mock.calls.map((call) => String(call[0])).join("")) as {
        machines: Array<{
          name: string;
          snapshot?: {
            tasks: Array<{
              name: string;
              runtime: { kind: string; id: string };
              needsAttention: boolean;
              state: unknown;
            }>;
          };
        }>;
      };
      expect(existsSync(calls)).toBe(false);
      const local = parsed.machines.find((machine) => machine.name === "local");
      const projected = local?.snapshot?.tasks.find((candidate) => candidate.name === task.name);
      expect(projected?.runtime).toEqual({ kind: "docker-sandboxes", id: task.runtime.id });
      expect(projected).toMatchObject({ needsAttention: false, state: expect.any(Object) });
      expect(
        local?.snapshot?.tasks.find((candidate) => candidate.name === setupTask.name),
      ).toBeDefined();
      write.mockRestore();
    } finally {
      vi.restoreAllMocks();
      if (oldHome === undefined) delete process.env.BOXERS_HOME;
      else process.env.BOXERS_HOME = oldHome;
      process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
