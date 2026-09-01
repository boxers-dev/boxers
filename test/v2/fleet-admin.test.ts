import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateManagedExecutable, doctorFleet, updateFleet } from "../../src/v2/fleet-admin.ts";
import { enrollFleetMember, ensureFleet } from "../../src/v2/fleet.ts";
import {
  canonicalSshPublicKey,
  ensureManagedSshIdentity,
  sshPublicKeyFingerprint,
} from "../../src/v2/ssh-identity.ts";

const cleanup: string[] = [];
const originalHome = process.env.BOXERS_HOME;
const originalPath = process.env.PATH;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = originalHome;
  process.env.PATH = originalPath;
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function executable(directory: string, name: string, version: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("managed fleet update activation", () => {
  it("leaves the previous stable executable untouched until validation and service setup pass", () => {
    const directory = mkdtempSync(join(tmpdir(), "boxers-managed-update-"));
    cleanup.push(directory);
    const installs = join(directory, "installs");
    const bin = join(directory, "bin");
    mkdirSync(installs);
    mkdirSync(bin);
    const previous = executable(installs, "previous", "1.0.0");
    const candidate = executable(installs, "candidate", "2.0.0");
    const invalid = executable(installs, "invalid", "9.9.9");
    const stable = join(bin, "boxers");
    symlinkSync(previous, stable);

    expect(() => activateManagedExecutable(invalid, "2.0.0", stable, () => undefined)).toThrow(
      "expected 2.0.0",
    );
    expect(readlinkSync(stable)).toBe(previous);

    expect(() =>
      activateManagedExecutable(candidate, "2.0.0", stable, () => {
        throw new Error("service failed");
      }),
    ).toThrow("service failed");
    expect(readlinkSync(stable)).toBe(previous);

    activateManagedExecutable(candidate, "2.0.0", stable, () => undefined);
    expect(readlinkSync(stable)).toBe(candidate);
  });

  it("fans update and doctor out while retaining partial-outage results", async () => {
    const state = mkdtempSync(join(tmpdir(), "boxers-fleet-admin-state-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-fleet-admin-bin-"));
    cleanup.push(state, bin);
    process.env.BOXERS_HOME = state;
    const fleet = ensureFleet();
    const managedSsh = ensureManagedSshIdentity();
    for (const [hostId, name, target] of [
      ["good-id", "good", "good-host"],
      ["down-id", "down", "down-host"],
    ])
      enrollFleetMember(fleet.fleetId, {
        hostId: hostId!,
        name: name!,
        publicKey: `${name}-public-key`,
        ssh: {
          version: 1,
          publicKey: canonicalSshPublicKey(managedSsh.publicKey, `boxers:${hostId}`),
          fingerprint: sshPublicKeyFingerprint(managedSsh.publicKey),
        },
        endpoints: [{ transport: "ssh", target: target!, executable: "boxers" }],
        roles: ["observe", "operate", "admin"],
        enrolledAt: "2026-08-26T00:00:00.000Z",
      });
    const ssh = join(bin, "ssh");
    writeFileSync(
      ssh,
      `#!/bin/sh
case "$*" in
  *good-host*"boxers-gateway-request "*)
    for token do :; done
    decoded=$(node -e 'const value=JSON.parse(Buffer.from(process.argv[1], "base64url")); process.stdout.write(value.args.join(" "))' "$token")
    case "$decoded" in
      "remote update "*) printf '%s\n' '{"version":"1.2.3","executable":"/managed/boxers","daemonRestartRequired":true}' ;;
      "doctor --json"*) printf '%s\n' '{"ok":true,"warnings":[],"checks":[{"name":"daemon","ok":true,"detail":"ready","remediation":{"kind":"manual","value":"none"}}]}' ;;
      *) printf '%s\n' 'host unavailable' >&2; exit 1 ;;
    esac
    ;;
  *) printf '%s\n' 'host unavailable' >&2; exit 1 ;;
esac
`,
    );
    chmodSync(ssh, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(updateFleet({ all: true, version: "1.2.3" })).resolves.toBe(1);
    expect(stdout.mock.calls.flat().join("")).toContain("Updated good");
    expect(stdout.mock.calls.flat().join("")).toContain("FAILED  down");

    stdout.mockClear();
    await expect(
      doctorFleet(
        { ok: true, warnings: [], checks: [] },
        { all: true, json: true, acknowledgeOpenNetwork: false },
      ),
    ).resolves.toBe(1);
    const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(report.remotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: expect.objectContaining({ ok: true }) }),
        expect.objectContaining({ error: expect.stringContaining("host unavailable") }),
      ]),
    );
    await expect(
      doctorFleet(
        { ok: true, warnings: [], checks: [] },
        { host: "missing", all: false, json: true, acknowledgeOpenNetwork: false },
      ),
    ).rejects.toThrow('Unknown host "missing"');
  });
});
