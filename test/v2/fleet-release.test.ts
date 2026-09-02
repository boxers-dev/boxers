import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enrollFleetMember,
  ensureFleet,
  localFleetMember,
  updateLocalFleetMember,
} from "../../src/v2/fleet.ts";
import {
  acknowledgeFleetRelease,
  createFleetReleaseIntent,
  fleetReleaseIsAcknowledged,
  mergeFleetUpdateState,
  readFleetUpdateState,
} from "../../src/v2/fleet-update.ts";
import {
  acceptFleetRelease,
  newerRelease,
  reconcileFleetRelease,
  releaseProtocolUnavailable,
} from "../../src/v2/fleet-release.ts";
import {
  createReleaseCapsule,
  decodeReleaseCapsule,
  installReleaseCapsule,
} from "../../src/v2/release.ts";

const directories: string[] = [];
const environment = {
  home: process.env.HOME,
  data: process.env.XDG_DATA_HOME,
  state: process.env.BOXERS_HOME,
  path: process.env.PATH,
  authorizedKeys: process.env.BOXERS_AUTHORIZED_KEYS,
  capsule: process.env.FAKE_CAPSULE,
  updateMarker: process.env.FAKE_UPDATE_MARKER,
  updateResult: process.env.FAKE_UPDATE_RESULT,
  updateLog: process.env.FAKE_UPDATE_LOG,
};

function directory(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  directories.push(value);
  return value;
}

function restore(name: keyof typeof environment, variable: string): void {
  const value = environment[name];
  if (value === undefined) delete process.env[variable];
  else process.env[variable] = value;
}

afterEach(() => {
  restore("home", "HOME");
  restore("data", "XDG_DATA_HOME");
  restore("state", "BOXERS_HOME");
  restore("path", "PATH");
  restore("authorizedKeys", "BOXERS_AUTHORIZED_KEYS");
  restore("capsule", "FAKE_CAPSULE");
  restore("updateMarker", "FAKE_UPDATE_MARKER");
  restore("updateResult", "FAKE_UPDATE_RESULT");
  restore("updateLog", "FAKE_UPDATE_LOG");
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

function packageFixture(version = "1.2.3"): string {
  const root = directory("boxers-fleet-release-package-");
  mkdirSync(join(root, "dist"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "@boxers-dev/boxers", version, type: "module", dependencies: {} })}\n`,
  );
  writeFileSync(
    join(root, "dist", "index.mjs"),
    `#!/usr/bin/env node\nif (process.argv[2] === "--version") process.stdout.write(${JSON.stringify(`${version}\n`)});\n`,
  );
  return root;
}

