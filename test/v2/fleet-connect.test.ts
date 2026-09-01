import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectHost, disconnectHost } from "../../src/v2/fleet-connect.ts";
import { ensureFleet, localFleetMember, localHostKey, readFleet } from "../../src/v2/fleet.ts";
import { localMachineIdentity } from "../../src/v2/registry.ts";
import { listRemoteMachines } from "../../src/v2/machines.ts";

const cleanup: string[] = [];
const originalHome = process.env.BOXERS_HOME;
const originalPath = process.env.PATH;
const originalEntry = process.argv[1];

afterEach(() => {
  if (originalHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalEntry === undefined) process.argv.splice(1, 1);
  else process.argv[1] = originalEntry;
  delete process.env.FAKE_REMOTE_IDENTITY;
  delete process.env.FAKE_REMOTE_FLEET;
  delete process.env.FAKE_SSH_LOG;
  delete process.env.FAKE_VERIFY_FAIL;
  delete process.env.FAKE_UNENROLL_FAIL;
  delete process.env.FAKE_SERVICE_FAIL;
  delete process.env.FAKE_SETUP_MARKER;
  delete process.env.FAKE_UNINITIALIZED_IDENTITY;
  delete process.env.FAKE_BOOTSTRAP_FAILURE;
  vi.restoreAllMocks();
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(value);
  return value;
}

function fixture(): { localHome: string; log: string; remoteId: string } {
  const remoteHome = directory("boxers-connect-remote-");
  process.env.BOXERS_HOME = remoteHome;
  ensureFleet("fleet-id");
  const remoteMachine = localMachineIdentity();
  const remoteMember = localFleetMember(
    [{ transport: "ssh", target: "remote-box", executable: "boxers" }],
    ["observe", "operate", "admin"],
  );
  process.env.FAKE_REMOTE_IDENTITY = JSON.stringify({
    protocolVersion: 1,
    machine: remoteMachine,
    publicKey: localHostKey().publicKey,
    boxersVersion: "0.2.0",
    executable: "boxers",
    setupComplete: true,
    fleetId: "fleet-id",
    diagnostics: [],
  });
  process.env.FAKE_REMOTE_FLEET = JSON.stringify({
    version: 1,
    fleetId: "fleet-id",
    members: [remoteMember],
    removedMembers: [],
    sentAt: new Date().toISOString(),
  });

  const localHome = directory("boxers-connect-local-");
  process.env.BOXERS_HOME = localHome;
  ensureFleet("fleet-id");

  const bin = directory("boxers-connect-bin-");
  const log = join(bin, "ssh.log");
  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_SSH_LOG"
if [ -n "$FAKE_BOOTSTRAP_FAILURE" ]; then
  case "$*" in
    *" remote identity") printf '%s\n' 'boxers: command not found' >&2; exit 127 ;;
    *" sh -s -- "*) cat >/dev/null; printf '%s\n' 'npm ERR! code E401' >&2; exit 1 ;;
  esac
fi
case "$*" in
  *" remote identity")
    if [ -n "$FAKE_SETUP_MARKER" ] && [ ! -f "$FAKE_SETUP_MARKER" ]; then
      printf '%s\n' "$FAKE_UNINITIALIZED_IDENTITY"
    else
      printf '%s\n' "$FAKE_REMOTE_IDENTITY"
    fi
    ;;
  *" init") touch "$FAKE_SETUP_MARKER" ;;
  *" remote sync-fleet "*) printf '%s\n' "$FAKE_REMOTE_FLEET" ;;
  *" remote verify-peer "*) test -z "$FAKE_VERIFY_FAIL" ;;
  *" remote unenroll "*) test -z "$FAKE_UNENROLL_FAIL" ;;
  *" service install "*) test -z "$FAKE_SERVICE_FAIL" ;;
  *) printf '{}\n' ;;
