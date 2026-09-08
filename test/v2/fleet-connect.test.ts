import * as fleetRelease from "../../src/v2/fleet-release.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hostRelease from "../../src/v2/host-release.ts";
import * as release from "../../src/v2/release.ts";
import * as bootstrap from "../../src/v2/release-bootstrap.ts";
import { readVersion } from "../../src/core/version.ts";
import {
  connectHost,
  disconnectHost,
  remoteIdentity,
  renameHost,
} from "../../src/v2/fleet-connect.ts";
import {
  enrollFleetMember,
  ensureFleet,
  localFleetMember,
  localHostKey,
  readFleet,
} from "../../src/v2/fleet.ts";
import { localMachineIdentity } from "../../src/v2/registry.ts";
import { listRemoteMachines } from "../../src/v2/machines.ts";
import { ensureManagedSshIdentity } from "../../src/v2/ssh-identity.ts";

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
  delete process.env.FAKE_REMOTE_SSH_IDENTITY;
  delete process.env.FAKE_SSH_LOG;
  delete process.env.FAKE_VERIFY_FAIL;
  delete process.env.FAKE_ENROLL_FAIL;
  delete process.env.FAKE_UNENROLL_FAIL;
  delete process.env.FAKE_SERVICE_FAIL;
  delete process.env.FAKE_SETUP_MARKER;
  delete process.env.FAKE_UNINITIALIZED_IDENTITY;
  delete process.env.FAKE_BOOTSTRAP_FAILURE;
  delete process.env.BOXERS_AUTHORIZED_KEYS;
  vi.restoreAllMocks();
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(value);
  return value;
}

