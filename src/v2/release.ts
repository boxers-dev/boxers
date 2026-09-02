import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, arch } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { command, requireSuccess } from "./process.ts";

const CAPSULE_MAGIC = "boxers-release-v1\n";
const MAX_CAPSULE_BYTES = 64 * 1024 * 1024;
const RELEASE_FILE = /^[a-zA-Z0-9._/-]+$/;

export interface ReleaseManifest {
  version: 1;
  packageName: string;
  packageVersion: string;
  buildId: string;
  runtimeHash: string;
  dependencies: Record<string, string>;
  files: { path: string; size: number; sha256: string; executable: boolean }[];
}

interface EncodedRelease {
  version: 1;
  manifest: ReleaseManifest;
  files: Record<string, string>;
}

export interface InstalledRelease {
  manifest: ReleaseManifest;
  executable: string;
  stableExecutable: string;
  runtimeInstalled: boolean;
  previousExecutable?: string | undefined;
}

interface ReleaseActivation {
  version: 1;
  currentBuildId: string;
  currentExecutable: string;
  previousExecutable?: string;
  updatedAt: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalDependencies(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The Boxers package has invalid runtime dependencies.");
  const dependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!name || typeof version !== "string" || !version)
      throw new Error("The Boxers package has invalid runtime dependencies.");
    dependencies[name] = version;
  }
  return dependencies;
}

function packageRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  for (let directory = start, previous = ""; directory !== previous; ) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      try {
        const value = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
        if (value.name === "@boxers-dev/boxers") return directory;
      } catch {
        // Keep looking for the owning package.
      }
    }
    previous = directory;
    directory = dirname(directory);
  }
  throw new Error("Could not locate the active Boxers package.");
}

function releaseFiles(root: string): string[] {
  const dist = join(root, "dist");
  const source = join(root, "src", "index.ts");
  if (existsSync(source)) {
    process.stdout.write("Building the local Boxers development checkout…\n");
    requireSuccess(command("npm", ["run", "build"], { cwd: root }), "Could not build Boxers");
  } else if (!existsSync(dist)) throw new Error("The active Boxers package has no dist directory.");
  const files = ["package.json"];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
    }
  };
  visit(dist);
  return files.sort();
}

function validateReleasePath(path: string): void {
  if (
    !RELEASE_FILE.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    (path !== "package.json" && !path.startsWith("dist/"))
  )
    throw new Error(`Invalid Boxers release path ${JSON.stringify(path)}.`);
}

function manifestIdentity(manifest: Omit<ReleaseManifest, "buildId">): string {
  return sha256(JSON.stringify(manifest));
}

export function createReleaseCapsule(root = packageRoot()): Buffer {
  const packageValue = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
    dependencies?: unknown;
  };
  if (typeof packageValue.name !== "string" || typeof packageValue.version !== "string")
    throw new Error("The active Boxers package metadata is invalid.");
  const dependencies = canonicalDependencies(packageValue.dependencies);
  const runtimeHash = sha256(JSON.stringify(dependencies));
  const encodedFiles: Record<string, string> = {};
  const files = releaseFiles(root).map((path) => {
    validateReleasePath(path);
    const contents = readFileSync(join(root, ...path.split("/")));
    encodedFiles[path] = contents.toString("base64");
    return {
      path,
      size: contents.length,
      sha256: sha256(contents),
      executable: path === "dist/index.mjs",
    };
  });
  const unsigned = {
    version: 1 as const,
    packageName: packageValue.name,
    packageVersion: packageValue.version,
    runtimeHash,
    dependencies,
    files,
  };
  const manifest: ReleaseManifest = { ...unsigned, buildId: manifestIdentity(unsigned) };
  const compressed = gzipSync(
    Buffer.from(
      JSON.stringify({ version: 1, manifest, files: encodedFiles } satisfies EncodedRelease),
    ),
  );
  const capsule = Buffer.concat([Buffer.from(CAPSULE_MAGIC), compressed]);
  if (capsule.length > MAX_CAPSULE_BYTES)
    throw new Error(`The Boxers release capsule exceeds ${MAX_CAPSULE_BYTES} bytes.`);
  return capsule;
}

