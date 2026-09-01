import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withPidFileLock } from "./lock.ts";
import {
  atomicWriteText,
  authorizedKeysLockPath,
  managedSshDir,
  managedSshLockPath,
  managedSshPrivateKeyPath,
  managedSshPublicKeyPath,
} from "./paths.ts";
import { command } from "./process.ts";
import { localMachineIdentity } from "./registry.ts";
import type { FleetMember, FleetRemoval } from "./types.ts";

export interface ManagedSshIdentity {
  privateKeyPath: string;
  publicKey: string;
  fingerprint: string;
}

interface PeerAuthorizationPayload {
  version: 1;
  hostId: string;
  publicKey: string;
}

const HOST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const EXECUTABLE = /^[a-zA-Z0-9_./+-]+$/;

export function canonicalSshPublicKey(value: string, comment?: string): string {
  const fields = value.trim().split(/\s+/);
  if (fields.length < 2 || fields[0] !== "ssh-ed25519")
    throw new Error("Boxers managed SSH keys must be Ed25519 public keys.");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(fields[1]!, "base64");
  } catch {
    throw new Error("Boxers managed SSH public key is not valid base64.");
  }
  if (
    !bytes.length ||
    bytes.toString("base64").replace(/=+$/, "") !== fields[1]!.replace(/=+$/, "")
  )
    throw new Error("Boxers managed SSH public key is not valid base64.");
  if (
    bytes.length !== 51 ||
    bytes.readUInt32BE(0) !== 11 ||
    bytes.subarray(4, 15).toString("ascii") !== "ssh-ed25519" ||
    bytes.readUInt32BE(15) !== 32
  )
    throw new Error("Boxers managed SSH public key is not a valid Ed25519 key.");
  return `ssh-ed25519 ${fields[1]}${comment ? ` ${comment}` : ""}`;
}

export function sshPublicKeyFingerprint(value: string): string {
  const canonical = canonicalSshPublicKey(value);
  const bytes = Buffer.from(canonical.split(" ")[1]!, "base64");
  return `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
}

function readManagedIdentity(): ManagedSshIdentity {
  const publicKey = canonicalSshPublicKey(
    readFileSync(managedSshPublicKeyPath(), "utf8"),
    `boxers:${localMachineIdentity().id}`,
  );
  chmodSync(managedSshPrivateKeyPath(), 0o600);
  chmodSync(managedSshPublicKeyPath(), 0o600);
  return {
    privateKeyPath: managedSshPrivateKeyPath(),
    publicKey,
    fingerprint: sshPublicKeyFingerprint(publicKey),
  };
}

export function ensureManagedSshIdentity(): ManagedSshIdentity {
  if (existsSync(managedSshPrivateKeyPath()) && existsSync(managedSshPublicKeyPath()))
    return readManagedIdentity();
  return withPidFileLock(managedSshLockPath(), () => {
    if (existsSync(managedSshPrivateKeyPath()) && existsSync(managedSshPublicKeyPath()))
      return readManagedIdentity();
    mkdirSync(managedSshDir(), { recursive: true, mode: 0o700 });
    chmodSync(managedSshDir(), 0o700);
    const temporary = join(managedSshDir(), `.id_ed25519.${process.pid}.${randomUUID()}`);
    try {
      const result = command("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        `boxers:${localMachineIdentity().id}`,
        "-f",
        temporary,
      ]);
      if (result.status !== 0)
        throw new Error(
          `Could not generate the Boxers SSH identity: ${(result.stderr || result.stdout).trim() || `ssh-keygen exited ${result.status}`}`,
        );
      chmodSync(temporary, 0o600);
      chmodSync(`${temporary}.pub`, 0o600);
      renameSync(temporary, managedSshPrivateKeyPath());
      renameSync(`${temporary}.pub`, managedSshPublicKeyPath());
      return readManagedIdentity();
    } finally {
      rmSync(temporary, { force: true });
      rmSync(`${temporary}.pub`, { force: true });
    }
  });
}

function authorizedKeysPath(): string {
  return process.env["BOXERS_AUTHORIZED_KEYS"] ?? join(homedir(), ".ssh", "authorized_keys");
}

function marker(hostId: string): string {
  return `# boxers-managed ${hostId}`;
}

function withoutManagedEntry(text: string, hostId: string): string[] {
  const lines = text.split("\n");
  const result: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] === marker(hostId)) {
      index++;
      continue;
    }
    result.push(lines[index]!);
  }
  while (result.at(-1) === "") result.pop();
  return result;
}

function assertSafeAuthorizedKeys(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`Refusing to modify non-regular SSH authorization file ${path}.`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error(`Refusing to modify SSH authorization file not owned by this user: ${path}.`);
}

export function authorizeManagedPeer(hostId: string, publicKey: string, executable: string): void {
  if (!HOST_ID.test(hostId)) throw new Error("Invalid managed SSH peer host ID.");
  if (!EXECUTABLE.test(executable)) throw new Error("Invalid Boxers gateway executable path.");
  const path = authorizedKeysPath();
  withPidFileLock(authorizedKeysLockPath(), () => {
    assertSafeAuthorizedKeys(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
    const lines = withoutManagedEntry(previous, hostId);
    const key = canonicalSshPublicKey(publicKey, `boxers:${hostId}`);
    lines.push(
      marker(hostId),
      `command="${executable} remote gateway ${hostId}",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc ${key}`,
    );
    atomicWriteText(path, `${lines.join("\n")}\n`, 0o600);
  });
}

export function revokeManagedPeer(hostId: string): void {
  if (!HOST_ID.test(hostId)) throw new Error("Invalid managed SSH peer host ID.");
  const path = authorizedKeysPath();
  withPidFileLock(authorizedKeysLockPath(), () => {
    assertSafeAuthorizedKeys(path);
    if (!existsSync(path)) return;
    const lines = withoutManagedEntry(readFileSync(path, "utf8"), hostId);
    atomicWriteText(path, lines.length ? `${lines.join("\n")}\n` : "", 0o600);
  });
}

export function encodePeerAuthorization(hostId: string, publicKey: string): string {
  if (!HOST_ID.test(hostId)) throw new Error("Invalid managed SSH peer host ID.");
  const payload: PeerAuthorizationPayload = {
    version: 1,
    hostId,
    publicKey: canonicalSshPublicKey(publicKey, `boxers:${hostId}`),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function acceptPeerAuthorization(encoded: string): void {
  let payload: PeerAuthorizationPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as PeerAuthorizationPayload;
  } catch {
    throw new Error("Invalid managed SSH peer authorization.");
  }
  if (
    payload?.version !== 1 ||
    !HOST_ID.test(payload.hostId) ||
    typeof payload.publicKey !== "string"
  )
    throw new Error("Invalid managed SSH peer authorization.");
  const executable = process.env["BOXERS_EXECUTABLE"] ?? process.argv[1] ?? "boxers";
  authorizeManagedPeer(payload.hostId, payload.publicKey, executable);
}

export function reconcileManagedPeerAuthorizations(
  members: readonly FleetMember[],
  removedMembers: readonly FleetRemoval[],
): void {
  const localId = localMachineIdentity().id;
  const executable = process.env["BOXERS_EXECUTABLE"] ?? process.argv[1] ?? "boxers";
  for (const member of members) {
    if (member.hostId !== localId)
      authorizeManagedPeer(member.hostId, member.ssh.publicKey, executable);
  }
  for (const removal of removedMembers) {
    if (removal.hostId !== localId) revokeManagedPeer(removal.hostId);
  }
}