function fixture(): { localHome: string; log: string; remoteId: string } {
  const packageRoot = directory("boxers-connect-package-");
  mkdirSync(join(packageRoot, "dist"));
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@boxers-dev/boxers", version: readVersion() }),
  );
  writeFileSync(join(packageRoot, "dist/index.mjs"), "// fixture");
  const capsule = release.createReleaseCapsule(packageRoot);
  const manifest = release.decodeReleaseCapsule(capsule).manifest;
  vi.spyOn(release, "createReleaseCapsule").mockReturnValue(capsule);
  vi.spyOn(hostRelease, "activateHostRelease").mockResolvedValue({
    manifest,
    stableExecutable: "boxers",
    executable: "boxers",
    runtimeInstalled: false,
    daemonReplacementRequired: false,
  });
  vi.spyOn(fleetRelease, "sendFleetReleaseWithBootstrap").mockImplementation(
    async (machine, state) => ({
      version: 1,
      hostId: machine.id,
      buildId: manifest.buildId,
      packageVersion: manifest.packageVersion,
      runtimeInstalled: false,
      daemonReplacementRequired: false,
      update: state,
    }),
  );
  vi.spyOn(bootstrap, "bootstrapHostRelease").mockImplementation(
    async () => process.env.FAKE_REMOTE_IDENTITY!,
  );
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
    boxersVersion: readVersion(),
    buildId: manifest.buildId,
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
  const managedSsh = ensureManagedSshIdentity();
  process.env.FAKE_REMOTE_SSH_IDENTITY = JSON.stringify({
    version: 1,
    publicKey: managedSsh.publicKey,
    fingerprint: managedSsh.fingerprint,
  });

  const localHome = directory("boxers-connect-local-");
  process.env.BOXERS_HOME = localHome;
  process.env.BOXERS_AUTHORIZED_KEYS = join(localHome, "authorized_keys");
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
  *" remote ssh-identity") printf '%s\n' "$FAKE_REMOTE_SSH_IDENTITY" ;;
  *" remote identity")
    if [ -n "$FAKE_SETUP_MARKER" ] && [ ! -f "$FAKE_SETUP_MARKER" ]; then
      printf '%s\n' "$FAKE_UNINITIALIZED_IDENTITY"
    else
      printf '%s\n' "$FAKE_REMOTE_IDENTITY"
    fi
    ;;
  *" init") touch "$FAKE_SETUP_MARKER" ;;
  *" remote enroll "*) test -z "$FAKE_ENROLL_FAIL" ;;
  *" remote unenroll "*) test -z "$FAKE_UNENROLL_FAIL" ;;
  *"boxers-gateway-request "*)
    for token do :; done
    decoded=$(node -e 'const value=JSON.parse(Buffer.from(process.argv[1], "base64url")); process.stdout.write(value.args.join(" "))' "$token")
    case "$decoded" in
      "remote sync-fleet "*) printf '%s\n' "$FAKE_REMOTE_FLEET" ;;
      "remote rename-host "*) printf '%s\n' "$FAKE_REMOTE_FLEET" ;;
      "remote verify-peer "*) test -z "$FAKE_VERIFY_FAIL" ;;
      "remote unenroll "*) test -z "$FAKE_UNENROLL_FAIL" ;;
      "service install "*) test -z "$FAKE_SERVICE_FAIL" ;;
      *) printf '{}\n' ;;
    esac
    ;;
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
  it("keeps bootstrap identity discovery free of live runtime diagnostics", () => {
    process.env.BOXERS_HOME = directory("boxers-connect-identity-");
    const bin = directory("boxers-connect-identity-bin-");
    const marker = join(bin, "sbx-called");
    const sbx = join(bin, "sbx");
    writeFileSync(sbx, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(sbx, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    expect(remoteIdentity().diagnostics).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("streams bootstrap diagnostics and includes operation context in failures", async () => {
    fixture();
    process.env.FAKE_BOOTSTRAP_FAILURE = "1";
    vi.mocked(bootstrap.bootstrapHostRelease).mockRejectedValue(
      new Error("Installing the Boxers build on remote-box failed (exit 1): npm ERR! code E401"),
    );
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(
      connectHost({
        host: "remote-box",
        reverseHost: "local-box",
        install: true,
        admin: false,
      }),
    ).rejects.toThrow(
      "Installing the Boxers build on remote-box failed (exit 1): npm ERR! code E401",
    );
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
    const { log, remoteId } = fixture();
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
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("remote authorize-peer");
    expect(calls).toContain("IdentitiesOnly=yes");
    expect(calls).toContain("boxers-gateway-request");
  });

  it("renames a host on its owning machine and applies the returned fleet record", async () => {
    const { remoteId } = fixture();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const payload = JSON.parse(process.env.FAKE_REMOTE_FLEET!) as {
      members: ReturnType<typeof localFleetMember>[];
    };
    enrollFleetMember("fleet-id", payload.members[0]!);
    payload.members[0] = {
      ...payload.members[0]!,
      name: "builder",
      enrolledAt: "2099-01-01T00:00:00.000Z",
    };
    process.env.FAKE_REMOTE_FLEET = JSON.stringify(payload);

    await expect(renameHost("remote-box", "builder")).resolves.toBe(0);

    expect(readFleet()?.members.find((member) => member.hostId === remoteId)?.name).toBe("builder");
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
    ).rejects.toThrow("managed reciprocal SSH");
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

  it("revokes both managed keys when enrollment fails after authorization", async () => {
    const { localHome, log, remoteId } = fixture();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.env.FAKE_ENROLL_FAIL = "1";

    await expect(
      connectHost({
        host: "remote-box",
        reverseHost: "local-box",
        install: false,
        admin: true,
      }),
    ).rejects.toThrow("managed reciprocal SSH");

    expect(readFileSync(log, "utf8")).toContain("remote revoke-peer");
    expect(readFleet()?.members.some((member) => member.hostId === remoteId)).toBe(false);
    expect(readFileSync(join(localHome, "authorized_keys"), "utf8")).not.toContain(remoteId);
  });

  it("does not enroll when shared host activation fails", async () => {
    const { remoteId, log } = fixture();
    vi.mocked(hostRelease.activateHostRelease).mockRejectedValue(
      new Error("local service unavailable"),
    );
    await expect(
      connectHost({ host: "remote-box", reverseHost: "local-box", install: true, admin: true }),
    ).rejects.toThrow("local service unavailable");
    expect(readFleet()?.members.some((member) => member.hostId === remoteId)).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  it("aligns equal versions with different builds before enrollment", async () => {
    const { log } = fixture();
    const identity = JSON.parse(process.env.FAKE_REMOTE_IDENTITY!);
    process.env.FAKE_REMOTE_IDENTITY = JSON.stringify({ ...identity, buildId: "a".repeat(64) });
    vi.mocked(bootstrap.bootstrapHostRelease).mockImplementation(async () => {
      expect(readFileSync(log, "utf8")).not.toContain("remote enroll");
      return JSON.stringify(identity);
    });
    await expect(
      connectHost({ host: "remote-box", reverseHost: "local-box", install: true, admin: true }),
    ).resolves.toBe(0);
    expect(bootstrap.bootstrapHostRelease).toHaveBeenCalledWith("remote-box", expect.any(Buffer));
  });

  it("rejects an activation that confirms the wrong build before enrollment", async () => {
    const { log } = fixture();
    vi.mocked(bootstrap.bootstrapHostRelease).mockResolvedValue(
      JSON.stringify({ ...JSON.parse(process.env.FAKE_REMOTE_IDENTITY!), buildId: "b".repeat(64) }),
    );
    await expect(
      connectHost({ host: "remote-box", reverseHost: "local-box", install: true, admin: true }),
    ).rejects.toThrow("did not confirm the requested build");
    expect(readFileSync(log, "utf8")).not.toContain("remote enroll");
    expect(fleetRelease.sendFleetReleaseWithBootstrap).not.toHaveBeenCalled();
  });

  it("uses the shared downgrade policy before replacing a newer remote release", async () => {
    fixture();
    process.env.FAKE_REMOTE_IDENTITY = JSON.stringify({
      ...JSON.parse(process.env.FAKE_REMOTE_IDENTITY!),
      boxersVersion: "99.0.0",
    });
    const confirm = vi.spyOn(fleetRelease, "confirmFleetDowngrade").mockResolvedValue(false);
    await expect(
      connectHost({ host: "remote-box", reverseHost: "local-box", install: true, admin: true }),
    ).rejects.toThrow("would downgrade");
    expect(confirm).toHaveBeenCalledOnce();
    expect(bootstrap.bootstrapHostRelease).not.toHaveBeenCalled();
  });

  it("rejects an unknown build with --no-install before enrollment", async () => {
    const { log } = fixture();
    const identity = JSON.parse(process.env.FAKE_REMOTE_IDENTITY!);
    delete identity.buildId;
    process.env.FAKE_REMOTE_IDENTITY = JSON.stringify(identity);
    await expect(
      connectHost({ host: "remote-box", reverseHost: "local-box", install: false, admin: true }),
    ).rejects.toThrow("without --no-install");
    expect(readFileSync(log, "utf8")).not.toContain("remote enroll");
    expect(bootstrap.bootstrapHostRelease).not.toHaveBeenCalled();
  });
});