describe("fleet release distribution", () => {
  it("orders stable and prerelease versions without offering downgrades", () => {
    expect(newerRelease("1.3.0", "1.2.9")).toBe(true);
    expect(newerRelease("1.2.3", "1.2.3-beta.2")).toBe(true);
    expect(newerRelease("1.2.3-beta.2", "1.2.3")).toBe(false);
    expect(newerRelease("1.2.2", "1.2.3")).toBe(false);
  });

  it("recognizes old gateways and CLIs that need the one-time npm bootstrap", () => {
    expect(
      releaseProtocolUnavailable(
        "The requested command is not available through the Boxers SSH gateway.",
      ),
    ).toBe(true);
    expect(
      releaseProtocolUnavailable(
        "Unexpected argument for remote install-release: encoded-fleet-state",
      ),
    ).toBe(true);
    expect(releaseProtocolUnavailable("The requesting member is not an administrator.")).toBe(
      false,
    );
  });

  it("rejects a signed desired manifest that differs from the streamed capsule", () => {
    const state = directory("boxers-release-mismatch-state-");
    const userHome = directory("boxers-release-mismatch-home-");
    const data = directory("boxers-release-mismatch-data-");
    process.env.BOXERS_HOME = state;
    process.env.BOXERS_AUTHORIZED_KEYS = join(state, "authorized_keys");
    process.env.HOME = userHome;
    process.env.XDG_DATA_HOME = data;
    ensureFleet();
    const capsule = createReleaseCapsule(packageFixture());
    const manifest = decodeReleaseCapsule(capsule).manifest;
    const desired = createFleetReleaseIntent({
      ...manifest,
      packageVersion: "9.9.9",
    });
    const encoded = Buffer.from(JSON.stringify(desired), "utf8").toString("base64url");

    expect(() => acceptFleetRelease(encoded, capsule)).toThrow("desired manifest");
    expect(readFleetUpdateState().acknowledgements[0]?.body.status).toBe("failed");
  });

  it("independently refuses an unconfirmed fleet downgrade", () => {
    const state = directory("boxers-release-downgrade-state-");
    process.env.BOXERS_HOME = state;
    process.env.BOXERS_AUTHORIZED_KEYS = join(state, "authorized_keys");
    ensureFleet();
    const capsule = createReleaseCapsule(packageFixture("0.0.3"));
    const desired = createFleetReleaseIntent(decodeReleaseCapsule(capsule).manifest);
    const encoded = Buffer.from(JSON.stringify(desired), "utf8").toString("base64url");

    expect(() => acceptFleetRelease(encoded, capsule)).toThrow("Refusing to downgrade");
    expect(readFleetUpdateState().acknowledgements[0]?.body.status).toBe("failed");
  });

  it("lets a returning host fetch and activate the desired release from an acknowledged peer", async () => {
    const firstHome = directory("boxers-release-first-state-");
    const secondHome = directory("boxers-release-second-state-");
    const secondUserHome = directory("boxers-release-second-home-");
    const secondData = directory("boxers-release-second-data-");
    const bin = directory("boxers-release-bin-");
    const capsulePath = join(directory("boxers-release-capsule-"), "release.bxr");
    const capsule = createReleaseCapsule(packageFixture());
    writeFileSync(capsulePath, capsule);
    const ssh = join(bin, "ssh");
    writeFileSync(ssh, '#!/bin/sh\ncat "$FAKE_CAPSULE"\n');
    chmodSync(ssh, 0o755);

    process.env.BOXERS_HOME = firstHome;
    process.env.BOXERS_AUTHORIZED_KEYS = join(firstHome, "authorized_keys");
    const fleet = ensureFleet();
    const first = localFleetMember([{ transport: "ssh", target: "first" }]);
    updateLocalFleetMember(first);

    process.env.BOXERS_HOME = secondHome;
    process.env.BOXERS_AUTHORIZED_KEYS = join(secondHome, "authorized_keys");
    ensureFleet(fleet.fleetId);
    const second = localFleetMember([{ transport: "ssh", target: "second" }]);
    updateLocalFleetMember(second);
    enrollFleetMember(fleet.fleetId, first);

    process.env.BOXERS_HOME = firstHome;
    process.env.BOXERS_AUTHORIZED_KEYS = join(firstHome, "authorized_keys");
    enrollFleetMember(fleet.fleetId, second);
    const manifest = decodeReleaseCapsule(capsule).manifest;
    createFleetReleaseIntent(manifest);
    const sourceState = acknowledgeFleetRelease();

    process.env.BOXERS_HOME = secondHome;
    process.env.BOXERS_AUTHORIZED_KEYS = join(secondHome, "authorized_keys");
    process.env.HOME = secondUserHome;
    process.env.XDG_DATA_HOME = secondData;
    process.env.PATH = `${bin}:${environment.path ?? ""}`;
    process.env.FAKE_CAPSULE = capsulePath;
    mergeFleetUpdateState(sourceState);

    await expect(reconcileFleetRelease()).resolves.toEqual({
      status: "updated",
    });
    expect(fleetReleaseIsAcknowledged(second.hostId, readFleetUpdateState())).toBe(true);
  });

  it("bootstraps and pushes to a legacy machine when it reconnects", async () => {
    const firstHome = directory("boxers-release-push-first-");
    const secondHome = directory("boxers-release-push-second-");
    const bin = directory("boxers-release-push-bin-");
    const marker = join(directory("boxers-release-push-marker-"), "bootstrapped");
    const resultPath = join(directory("boxers-release-push-result-"), "result.json");
    const log = join(directory("boxers-release-push-log-"), "calls.log");
    const capsule = createReleaseCapsule(packageFixture());

    process.env.BOXERS_HOME = firstHome;
    process.env.BOXERS_AUTHORIZED_KEYS = join(firstHome, "authorized_keys");
    const fleet = ensureFleet();
    const first = localFleetMember([{ transport: "ssh", target: "first" }]);
    updateLocalFleetMember(first);

    process.env.BOXERS_HOME = secondHome;
    process.env.BOXERS_AUTHORIZED_KEYS = join(secondHome, "authorized_keys");
    ensureFleet(fleet.fleetId);
    const second = localFleetMember([{ transport: "ssh", target: "legacy" }]);
    updateLocalFleetMember(second);
    enrollFleetMember(fleet.fleetId, first);

    process.env.BOXERS_HOME = firstHome;
    process.env.BOXERS_AUTHORIZED_KEYS = join(firstHome, "authorized_keys");
    enrollFleetMember(fleet.fleetId, second);
    const desired = createFleetReleaseIntent(decodeReleaseCapsule(capsule).manifest);
    const firstState = acknowledgeFleetRelease();
    installReleaseCapsule(capsule, false);

    process.env.BOXERS_HOME = secondHome;
    process.env.BOXERS_AUTHORIZED_KEYS = join(secondHome, "authorized_keys");
    mergeFleetUpdateState(desired);
    const secondState = acknowledgeFleetRelease();
    writeFileSync(
      resultPath,
      JSON.stringify({
        version: 1,
        hostId: second.hostId,
        buildId: desired.desired!.body.release.buildId,
        packageVersion: desired.desired!.body.release.packageVersion,
        runtimeInstalled: true,
        daemonHandoffRequired: false,
        update: secondState,
      }),
    );

    const ssh = join(bin, "ssh");
    writeFileSync(
      ssh,
      `#!/bin/sh
request=""
for value do request="$value"; done
args=$(node -e 'const value=JSON.parse(Buffer.from(process.argv[1], "base64url")); process.stdout.write(value.args.join(" "))' "$request")
printf '%s\n' "$args" >> "$FAKE_UPDATE_LOG"
case "$args" in
  "remote install-release "*)
    if [ ! -f "$FAKE_UPDATE_MARKER" ]; then
      printf '%s\n' 'The requested command is not available through the Boxers SSH gateway.' >&2
      exit 1
    fi
    cat "$FAKE_UPDATE_RESULT"
    ;;
  "remote update "*) touch "$FAKE_UPDATE_MARKER" ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(ssh, 0o755);

    process.env.BOXERS_HOME = firstHome;
    process.env.BOXERS_AUTHORIZED_KEYS = join(firstHome, "authorized_keys");
    process.env.PATH = `${bin}:${environment.path ?? ""}`;
    process.env.FAKE_UPDATE_MARKER = marker;
    process.env.FAKE_UPDATE_RESULT = resultPath;
    process.env.FAKE_UPDATE_LOG = log;
    mergeFleetUpdateState(firstState);

    await expect(reconcileFleetRelease()).resolves.toEqual({ status: "current" });
    const calls = readFileSync(log, "utf8");
    expect(calls.match(/remote install-release/g)).toHaveLength(2);
    expect(calls).toContain("remote update ");
    expect(fleetReleaseIsAcknowledged(second.hostId)).toBe(true);
  });
});
