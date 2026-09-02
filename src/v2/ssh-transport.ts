import { spawnSync } from "node:child_process";
import { readFleet } from "./fleet.ts";
import { ensureManagedSshIdentity } from "./ssh-identity.ts";
import type { PeerRole } from "./types.ts";

interface GatewayRequest {
  version: 1;
  args: string[];
}

export function encodeGatewayRequest(args: readonly string[]): string {
  if (args.some((value) => typeof value !== "string" || value.includes("\0")))
    throw new Error("Invalid Boxers SSH gateway argument.");
  return Buffer.from(JSON.stringify({ version: 1, args }), "utf8").toString("base64url");
}

export function decodeGatewayRequest(command: string | undefined): string[] {
  const match = /^boxers-gateway-request ([a-zA-Z0-9_-]+)$/.exec(command ?? "");
  if (!match) throw new Error("Managed SSH connections must use the Boxers gateway protocol.");
  let request: GatewayRequest;
  try {
    request = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as GatewayRequest;
  } catch {
    throw new Error("Invalid Boxers SSH gateway request.");
  }
  if (
    request?.version !== 1 ||
    !Array.isArray(request.args) ||
    request.args.some((value) => typeof value !== "string" || value.includes("\0"))
  )
    throw new Error("Invalid Boxers SSH gateway request.");
  return request.args;
}

function requiredRole(args: readonly string[]): PeerRole {
  if (args[0] === "remote") {
    if (args[1] === "snapshot" || args[1] === "watch") return "observe";
    return "admin";
  }
  if (args[0] === "doctor" || args[0] === "status" || args[0] === "list") return "observe";
  if (args[0] === "auth" && args[1] === "status") return "observe";
  if (
    args[0] === "auth" ||
    args[0] === "connect" ||
    args[0] === "daemon" ||
    args[0] === "debug" ||
    args[0] === "disconnect" ||
    args[0] === "hosts" ||
    args[0] === "project" ||
    args[0] === "service" ||
    args[0] === "update"
  )
    return "admin";
  if (args[0] === "__remote-project-clone") return "admin";
  if (args[0] === "__remote-new-project") return "admin";
  if (args[0] === "__remote-new") return "operate";
  const taskCommand = args[1];
  if (taskCommand === "status" || taskCommand === "review") return "observe";
  if (
    taskCommand === "preview" &&
    (args[2] === undefined || args[2] === "show" || args[2] === "logs")
  )
    return "observe";
  if (taskCommand === "promote" || taskCommand === "discard") return "admin";
  if (
    taskCommand === "attach" ||
    taskCommand === "check" ||
    taskCommand === "setup" ||
    taskCommand === "sync" ||
    taskCommand === "preview"
  )
    return "operate";
  throw new Error("The requested command is not available through the Boxers SSH gateway.");
}

export function authorizeGatewayRequest(hostId: string, args: readonly string[]): void {
  const member = readFleet()?.members.find((candidate) => candidate.hostId === hostId);
  if (!member) throw new Error("The SSH requester is not enrolled in this Boxers fleet.");
  const role =
    args[0] === "remote" && args[1] === "unenroll" && args[2] === hostId
      ? "observe"
      : requiredRole(args);
  const allowed =
    member.roles.includes("admin") ||
    member.roles.includes(role) ||
    (role === "observe" && member.roles.includes("operate"));
  if (!allowed) throw new Error(`The SSH requester does not have the required ${role} fleet role.`);
}

export function runSshGateway(hostId: string): number {
  const args = decodeGatewayRequest(process.env["SSH_ORIGINAL_COMMAND"]);
  authorizeGatewayRequest(hostId, args);
  const executable = process.env["BOXERS_EXECUTABLE"] ?? process.argv[1] ?? "boxers";
  return spawnSync(executable, args, { stdio: "inherit", env: process.env }).status ?? 1;
}

export function managedSshArgs(
  host: string,
  args: readonly string[],
  options: { tty?: boolean; connectTimeout?: number; acceptNewHostKey?: boolean } = {},
): string[] {
  const identity = ensureManagedSshIdentity();
  return [
    ...(options.tty ? ["-t"] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${options.connectTimeout ?? 8}`,
    "-o",
    "IdentitiesOnly=yes",
    "-i",
    identity.privateKeyPath,
    ...(options.acceptNewHostKey ? ["-o", "StrictHostKeyChecking=accept-new"] : []),
    "--",
    host,
    "boxers-gateway-request",
    encodeGatewayRequest(args),
  ];
}
