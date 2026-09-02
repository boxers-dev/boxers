import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/v2/commands.ts", () => ({
  attach: vi.fn(),
  authenticate: vi.fn(() => 0),
  check: vi.fn(),
  cloneAndInitializeProject: vi.fn(),
  doctor: vi.fn(() => ({ ok: true, warnings: [], checks: [] })),
  initialize: vi.fn(() => 0),
  list: vi.fn(),
  promote: vi.fn(),
  newTask: vi.fn(() => 0),
  newTaskInProject: vi.fn(() => 0),
  preview: vi.fn(),
  printDoctor: vi.fn(() => 0),
  projectStatus: vi.fn(() => 0),
  discard: vi.fn(),
  review: vi.fn(),
  debugShell: vi.fn(),
  status: vi.fn(),
  sync: vi.fn(),
}));

vi.mock("../../src/v2/machines.ts", () => ({
  remoteSnapshot: vi.fn(() => 0),
  remoteWatch: vi.fn(() => 0),
  runRemoteCommand: vi.fn(() => 0),
  runRemoteTaskCommand: vi.fn(() => 0),
}));

vi.mock("../../src/v2/registry.ts", () => ({
  projectCloneSource: vi.fn(() => "git@github.com:owner/repo.git"),
  requireProject: vi.fn(() => ({
    id: "project-id",
    root: "/work/boxers",
    integration: { mode: "remote", base: "main", remote: "origin" },
  })),
}));

vi.mock("../../src/v2/fleet-connect.ts", () => ({
  acceptEnrollment: vi.fn(),
  acceptFleetSync: vi.fn(() => ({ version: 1, fleetId: "fleet", members: [] })),
  acceptUnenrollment: vi.fn(),
  connectHost: vi.fn(() => 0),
  disconnectHost: vi.fn(() => 0),
  remoteIdentity: vi.fn(() => ({ protocolVersion: 1 })),
  verifyEnrolledPeer: vi.fn(() => 0),
}));

vi.mock("../../src/v2/fleet.ts", () => ({
  readFleet: vi.fn(() => ({ version: 1, fleetId: "fleet", members: [], updatedAt: "now" })),
}));

vi.mock("../../src/v2/fleet-admin.ts", () => ({
  acceptManagedUpdate: vi.fn(() => ({ version: "1.2.3", executable: "boxers" })),
  doctorFleet: vi.fn(() => 0),
  updateFleet: vi.fn(() => 0),
}));

vi.mock("../../src/v2/service.ts", () => ({
  daemonServiceStatus: vi.fn(() => ({
    active: true,
    enabled: true,
    supported: true,
    platform: "test",
    detail: "running",
  })),
  installDaemonService: vi.fn(() => ({ active: true, detail: "running" })),
  resolveBoxersExecutable: vi.fn(() => "/opt/boxers/bin/boxers"),
}));

vi.mock("../../src/v2/fleet-status.ts", () => ({
  showAuthenticationStatus: vi.fn(() => 0),
  showFleetStatus: vi.fn(() => 0),
}));

vi.mock("../../src/v2/machine-init.ts", () => ({
  initializeMachine: vi.fn(() => 0),
}));

vi.mock("../../src/v2/templates.ts", () => ({
  listTemplates: vi.fn(() => 0),
}));

vi.mock("../../src/v2/daemon-commands.ts", () => ({
  daemonRestart: vi.fn(() => 0),
  daemonStart: vi.fn(() => 0),
  daemonStatus: vi.fn(() => 0),
  daemonStop: vi.fn(() => 0),
  runDaemonForeground: vi.fn(() => 0),
}));

