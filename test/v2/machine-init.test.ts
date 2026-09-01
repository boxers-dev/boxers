import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({
  answers: [] as string[],
  question: vi.fn<(text: string) => Promise<string>>(),
  close: vi.fn(),
}));
const auth = vi.hoisted(() => ({ authenticateAgent: vi.fn(), interactive: true }));
const daemon = vi.hoisted(() => ({ start: vi.fn(async () => 0) }));
const service = vi.hoisted(() => ({
  status: vi.fn(() => ({
    supported: true,
    installed: true,
    enabled: true,
    active: false,
    platform: "test",
    detail: "installed",
  })),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: prompts.question, close: prompts.close }),
}));
vi.mock("../../src/v2/auth.ts", () => ({
  isInteractive: () => auth.interactive,
  isSshSession: () => false,
  authenticateAgent: auth.authenticateAgent,
}));
vi.mock("../../src/v2/daemon-commands.ts", () => ({ daemonStart: daemon.start }));
vi.mock("../../src/v2/service.ts", () => ({
  daemonServiceStatus: service.status,
  installDaemonService: vi.fn(),
  resolveBoxersExecutable: vi.fn(),
}));
vi.mock("../../src/v2/host-status.ts", () => ({
  collectHostStatus: () => ({
    health: "healthy",
    authentication: { codex: "missing", claude: "missing" },
    checks: [
      { id: "runtime.host", category: "health", status: "ok", detail: "supported" },
      {
        id: "runtime.docker-sandboxes",
        category: "health",
        status: "ok",
        detail: "installed",
      },
      { id: "runtime.docker-login", category: "health", status: "ok", detail: "signed in" },
      {
        id: "runtime.network-policy",
        category: "health",
        status: "ok",
        detail: "balanced",
      },
    ],
  }),
}));
vi.mock("../../src/v2/process.ts", () => ({
  command: vi.fn((cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "--version")
      return { status: 0, stdout: "git version 2.50.0\n", stderr: "" };
    if (cmd === "git" && args.includes("user.name"))
      return { status: 0, stdout: "Test User\n", stderr: "" };
    if (cmd === "git" && args.includes("user.email"))
      return { status: 0, stdout: "test@example.invalid\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  }),
}));

import { initializeMachine } from "../../src/v2/machine-init.ts";
import { isMachineSetupComplete } from "../../src/v2/machine-setup.ts";

let stateDir: string;

describe("machine initialization", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "boxers-machine-init-"));
    process.env.BOXERS_HOME = stateDir;
    auth.interactive = true;
    auth.authenticateAgent.mockReset();
    daemon.start.mockClear();
    service.status.mockClear();
    prompts.answers = ["yes", "no"];
    prompts.question.mockReset();
    prompts.question.mockImplementation(async () => prompts.answers.shift() ?? "");
    prompts.close.mockReset();
  });

  afterEach(() => {
    delete process.env.BOXERS_HOME;
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
  });

  it("offers provider authentication independently and starts the daemon", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(initializeMachine()).resolves.toBe(0);

    expect(isMachineSetupComplete()).toBe(true);
    expect(auth.authenticateAgent).toHaveBeenCalledWith("codex", { mode: "oauth" });
    expect(auth.authenticateAgent).not.toHaveBeenCalledWith("claude", expect.anything());
    expect(daemon.start).toHaveBeenCalledOnce();
    expect(write.mock.calls.flat().join("")).toContain("Boxers is ready");
  });

  it("requires an interactive terminal", async () => {
    auth.interactive = false;
    await expect(initializeMachine()).rejects.toThrow("Machine initialization is interactive");
  });
});
