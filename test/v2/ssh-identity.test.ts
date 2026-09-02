import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enrollFleetMember, ensureFleet } from "../../src/v2/fleet.ts";
import {
  authorizeManagedPeer,
  canonicalSshPublicKey,
  ensureManagedSshIdentity,
  revokeManagedPeer,
} from "../../src/v2/ssh-identity.ts";
import {
  authorizeGatewayRequest,
  decodeGatewayRequest,
  encodeGatewayRequest,
  managedSshArgs,
} from "../../src/v2/ssh-transport.ts";

const cleanup: string[] = [];
const originalHome = process.env.BOXERS_HOME;
const originalAuthorizedKeys = process.env.BOXERS_AUTHORIZED_KEYS;

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = originalHome;
  if (originalAuthorizedKeys === undefined) delete process.env.BOXERS_AUTHORIZED_KEYS;
  else process.env.BOXERS_AUTHORIZED_KEYS = originalAuthorizedKeys;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("managed Boxers SSH identity", () => {
  it("creates one unattended Ed25519 identity with restricted permissions", () => {
    process.env.BOXERS_HOME = directory("boxers-ssh-identity-");
    const first = ensureManagedSshIdentity();
    const second = ensureManagedSshIdentity();

    expect(second).toEqual(first);
    expect(first.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ boxers:/);
    expect(first.fingerprint).toMatch(/^SHA256:/);
    expect(statSync(first.privateKeyPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(process.env.BOXERS_HOME, "ssh")).mode & 0o777).toBe(0o700);
  });

  it("preserves unrelated authorizations and replaces only the named Boxers peer", () => {
    const localHome = directory("boxers-ssh-authorize-");
    const peerHome = directory("boxers-ssh-peer-");
    const authorizedKeys = join(localHome, "authorized_keys");
    process.env.BOXERS_AUTHORIZED_KEYS = authorizedKeys;
    mkdirSync(localHome, { recursive: true });
    writeFileSync(authorizedKeys, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther personal\n");

    process.env.BOXERS_HOME = peerHome;
    const peer = ensureManagedSshIdentity();
    process.env.BOXERS_HOME = localHome;
    authorizeManagedPeer("peer-id", peer.publicKey, "/opt/boxers/bin/boxers");
    authorizeManagedPeer("peer-id", peer.publicKey, "/opt/boxers/bin/boxers");

    const installed = readFileSync(authorizedKeys, "utf8");
    expect(installed).toContain("Other personal");
    expect(installed.match(/# boxers-managed peer-id/g)).toHaveLength(1);
    expect(installed).toContain('command="/opt/boxers/bin/boxers remote gateway peer-id"');
    expect(installed).toContain(
      "no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc",
    );

    revokeManagedPeer("peer-id");
    expect(readFileSync(authorizedKeys, "utf8")).toBe(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther personal\n",
    );
  });
});

describe("managed Boxers SSH gateway", () => {
  it("round-trips argv without shell interpretation and rejects command suffixes", () => {
    const args = ["task name", "status", "$(touch /tmp/not-run)"];
    const encoded = encodeGatewayRequest(args);
    expect(decodeGatewayRequest(`boxers-gateway-request ${encoded}`)).toEqual(args);
    expect(() => decodeGatewayRequest(`boxers-gateway-request ${encoded}; whoami`)).toThrow(
      "gateway protocol",
    );
  });

  it("enforces observe-only access before dispatch", () => {
    process.env.BOXERS_HOME = directory("boxers-ssh-gateway-");
    const fleet = ensureFleet();
    const managedSsh = ensureManagedSshIdentity();
    enrollFleetMember(fleet.fleetId, {
      hostId: "observer-id",
      name: "observer",
      publicKey: "observer-signing-key",
      ssh: {
        version: 1,
        publicKey: canonicalSshPublicKey(managedSsh.publicKey, "boxers:observer-id"),
        fingerprint: managedSsh.fingerprint,
      },
      endpoints: [{ transport: "ssh", target: "observer" }],
      roles: ["observe"],
      enrolledAt: new Date().toISOString(),
    });

    expect(() => authorizeGatewayRequest("observer-id", ["remote", "snapshot"])).not.toThrow();
    expect(() => authorizeGatewayRequest("observer-id", ["task", "review"])).not.toThrow();
    expect(() =>
      authorizeGatewayRequest("observer-id", ["remote", "unenroll", "observer-id"]),
    ).not.toThrow();
    expect(() =>
      authorizeGatewayRequest("observer-id", ["remote", "unenroll", "another-id"]),
    ).toThrow("required admin");
    expect(() => authorizeGatewayRequest("observer-id", ["task", "attach"])).toThrow(
      "required operate",
    );
    expect(() => authorizeGatewayRequest("observer-id", ["service", "install"])).toThrow(
      "required admin",
    );
    expect(() =>
      authorizeGatewayRequest("observer-id", [
        "__remote-new-project",
        "project",
        "task",
        "source",
        "main",
      ]),
    ).toThrow("required admin");
    expect(() => authorizeGatewayRequest("observer-id", ["bash", "-lc", "whoami"])).toThrow(
      "not available",
    );
    expect(() => authorizeGatewayRequest("unknown", ["remote", "snapshot"])).toThrow(
      "not enrolled",
    );
  });

  it("always selects the managed identity and sends only an encoded gateway request", () => {
    process.env.BOXERS_HOME = directory("boxers-ssh-args-");
    const args = managedSshArgs("peer", ["remote", "snapshot"], {
      tty: true,
      acceptNewHostKey: true,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "-t",
        "BatchMode=yes",
        "IdentitiesOnly=yes",
        "StrictHostKeyChecking=accept-new",
        "boxers-gateway-request",
      ]),
    );
    expect(args).not.toContain("snapshot");
    expect(args[args.indexOf("-i") + 1]).toContain("/ssh/id_ed25519");
  });
});