esac
`,
  );
  chmodSync(ssh, 0o755);
  process.env.FAKE_SSH_LOG = log;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  // Development entrypoints intentionally skip persistent service installation.
  process.argv[1] = join(bin, "boxers.ts");
  return { localHome, log, remoteId: remoteMachine.id };
}

describe("reciprocal fleet connection", () => {
  it("streams bootstrap diagnostics and includes operation context in failures", async () => {
    fixture();
    process.env.FAKE_BOOTSTRAP_FAILURE = "1";
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(
      connectHost({
        host: "remote-box",
        reverseHost: "local-box",
        install: true,
        admin: false,
      }),
    ).rejects.toThrow(
      "Boxers 0.2.0 installation on remote-box failed (exit 1):\nnpm ERR! code E401",
    );
    expect(stderr.mock.calls.flat().join("")).toContain("npm ERR! code E401");
  });

  it("runs machine initialization through a TTY only on the first connection", async () => {
    const { log } = fixture();
    const initialized = JSON.parse(process.env.FAKE_REMOTE_IDENTITY!) as Record<string, unknown>;
    process.env.FAKE_UNINITIALIZED_IDENTITY = JSON.stringify({
      ...initialized,
      setupComplete: false,
    });
    const marker = join(directory("boxers-connect-setup-"), "complete");
    process.env.FAKE_SETUP_MARKER = marker;
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await expect(
        connectHost({
          host: "remote-box",
          reverseHost: "local-box",
          install: false,
          admin: false,
        }),
      ).resolves.toBe(0);
      await expect(
        connectHost({
          host: "remote-box",
          reverseHost: "local-box",
          install: false,
          admin: false,
        }),
      ).resolves.toBe(0);
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }

    const calls = readFileSync(log, "utf8").split("\n");
    expect(calls.filter((call) => call.endsWith(" boxers init"))).toHaveLength(1);
    expect(calls.findIndex((call) => call.endsWith(" boxers init"))).toBeLessThan(
      calls.findIndex((call) => call.includes(" remote enroll ")),
    );
  });

  it("enrolls both directions and records the remote route locally", async () => {
    const { remoteId } = fixture();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(
      connectHost({
        host: "remote-box",
        reverseHost: "local-box",
        install: false,
        admin: false,
      }),
    ).resolves.toBe(0);

    const fleet = readFleet();
    expect(fleet?.members.find((member) => member.hostId === remoteId)?.roles).toEqual(["observe"]);
    expect(
      fleet?.members.find((member) => member.hostId === localMachineIdentity().id)?.roles,
    ).toEqual(["observe", "operate", "admin"]);
    expect(listRemoteMachines()).toContainEqual(
      expect.objectContaining({ id: remoteId, sshHost: "remote-box", executable: "boxers" }),
    );
  });

  it("cleans up failed reverse enrollment and propagates an offline disconnect honestly", async () => {
    const { log, remoteId } = fixture();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.env.FAKE_VERIFY_FAIL = "1";

    await expect(
      connectHost({
        host: "remote-box",
        reverseHost: "local-box",
        install: false,
        admin: true,
      }),
    ).rejects.toThrow("could not connect back");
    expect(readFileSync(log, "utf8")).toContain("remote unenroll");
    expect(readFleet()?.members.some((member) => member.hostId === remoteId)).toBe(false);

    delete process.env.FAKE_VERIFY_FAIL;
    await connectHost({
      host: "remote-box",
      reverseHost: "local-box",
      install: false,
      admin: true,
    });
    process.env.FAKE_UNENROLL_FAIL = "1";
    await expect(disconnectHost(remoteId)).resolves.toBe(0);
    expect(readFleet()?.members.some((member) => member.hostId === remoteId)).toBe(false);
    expect(readFleet()?.removedMembers?.some((member) => member.hostId === remoteId)).toBe(true);
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "could not be updated",
    );
  });

  it("keeps successful enrollment but reports remote service setup failure", async () => {
    const { remoteId } = fixture();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.env.FAKE_SERVICE_FAIL = "1";

    await expect(
      connectHost({
        host: "remote-box",
        reverseHost: "local-box",
        install: false,
        admin: true,
      }),
    ).resolves.toBe(1);
    expect(readFleet()?.members.some((member) => member.hostId === remoteId)).toBe(true);
    expect(listRemoteMachines()).toContainEqual(expect.objectContaining({ id: remoteId }));
    expect(stderr.mock.calls.flat().join("")).toContain(
      "remote daemon service could not be installed",
    );
  });

  it("keeps successful enrollment but reports local service setup failure", async () => {
    const { remoteId } = fixture();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.argv[1] = "/opt/boxers/bin/boxers";

    await expect(
      connectHost(
        {
          host: "remote-box",
          reverseHost: "local-box",
          install: false,
          admin: true,
        },
        {
          installService: () => {
            throw new Error("local service unavailable");
          },
        },
      ),
    ).resolves.toBe(1);
    expect(readFleet()?.members.some((member) => member.hostId === remoteId)).toBe(true);
    expect(stderr.mock.calls.flat().join("")).toContain(
      "local daemon service could not be installed",
    );
  });
});
