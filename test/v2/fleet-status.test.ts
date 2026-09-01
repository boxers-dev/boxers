import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showAuthenticationStatus, showFleetStatus } from "../../src/v2/fleet-status.ts";
import { atomicWriteJson, hostStatusPath } from "../../src/v2/paths.ts";
import type { HostStatusObservation } from "../../src/v2/types.ts";

const originalHome = process.env.BOXERS_HOME;
const cleanup: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = originalHome;
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("fleet host status", () => {
  it("keeps health and provider readiness as independent dimensions", async () => {
    const home = mkdtempSync(join(tmpdir(), "boxers-fleet-status-"));
    cleanup.push(home);
    process.env.BOXERS_HOME = home;
    const status: HostStatusObservation = {
      version: 1,
      observedAt: new Date().toISOString(),
      boxersVersion: "1.2.3",
      health: "healthy",
      daemon: "running",
      authentication: { codex: "configured", claude: "missing" },
      checks: [],
    };
    atomicWriteJson(hostStatusPath(), status);
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(showFleetStatus({ refresh: false, json: false })).resolves.toBe(0);
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("healthy");
    expect(output).toContain("configured");
    expect(output).toContain("missing");
    write.mockClear();
    await expect(
      showAuthenticationStatus({ refresh: false, all: false, json: true }),
    ).resolves.toBe(1);
    expect(write.mock.calls.map((call) => String(call[0])).join("")).toContain(
      '"claude":"missing"',
    );
  });
});
