import * as release from "../../src/v2/release.ts";
import * as hostRelease from "../../src/v2/host-release.ts";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptManagedUpdate, encodeAdminRequest, doctorFleet } from "../../src/v2/fleet-admin.ts";
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

describe("managed fleet update activation", () => {
  it("routes legacy npm updates through shared release activation", async () => {
    const state = mkdtempSync(join(tmpdir(), "boxers-managed-update-"));
    cleanup.push(state);
    process.env.BOXERS_HOME = state;
    ensureFleet();
    const capsule = Buffer.from("fixture capsule");
    vi.spyOn(release, "officialReleaseCapsule").mockReturnValue(capsule);
    const activate = vi.spyOn(hostRelease, "activateHostRelease").mockResolvedValue({
      manifest: { packageVersion: "2.0.0" } as release.ReleaseManifest,
      executable: "/managed/release/dist/index.mjs",
      stableExecutable: "/managed/bin/boxers",
      runtimeInstalled: true,
      daemonReplacementRequired: true,
    });
    await expect(acceptManagedUpdate(encodeAdminRequest("2.0.0"))).resolves.toEqual({
      version: "2.0.0",
      executable: "/managed/bin/boxers",
      daemonRestartRequired: true,
    });
    expect(release.officialReleaseCapsule).toHaveBeenCalledWith("@boxers-dev/boxers", "2.0.0");
    expect(activate).toHaveBeenCalledWith(capsule);
  });

  it("fans doctor out while retaining partial-outage results", async () => {
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