export function decodeReleaseCapsule(capsule: Buffer): EncodedRelease {
  if (capsule.length > MAX_CAPSULE_BYTES)
    throw new Error(`The Boxers release capsule exceeds ${MAX_CAPSULE_BYTES} bytes.`);
  const magic = Buffer.from(CAPSULE_MAGIC);
  if (capsule.length <= magic.length || !capsule.subarray(0, magic.length).equals(magic))
    throw new Error("Invalid Boxers release capsule.");
  let value: EncodedRelease;
  try {
    value = JSON.parse(
      gunzipSync(capsule.subarray(magic.length), {
        maxOutputLength: MAX_CAPSULE_BYTES * 2,
      }).toString("utf8"),
    ) as EncodedRelease;
  } catch {
    throw new Error("Invalid Boxers release capsule.");
  }
  const manifest = value?.manifest;
  if (
    value?.version !== 1 ||
    manifest?.version !== 1 ||
    typeof manifest.packageName !== "string" ||
    typeof manifest.packageVersion !== "string" ||
    typeof manifest.buildId !== "string" ||
    typeof manifest.runtimeHash !== "string" ||
    !Array.isArray(manifest.files) ||
    !value.files ||
    typeof value.files !== "object"
  )
    throw new Error("Invalid Boxers release manifest.");
  const dependencies = canonicalDependencies(manifest.dependencies);
  if (sha256(JSON.stringify(dependencies)) !== manifest.runtimeHash)
    throw new Error("Boxers release runtime hash does not match its dependencies.");
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      typeof file.executable !== "boolean"
    )
      throw new Error("Invalid Boxers release file manifest.");
    validateReleasePath(file.path);
    if (paths.has(file.path)) throw new Error(`Duplicate Boxers release path ${file.path}.`);
    paths.add(file.path);
    const encoded = value.files[file.path];
    if (typeof encoded !== "string") throw new Error(`Missing Boxers release file ${file.path}.`);
    const contents = Buffer.from(encoded, "base64");
    if (contents.length !== file.size || sha256(contents) !== file.sha256)
      throw new Error(`Boxers release file ${file.path} failed verification.`);
  }
  if (Object.keys(value.files).some((path) => !paths.has(path)))
    throw new Error("The Boxers release capsule contains undeclared files.");
  const { buildId: _buildId, ...unsigned } = manifest;
  if (manifestIdentity(unsigned) !== manifest.buildId)
    throw new Error("Boxers release build hash does not match its manifest.");
  return { ...value, manifest: { ...manifest, dependencies } };
}

export function managedDataRoot(): string {
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", "boxers", "managed");
  if (platform() === "win32")
    return join(
      process.env["LOCALAPPDATA"] ?? process.env["APPDATA"] ?? homedir(),
      "Boxers",
      "managed",
    );
  return join(
    process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
    "boxers",
    "managed",
  );
}

export function stableExecutablePath(): string {
  return join(homedir(), ".local", "bin", "boxers");
}

/** Return the stable launcher only when it resolves to the activated managed release. */
export function activeManagedExecutable(): string | undefined {
  try {
    const activation = readJsonActivation();
    const stable = stableExecutablePath();
    return realpathSync(stable) === realpathSync(activation.currentExecutable) ? stable : undefined;
  } catch {
    return undefined;
  }
}

/** Return the build selected by the host-wide managed launcher. */
export function activeManagedBuildId(): string | undefined {
  try {
    return readJsonActivation().currentBuildId;
  } catch {
    return undefined;
  }
}

function activationPath(): string {
  return join(managedDataRoot(), "activation.json");
}