import { dispatch, UsageError } from "../../src/cli.ts";
import * as commands from "../../src/v2/commands.ts";
import * as daemonCommands from "../../src/v2/daemon-commands.ts";
import * as fleetAdmin from "../../src/v2/fleet-admin.ts";
import * as fleetConnect from "../../src/v2/fleet-connect.ts";
import * as machines from "../../src/v2/machines.ts";
import * as service from "../../src/v2/service.ts";
import * as fleetStatus from "../../src/v2/fleet-status.ts";
import * as machineInit from "../../src/v2/machine-init.ts";
import * as templates from "../../src/v2/templates.ts";

describe("v2 CLI", () => {
  it("shows only the provider-neutral task command surface", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(dispatch(["--help"])).resolves.toBe(0);
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("boxers <task> new");
    expect(output).toContain("boxers [<machine>/]<task> status");
    expect(output).toContain("boxers [<machine>/]<task> sync|review|check");
    expect(output).toContain("boxers [<machine>/]<task> preview");
    expect(output).toContain("boxers [<machine>/]<task> discard");
    expect(output).toContain("boxers debug shell <task>");
    expect(output).toContain("boxers debug daemon");
    expect(output).toContain("boxers daemon install");
    expect(output).toContain("boxers daemon start");
    expect(output).toContain("boxers daemon restart [--force]");
    expect(output).toContain("boxers project init");
    expect(output).toContain("boxers init");
    expect(output).toContain("boxers list templates [--json]");
    expect(output).toContain("boxers [<machine>/]<task> attach");
    expect(output).not.toContain("boxers <machine>/<task> attach");
    expect(output).not.toContain("boxers <task> stop");
    expect(output).not.toContain("boxers <task> rm");
    expect(output).not.toContain("boxers new <task>");
    expect(output).not.toContain("commit-push");
    expect(output).not.toContain("vibe");
    write.mockRestore();
  });

  it("keeps list as a recorded-state-only command", async () => {
    await expect(dispatch(["list", "--status"])).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["list", "--refresh"])).rejects.toBeInstanceOf(UsageError);
    await dispatch(["list", "--json"]);
    expect(commands.list).toHaveBeenLastCalledWith(true);
  });

  it("lists task templates separately from tasks", async () => {
    vi.mocked(commands.list).mockClear();
    await dispatch(["list", "templates"]);
    expect(templates.listTemplates).toHaveBeenLastCalledWith(false);
    expect(commands.list).not.toHaveBeenCalled();

    await dispatch(["list", "templates", "--json"]);
    expect(templates.listTemplates).toHaveBeenLastCalledWith(true);
    await expect(dispatch(["list", "templates", "--all"])).rejects.toBeInstanceOf(UsageError);
  });

  it("routes host, authentication, and project status independently", async () => {
    await dispatch(["status", "--refresh", "--host=build-box", "--json"]);
    expect(fleetStatus.showFleetStatus).toHaveBeenCalledWith({
      refresh: true,
      host: "build-box",
      json: true,
    });
    await dispatch(["auth", "status", "--all", "--refresh"]);
    expect(fleetStatus.showAuthenticationStatus).toHaveBeenCalledWith({
      refresh: true,
      all: true,
      json: false,
    });
    await expect(dispatch(["auth", "status", "--all", "--host", "desktop"])).rejects.toBeInstanceOf(
      UsageError,
    );
    await dispatch(["project", "status", "--json"]);
    expect(commands.projectStatus).toHaveBeenCalledWith(true);
  });

  it("uses recorded status unless an explicit refresh is requested", async () => {
    await dispatch(["task", "status", "--json"]);
    expect(commands.status).toHaveBeenLastCalledWith("task", true, false);
    await dispatch(["task", "status", "--refresh"]);
    expect(commands.status).toHaveBeenLastCalledWith("task", false, true);
  });

  it("parses new and rejects unsupported agents", async () => {
    await dispatch([
      "task-one",
      "new",
      "--agent",
      "codex",
      "--prompt",
      "go",
      "--template",
      "tauri",
      "--model",
      "gpt-example",
      "--effort=high",
      "--fast",
      "-d",
    ]);
    expect(commands.newTask).toHaveBeenCalledWith("task-one", {
      agent: "codex",
      prompt: "go",
      template: "tauri",
      model: "gpt-example",
      effort: "high",
      fast: true,
      detach: true,
    });
    await expect(
      dispatch(["task-two", "new", "--agent", "codex", "--allow-service", "github"]),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["old", "new", "--agent", "vibe"])).rejects.toThrow();
    await dispatch(["task-two", "new", "--no-fast", "-d"]);
    expect(commands.newTask).toHaveBeenLastCalledWith("task-two", {
      fast: false,
      detach: true,
    });
    await expect(dispatch(["new", "old", "--agent", "codex"])).rejects.toBeInstanceOf(UsageError);
  });

  it("accepts safe init defaults and explicit optional features", async () => {
    await dispatch(["init"]);
    expect(machineInit.initializeMachine).toHaveBeenCalledOnce();
    await expect(dispatch(["init", "--yes"])).rejects.toBeInstanceOf(UsageError);

    await dispatch(["project", "init"]);
    expect(commands.initialize).toHaveBeenLastCalledWith({});

    await dispatch([
      "project",
      "init",
      "--integration=remote",
      "--remote",
      "origin",
      "--base",
      "main",
      "--checks",
      "--no-preview",
      "--yes",
      "--agent",
      "codex",
      "--model=gpt-example",
      "--effort",
      "medium",
      "--fast",
    ]);
    expect(commands.initialize).toHaveBeenLastCalledWith({
      integration: "remote",
      remote: "origin",
      base: "main",
      checks: true,
      preview: false,
      yes: true,
      agent: "codex",
      model: "gpt-example",
      effort: "medium",
      fast: true,
    });
    await dispatch([
      "project",
      "init",
      "--preview-command",
      "npm run storybook -- --host 0.0.0.0",
      "--preview-port=6006",
      "--preview-port",
      "6007",
    ]);
    expect(commands.initialize).toHaveBeenLastCalledWith({
      previewCommand: "npm run storybook -- --host 0.0.0.0",
      previewPorts: [6006, 6007],
    });
    await expect(
      dispatch(["project", "init", "--preview-command", "npm start"]),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["project", "init", "--preview-port", "3000"])).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(
      dispatch([
        "project",
        "init",
        "--no-preview",
        "--preview-command",
        "npm start",
        "--preview-port",
        "3000",
      ]),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["project", "init", "--port", "70000"])).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it("dispatches authentication and provider-specific doctor checks", async () => {
    await expect(dispatch(["auth", "codex"])).resolves.toBe(0);
    expect(commands.authenticate).toHaveBeenCalledWith("codex", undefined);
    await dispatch(["auth", "codex", "--api-key"]);
    expect(commands.authenticate).toHaveBeenLastCalledWith("codex", "api-key");
    await dispatch(["auth", "codex", "--oauth"]);
    expect(commands.authenticate).toHaveBeenLastCalledWith("codex", "oauth");
    await expect(dispatch(["auth", "codex", "--oauth", "--api-key"])).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(dispatch(["auth", "claude", "--oauth"])).rejects.toBeInstanceOf(UsageError);

    await dispatch(["doctor", "--agent=claude", "--json"]);
    expect(commands.doctor).toHaveBeenCalledWith(false, "claude");
    expect(commands.printDoctor).toHaveBeenCalledWith({ ok: true, warnings: [], checks: [] }, true);
    await expect(dispatch(["auth", "vibe"])).rejects.toBeInstanceOf(UsageError);
  });

  it("parses explicit force recovery for an unresponsive daemon", async () => {
    await dispatch(["daemon", "install"]);
    expect(service.resolveBoxersExecutable).toHaveBeenCalledOnce();
    expect(service.installDaemonService).toHaveBeenLastCalledWith("/opt/boxers/bin/boxers");
    await dispatch(["daemon", "start"]);
    expect(daemonCommands.daemonStart).toHaveBeenCalledOnce();
    await dispatch(["daemon", "stop"]);
    expect(daemonCommands.daemonStop).toHaveBeenLastCalledWith(false);
    await dispatch(["daemon", "stop", "--force"]);
    expect(daemonCommands.daemonStop).toHaveBeenLastCalledWith(true);
    await dispatch(["daemon", "restart"]);
    expect(daemonCommands.daemonRestart).toHaveBeenLastCalledWith(false);
    await dispatch(["daemon", "restart", "--force"]);
    expect(daemonCommands.daemonRestart).toHaveBeenLastCalledWith(true);
    await expect(dispatch(["daemon", "stop", "--hard"])).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["daemon", "restart", "--hard"])).rejects.toBeInstanceOf(UsageError);
  });

  it("keeps foreground daemon execution under debug and a private service entrypoint", async () => {
    await dispatch(["debug", "daemon"]);
    expect(daemonCommands.runDaemonForeground).toHaveBeenLastCalledWith(true);

    await dispatch(["__daemon-run"]);
    expect(daemonCommands.runDaemonForeground).toHaveBeenLastCalledWith();
    await expect(dispatch(["debug", "daemon", "extra"])).rejects.toBeInstanceOf(UsageError);
  });

  it("parses reciprocal fleet connection, administration, and private synchronization", async () => {
    await dispatch([
      "connect",
      "user@server",
      "--name",
      "build-box",
      "--reverse-host=laptop",
      "--no-install",
      "--observe-only",
    ]);
    expect(fleetConnect.connectHost).toHaveBeenCalledWith({
      host: "user@server",
      name: "build-box",
      reverseHost: "laptop",
      install: false,
      admin: false,
    });

    await dispatch(["disconnect", "build-box"]);
    expect(fleetConnect.disconnectHost).toHaveBeenCalledWith("build-box");

    await dispatch(["doctor", "--all", "--json", "--agent=codex"]);
    expect(fleetAdmin.doctorFleet).toHaveBeenCalledWith(
      { ok: true, warnings: [], checks: [] },
      {
        all: true,
        json: true,
        agent: "codex",
        acknowledgeOpenNetwork: false,
      },
    );

    await dispatch(["update", "--all", "--to", "1.2.3"]);
    expect(fleetAdmin.updateFleet).toHaveBeenCalledWith({ all: true, version: "1.2.3" });

    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await dispatch(["remote", "sync-fleet", "payload"]);
    expect(fleetConnect.acceptFleetSync).toHaveBeenCalledWith("payload");
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"fleetId":"fleet"'));
    write.mockRestore();
  });

  it("persists model and effort overrides when attaching", async () => {
    await dispatch(["task", "attach", "--model", "gpt-example", "--effort=high", "--fast"]);
    expect(commands.attach).toHaveBeenCalledWith("task", {
      model: "gpt-example",
      effort: "high",
      fast: true,
    });
  });

  it("routes the existing-task command suite through SSH", async () => {
    await dispatch(["server/task", "attach", "--effort", "high"]);
    expect(machines.runRemoteTaskCommand).toHaveBeenCalledWith(
      "server",
      "task",
      ["attach", "--effort", "high"],
      true,
    );
    expect(commands.attach).not.toHaveBeenCalledWith("server/task", expect.anything());

    await dispatch(["server/task", "promote", "--message", "Ship it"]);
    expect(machines.runRemoteTaskCommand).toHaveBeenLastCalledWith(
      "server",
      "task",
      ["promote", "--message", "Ship it"],
      true,
    );

    await dispatch(["server/task", "status", "--json"]);
    expect(machines.runRemoteTaskCommand).toHaveBeenLastCalledWith(
      "server",
      "task",
      ["status", "--json"],
      false,
    );

    await expect(dispatch(["server/task", "new", "--agent", "codex"])).rejects.toThrow(
      "<machine>/<project>/<task>",
    );

    await dispatch(["server/boxers/new-task", "new", "--agent", "codex", "-d"]);
    expect(machines.runRemoteCommand).toHaveBeenLastCalledWith(
      "server",
      [
        "__remote-new-project",
        "boxers",
        "new-task",
        "git@github.com:owner/repo.git",
        "main",
        "--agent",
        "codex",
        "-d",
      ],
      true,
    );

    await dispatch(["server/other-project/another-task", "new", "-d"]);
    expect(machines.runRemoteCommand).toHaveBeenLastCalledWith(
      "server",
      ["__remote-new", "other-project", "another-task", "-d"],
      true,
    );
  });

  it("rejects removed commands and aliases", async () => {
    await expect(dispatch(["task", "commit-push"])).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["task", "merge"])).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["task", "inspect"])).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["task", "stop"])).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["task", "shell"])).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["task", "rm"])).rejects.toBeInstanceOf(UsageError);
    await dispatch(["task", "sync"]);
    expect(commands.sync).toHaveBeenCalledWith("task");
  });

  it("keeps remote snapshot and watch as internal protocol commands", async () => {
    await expect(dispatch(["machine", "list"])).rejects.toBeInstanceOf(UsageError);
    await expect(dispatch(["machines"])).rejects.toBeInstanceOf(UsageError);
    await dispatch(["remote", "snapshot"]);
    expect(machines.remoteSnapshot).toHaveBeenCalledOnce();
    await dispatch(["remote", "watch"]);
    expect(machines.remoteWatch).toHaveBeenCalledOnce();
  });

  it("provisions the current project on a remote machine explicitly", async () => {
    await dispatch(["project", "add", "server", "--clone", "--into", "/srv/boxers"]);
    expect(machines.runRemoteCommand).toHaveBeenCalledWith(
      "server",
      ["__remote-project-clone", "git@github.com:owner/repo.git", "main", "/srv/boxers"],
      true,
    );

    await dispatch(["__remote-project-clone", "source", "main", "/srv/project"]);
    expect(commands.cloneAndInitializeProject).toHaveBeenCalledWith(
      "source",
      "main",
      "/srv/project",
    );
  });

  it("parses the private remote creation entrypoint on the authoritative host", async () => {
    await dispatch(["__remote-new", "project-id", "task", "--agent", "claude", "--detach"]);
    expect(commands.newTaskInProject).toHaveBeenCalledWith("project-id", "task", {
      agent: "claude",
      detach: true,
    });

    await dispatch([
      "__remote-new-project",
      "project-id",
      "task",
      "git@example.test:owner/repo.git",
      "main",
      "--agent",
      "codex",
      "-d",
    ]);
    expect(commands.newTaskInProject).toHaveBeenLastCalledWith(
      "project-id",
      "task",
      { agent: "codex", detach: true },
      { source: "git@example.test:owner/repo.git", base: "main" },
    );
  });

  it("dispatches check and parses the explicit promotion check override", async () => {
    await dispatch(["task", "check"]);
    expect(commands.check).toHaveBeenCalledWith("task");

    await dispatch(["task", "promote", "--skip-checks", "--message", "Ship candidate"]);
    expect(commands.promote).toHaveBeenCalledWith("task", "Ship candidate", true);

    await dispatch(["task", "promote"]);
    expect(commands.promote).toHaveBeenLastCalledWith("task", undefined, false);
    await expect(dispatch(["task", "promote", "--force"])).rejects.toBeInstanceOf(UsageError);
  });

  it("shows a preview when no preview action is given", async () => {
    await dispatch(["mytask", "preview"]);
    expect(commands.preview).toHaveBeenCalledWith("mytask", "show");

    await dispatch(["mytask", "preview", "logs"]);
    expect(commands.preview).toHaveBeenLastCalledWith("mytask", "logs");
  });
});
