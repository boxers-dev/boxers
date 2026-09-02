import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonDoctorChecks } from "../../src/v2/commands.ts";
import { DAEMON_PROTOCOL_VERSION } from "../../src/v2/daemon-protocol.ts";
import type { DaemonServiceStatus } from "../../src/v2/service.ts";

const current: DaemonServiceStatus = {
  supported: true,
  installed: true,
  enabled: true,
  active: true,
  pid: 1234,
  protocolVersion: DAEMON_PROTOCOL_VERSION,
  boxersVersion: "1.2.3",
  startedAt: "2026-08-26T12:00:00.000Z",
  platform: "systemd-user",
  detail: "service enabled; daemon active",
};

describe("daemon doctor checks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("reports process, service, and protocol as separate dimensions", () => {
    const checks = daemonDoctorChecks(current, "1.2.3");

    expect(checks).toEqual([
      expect.objectContaining({ name: "daemon process", ok: true }),
      expect.objectContaining({ name: "daemon service", ok: true }),
      expect.objectContaining({ name: "daemon protocol", ok: true }),
    ]);
    expect(checks[0]?.detail).toContain("pid 1234");
    expect(checks[0]?.detail).not.toContain("2026-08-26T12:00:00.000Z");
    expect(checks[0]?.detail).toContain("since yesterday");
  });

  it("offers a safe restart when an active daemon is incompatible", () => {
    const checks = daemonDoctorChecks(
      {
        supported: true,
        installed: true,
        enabled: true,
        active: true,
        pid: 1234,
        platform: "systemd-user",
        detail: "service enabled; daemon active",
      },
      "1.2.3",
    );
    const protocol = checks.find((check) => check.name === "daemon protocol");

    expect(protocol).toMatchObject({
      ok: false,
      detail: "protocol unknown; daemon unknown; CLI 1.2.3",
    });
    expect(protocol?.remediation?.value).toContain("boxers daemon stop");
  });

  it("reports an exact managed-build mismatch even when version and protocol match", () => {
    const checks = daemonDoctorChecks(
      { ...current, boxersBuildId: "a".repeat(64) },
      "1.2.3",
      "b".repeat(64),
    );
    const protocol = checks.find((check) => check.name === "daemon protocol");

    expect(protocol).toMatchObject({ ok: false });
    expect(protocol?.detail).toContain("daemon build aaaaaaaa; active build bbbbbbbb");
  });

  it("explains automatic startup while leaving protocol remediation quiet when inactive", () => {
    const checks = daemonDoctorChecks(
      {
        supported: true,
        installed: true,
        enabled: true,
        active: false,
        platform: "systemd-user",
        detail: "service enabled; daemon inactive",
      },
      "1.2.3",
    );
    const process = checks.find((check) => check.name === "daemon process");
    const protocol = checks.find((check) => check.name === "daemon protocol");

    expect(process).toMatchObject({ ok: false, detail: "inactive" });
    expect(process?.remediation?.value).toContain("starts the daemon automatically");
    expect(protocol).toMatchObject({
      ok: false,
      detail: "unavailable while daemon is inactive",
    });
    expect(protocol?.remediation).toBeUndefined();
  });

  it("offers the user-facing daemon installation command", () => {
    const checks = daemonDoctorChecks({
      supported: true,
      installed: false,
      enabled: false,
      active: false,
      platform: "systemd-user",
      detail: "user service is not installed; daemon inactive",
    });
    const service = checks.find((check) => check.name === "daemon service");

    expect(service?.remediation?.value).toBe("boxers daemon install");
  });
});