function writeActivation(value: ReleaseActivation): void {
  const path = activationPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function releaseRuntimeIdentity(
  manifest: ReleaseManifest,
  target: { platform: string; architecture: string; nodeModulesAbi: string } = {
    platform: platform(),
    architecture: arch(),
    nodeModulesAbi: process.versions.modules,
  },
): string {
  return `${manifest.runtimeHash}-${target.platform}-${target.architecture}-abi${target.nodeModulesAbi}`;
}

function installRuntime(manifest: ReleaseManifest, runtimeRoot: string): boolean {
  const marker = join(runtimeRoot, "runtime.json");
  if (existsSync(marker)) return false;
  const temporary = `${runtimeRoot}.${process.pid}.tmp`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(temporary, "package.json"),
    `${JSON.stringify({ private: true, dependencies: manifest.dependencies }, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (Object.keys(manifest.dependencies).length)
    requireSuccess(
      command("npm", ["install", "--no-audit", "--no-fund", "--omit=dev", "--package-lock=false"], {
        cwd: temporary,
      }),
      `Could not install the Boxers runtime for ${platform()} ${arch()}`,
    );
  writeFileSync(
    join(temporary, "runtime.json"),
    `${JSON.stringify({
      version: 1,
      runtimeHash: manifest.runtimeHash,
      platform: platform(),
      architecture: arch(),
      nodeModulesAbi: process.versions.modules,
    })}\n`,
    { mode: 0o600 },
  );
  mkdirSync(dirname(runtimeRoot), { recursive: true, mode: 0o700 });
  try {
    renameSync(temporary, runtimeRoot);
  } catch (error) {
    if (!existsSync(marker)) throw error;
    rmSync(temporary, { recursive: true, force: true });
  }
  return true;
}

function writeRelease(decoded: EncodedRelease, releaseRoot: string): void {
  if (existsSync(join(releaseRoot, "release.json"))) return;
  const temporary = `${releaseRoot}.${process.pid}.tmp`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  for (const file of decoded.manifest.files) {
    const destination = resolve(temporary, ...file.path.split("/"));
    if (!destination.startsWith(`${resolve(temporary)}${sep}`))
      throw new Error(`Invalid Boxers release path ${file.path}.`);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, Buffer.from(decoded.files[file.path]!, "base64"), {
      mode: file.executable ? 0o755 : 0o600,
    });
  }
  writeFileSync(join(temporary, "release.json"), `${JSON.stringify(decoded.manifest)}\n`, {
    mode: 0o600,
  });
  mkdirSync(dirname(releaseRoot), { recursive: true, mode: 0o700 });
  try {
    renameSync(temporary, releaseRoot);
  } catch (error) {
    if (!existsSync(join(releaseRoot, "release.json"))) throw error;
    rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyInstalledRelease(decoded: EncodedRelease, releaseRoot: string): void {
  for (const file of decoded.manifest.files) {
    const path = join(releaseRoot, ...file.path.split("/"));
    if (!existsSync(path)) throw new Error(`Installed Boxers release is missing ${file.path}.`);
    const contents = readFileSync(path);
    if (contents.length !== file.size || sha256(contents) !== file.sha256)
      throw new Error(`Installed Boxers release file ${file.path} failed verification.`);
  }
}

export function installReleaseCapsule(capsule: Buffer, activate = true): InstalledRelease {
  const decoded = decodeReleaseCapsule(capsule);
  const root = managedDataRoot();
  const runtimeRoot = join(root, "runtimes", releaseRuntimeIdentity(decoded.manifest));
  const runtimeInstalled = installRuntime(decoded.manifest, runtimeRoot);
  const releaseRoot = join(runtimeRoot, "releases", decoded.manifest.buildId);
  writeRelease(decoded, releaseRoot);
  verifyInstalledRelease(decoded, releaseRoot);
  const executable = join(releaseRoot, "dist", "index.mjs");
  if (!existsSync(executable))
    throw new Error("The Boxers release has no dist/index.mjs executable.");
  chmodSync(executable, 0o755);
  const reported = requireSuccess(
    command(executable, ["--version"]),
    "Could not validate Boxers",
  ).trim();
  if (reported !== decoded.manifest.packageVersion)
    throw new Error(
      `Installed Boxers reported ${reported || "no version"}, expected ${decoded.manifest.packageVersion}.`,
    );
  const cacheDirectory = join(root, "capsules");
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const cachePath = join(cacheDirectory, `${decoded.manifest.buildId}.bxr`);
  if (!existsSync(cachePath)) writeFileSync(cachePath, capsule, { mode: 0o600 });
  const stableExecutable = stableExecutablePath();
  let previousExecutable: string | undefined;
  if (activate) {
    try {
      const target = readlinkSync(stableExecutable);
      previousExecutable = isAbsolute(target) ? target : resolve(dirname(stableExecutable), target);
    } catch {
      // There may not be a previous managed installation.
    }
    mkdirSync(dirname(stableExecutable), { recursive: true, mode: 0o700 });
    const temporary = join(
      dirname(stableExecutable),
      `.${basename(stableExecutable)}.${process.pid}.tmp`,
    );
    rmSync(temporary, { force: true });
    symlinkSync(executable, temporary);
    renameSync(temporary, stableExecutable);
    let retainedPrevious = previousExecutable;
    if (previousExecutable === executable) {
      try {
        retainedPrevious = readJsonActivation().previousExecutable;
      } catch {
        retainedPrevious = undefined;
      }
    }
    writeActivation({
      version: 1,
      currentBuildId: decoded.manifest.buildId,
      currentExecutable: executable,
      ...(retainedPrevious ? { previousExecutable: retainedPrevious } : {}),
      updatedAt: new Date().toISOString(),
    });
  }
  return {
    manifest: decoded.manifest,
    executable,
    stableExecutable,
    runtimeInstalled,
    ...(previousExecutable ? { previousExecutable } : {}),
  };
}

function readJsonActivation(): ReleaseActivation {
  const value = JSON.parse(readFileSync(activationPath(), "utf8")) as ReleaseActivation;
  if (
    value?.version !== 1 ||
    typeof value.currentBuildId !== "string" ||
    typeof value.currentExecutable !== "string" ||
    (value.previousExecutable !== undefined && typeof value.previousExecutable !== "string")
  )
    throw new Error("Invalid Boxers release activation state.");
  return value;
}

export function rollbackManagedRelease(failedBuildId: string): boolean {
  let activation: ReleaseActivation;
  try {
    activation = readJsonActivation();
  } catch {
    return false;
  }
  const previous = activation.previousExecutable;
  if (
    activation.currentBuildId !== failedBuildId ||
    !previous ||
    previous === activation.currentExecutable ||
    !existsSync(previous)
  )
    return false;
  const stable = stableExecutablePath();
  const temporary = join(dirname(stable), `.${basename(stable)}.${process.pid}.rollback`);
  rmSync(temporary, { force: true });
  symlinkSync(previous, temporary);
  renameSync(temporary, stable);
  const previousBuildId = activeReleaseBuildId(dirname(dirname(previous))) ?? "unknown";
  writeActivation({
    version: 1,
    currentBuildId: previousBuildId,
    currentExecutable: previous,
    previousExecutable: activation.currentExecutable,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export function cachedReleaseCapsule(buildId: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(buildId)) throw new Error("Invalid Boxers release build ID.");
  const path = join(managedDataRoot(), "capsules", `${buildId}.bxr`);
  if (!existsSync(path)) throw new Error(`Boxers release ${buildId} is not cached on this host.`);
  const capsule = readFileSync(path);
  if (decodeReleaseCapsule(capsule).manifest.buildId !== buildId)
    throw new Error(`Cached Boxers release ${buildId} failed verification.`);
  return capsule;
}

export function activeReleaseBuildId(root = packageRoot()): string | undefined {
  const path = join(root, "release.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { buildId?: unknown };
    return typeof value.buildId === "string" ? value.buildId : undefined;
  } catch {
    return undefined;
  }
}
