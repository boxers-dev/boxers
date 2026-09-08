import { captureSsh } from "./ssh-transport.ts";

/**
 * Stage the trusted release supplied over normal, user-authenticated SSH. This
 * loader only makes the new CLI runnable; that CLI owns validation, installation,
 * service configuration, and daemon replacement through activateHostRelease.
 * Never expose this shell bootstrap through the managed peer gateway.
 */
export function releaseBootstrapScript(): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const cp = require("node:child_process");
if (Number(process.versions.node.split(".")[0]) < 20) throw Error("Node.js 20 or newer is required.");
const capsule = fs.readFileSync(0);
const magic = Buffer.from("boxers-release-v1\\n");
if (capsule.length > 64 * 1024 * 1024 || !capsule.subarray(0, magic.length).equals(magic)) throw Error("Invalid Boxers release capsule.");
const decoded = JSON.parse(zlib.gunzipSync(capsule.subarray(magic.length), { maxOutputLength: 256 * 1024 * 1024 }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "boxers-bootstrap-"));
try {
  for (const [name, contents] of Object.entries(decoded.files)) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.split("/").some(part => !part || part === "." || part === "..") || (name !== "package.json" && !name.startsWith("dist/"))) throw Error("Invalid Boxers release path.");
    const destination = path.join(root, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, Buffer.from(contents, "base64"), { mode: 0o600 });
  }
  // The capsule's package metadata is trusted code, just like its executable.
  const installed = cp.spawnSync("npm", ["install", "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts", "--package-lock=false"], { cwd: root, stdio: ["ignore", 2, 2] });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) throw Error("Could not stage the Boxers release dependencies.");
  const activated = cp.spawnSync(process.execPath, [path.join(root, "dist/index.mjs"), "__activate-release"], { input: capsule, stdio: ["pipe", "inherit", "inherit"] });
  if (activated.error) throw activated.error;
  process.exitCode = activated.status ?? 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
`;
}

export function bootstrapHostRelease(host: string, capsule: Buffer): Promise<string> {
  const script = `'${releaseBootstrapScript().replaceAll("'", `'"'"'`)}'`;
  return captureSsh(host, ["node", "-e", script], {
    managed: false,
    input: capsule,
    timeout: 5 * 60_000,
    streamStderr: true,
    description: "Installing the Boxers build",
  });
}
