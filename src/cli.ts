import { readFileSync } from "node:fs";
import {
  attach,
  authenticate,
  check as checkTask,
  cloneAndInitializeProject,
  doctor,
  initialize,
  list,
  promote,
  newTask,
  newTaskInProject,
  preview,
  printDoctor,
  projectStatus,
  discard,
  review as reviewTask,
  debugShell,
  status as taskStatus,
  sync,
} from "./v2/commands.ts";
import {
  runDaemonIntentWorker,
  runDaemonSettlementWorker,
  runDaemonLifecycleWorker,
} from "./v2/daemon-worker.ts";
import { readVersion } from "./core/version.ts";
import {
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
  runDaemonForeground,
} from "./v2/daemon-commands.ts";
import { runSetupWorker } from "./v2/setup.ts";
import { isAgent, type Agent, type IntegrationMode } from "./v2/types.ts";
import {
  remoteSnapshot,
  remoteWatch,
  runRemoteCommand,
  runRemoteTaskCommand,
} from "./v2/machines.ts";
import { projectCloneSource, requireProject } from "./v2/registry.ts";
import {
  acceptEnrollment,
  acceptFleetSync,
  acceptUnenrollment,
  connectHost,
  disconnectHost,
  remoteIdentity,
  verifyEnrolledPeer,
} from "./v2/fleet-connect.ts";
import {
  acceptPeerAuthorization,
  ensureManagedSshIdentity,
  revokeManagedPeer,
} from "./v2/ssh-identity.ts";
import { runSshGateway } from "./v2/ssh-transport.ts";
import { readFleet } from "./v2/fleet.ts";
import { acceptManagedUpdate, doctorFleet, updateFleet } from "./v2/fleet-admin.ts";
import {
  daemonServiceStatus,
  installDaemonService,
  resolveBoxersExecutable,
} from "./v2/service.ts";
import { showAuthenticationStatus, showFleetStatus } from "./v2/fleet-status.ts";
import { initializeMachine } from "./v2/machine-init.ts";
import { listTemplates } from "./v2/templates.ts";

const USAGE = `boxers — durable task orchestration

General
  boxers init
  boxers doctor [--agent codex|claude] [--host <host>|--all] [--json]
      [--acknowledge-open-network]
  boxers status [--host <host>] [--refresh] [--json]
  boxers update (--host <host>|--all) [--to <version>]

Auth
  boxers auth claude
  boxers auth codex [--oauth|--api-key]
  boxers auth status [--host <host>|--all] [--refresh] [--json]

Project
  boxers project status [--json]
  boxers project init [--integration local|remote] [--base <branch>]
      [--remote <name-or-url>]
      [--agent codex|claude] [--model <name>] [--effort <level>] [--fast|--no-fast]
      [--checks|--no-checks] [--preview|--no-preview]
      [--preview-command <command> --preview-port <port>...] [-y]
  boxers project add <machine> --clone --into <absolute-path>

Fleet
  boxers connect <ssh-target> [--name <name>] [--reverse-host <target>]
      [--no-install] [--observe-only]
  boxers hosts
  boxers disconnect <name-or-id>

Tasks
  boxers list [--json]  # local and registered remote tasks
  boxers list templates [--json]

  boxers <task> new [--agent codex|claude] [--prompt <text> | --prompt-file <path>]
      [--template <name-or-image>] [--model <name>] [--effort <level>]
      [--fast|--no-fast]
      [-d, --detach]

  # Prefix an existing task with <machine>/ to run the command remotely.
  boxers [<machine>/]<task> attach [--model <name>] [--effort <level>] [--fast]
  boxers [<machine>/]<task> status [--json] [--refresh]
  boxers [<machine>/]<task> sync|review|check
  boxers [<machine>/]<task> promote [--message <message>] [--skip-checks]
  boxers [<machine>/]<task> preview [start|stop|restart|logs]
  boxers [<machine>/]<task> discard [--force]

  # Remote creation also identifies the project that will own the new task.
  boxers <machine>/<project>/<task> new [--agent codex|claude] [...]

Diagnostics
  boxers debug shell <task>
  boxers debug daemon

Daemon
  boxers daemon install
  boxers daemon start
  boxers daemon restart [--force]
  boxers daemon status [--json]
  boxers daemon stop [--force]

New and attach stream through a local boxers daemon (started automatically
on first use) that holds the native agent session. Closing this terminal or
losing the connection only loses the view — the task keeps running. Ctrl-C
detaches deliberately without stopping it.
`;

export class UsageError extends Error {}

function value(args: string[], index: number, flag: string): string {
  const result = args[index + 1];
  if (result === undefined || result.startsWith("-"))
    throw new UsageError(`${flag} requires a value.`);
  return result;
}

function only(args: string[], allowed: readonly string[], command: string): void {
  const unexpected = args.find((arg) => !allowed.includes(arg));
  if (unexpected) throw new UsageError(`Unexpected argument for ${command}: ${unexpected}`);
}

function parseInit(args: string[]): {
  integration?: IntegrationMode;
  base?: string;
  remote?: string;
  checks?: boolean;
  preview?: boolean;
  previewCommand?: string;
  previewPorts?: number[];
  yes?: boolean;
  agent?: Agent;
  model?: string;
  effort?: string;
  fast?: boolean;
} {
  let integration: IntegrationMode | undefined;
  let base: string | undefined;
  let remote: string | undefined;
  let checks: boolean | undefined;
  let preview: boolean | undefined;
  let previewCommand: string | undefined;
  const previewPorts: number[] = [];
  let yes = false;
  let agent: Agent | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let fast: boolean | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--agent" || arg?.startsWith("--agent=")) {
      const candidate = arg === "--agent" ? value(args, index++, arg) : arg.slice(8);
      if (!isAgent(candidate)) throw new UsageError("--agent must be codex or claude.");
      agent = candidate;
    } else if (arg === "--model") model = value(args, index++, arg);
    else if (arg?.startsWith("--model=")) model = arg.slice(8);
    else if (arg === "--effort") effort = value(args, index++, arg);
    else if (arg?.startsWith("--effort=")) effort = arg.slice(9);
    else if (arg === "--fast") fast = true;
    else if (arg === "--no-fast") fast = false;
    else if (arg === "--integration") {
      const candidate = value(args, index, arg);
      if (candidate !== "local" && candidate !== "remote")
        throw new UsageError("--integration must be local or remote.");
      integration = candidate;
      index++;
    } else if (arg?.startsWith("--integration=")) {
      const candidate = arg.slice(14);
      if (candidate !== "local" && candidate !== "remote")
        throw new UsageError("--integration must be local or remote.");
      integration = candidate;
    } else if (arg === "--base") {
      base = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--base=")) base = arg.slice(7);
    else if (arg === "--remote") {
      remote = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--remote=")) remote = arg.slice(9);
    else if (arg === "--checks") checks = true;
    else if (arg === "--no-checks") checks = false;
    else if (arg === "--preview") preview = true;
    else if (arg === "--no-preview") preview = false;
    else if (arg === "--preview-command") {
      previewCommand = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--preview-command=")) {
      previewCommand = arg.slice(18);
      if (!previewCommand) throw new UsageError("--preview-command requires a value.");
    } else if (arg === "--preview-port") {
      const candidate = Number(value(args, index, arg));
      if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65_535)
        throw new UsageError("--preview-port must be an integer from 1 to 65535.");
      previewPorts.push(candidate);
      index++;
    } else if (arg?.startsWith("--preview-port=")) {
      const candidate = Number(arg.slice(15));
      if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65_535)
        throw new UsageError("--preview-port must be an integer from 1 to 65535.");
      previewPorts.push(candidate);
    } else if (arg === "-y" || arg === "--yes") yes = true;
    else throw new UsageError(`Unexpected argument for project init: ${arg}`);
  }
  if (integration === "local" && remote)
    throw new UsageError("--remote applies only to remote integration.");
  if (preview === false && (previewCommand || previewPorts.length))
    throw new UsageError("--no-preview cannot be combined with preview command options.");
  if (previewCommand && !previewPorts.length)
    throw new UsageError("--preview-command requires at least one --preview-port.");
  if (!previewCommand && previewPorts.length)
    throw new UsageError("--preview-port requires --preview-command.");
  return {
    ...(integration ? { integration } : {}),
    ...(base ? { base } : {}),
    ...(remote ? { remote } : {}),
    ...(checks !== undefined ? { checks } : {}),
    ...(preview !== undefined ? { preview } : {}),
    ...(previewCommand ? { previewCommand, previewPorts } : {}),
    ...(yes ? { yes } : {}),
    ...(agent ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(fast !== undefined ? { fast } : {}),
  };
}

function parseNew(args: string[]): {
  agent?: Agent;
  prompt?: string;
  template?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  detach: boolean;
} {
  let agentValue: string | undefined;
  let prompt: string | undefined;
  let promptFile: string | undefined;
  let template: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let fast: boolean | undefined;
  let detach = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--agent") {
      agentValue = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--agent=")) agentValue = arg.slice(8);
    else if (arg === "--prompt") {
      prompt = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--prompt=")) prompt = arg.slice(9);
    else if (arg === "--prompt-file") {
      promptFile = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--prompt-file=")) promptFile = arg.slice(14);
    else if (arg === "--template") {
      template = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--template=")) template = arg.slice(11);
    else if (arg === "--model") {
      model = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--model=")) model = arg.slice(8);
    else if (arg === "--effort") {
      effort = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--effort=")) effort = arg.slice(9);
    else if (arg === "--fast") fast = true;
    else if (arg === "--no-fast") fast = false;
    else if (arg === "-d" || arg === "--detach") detach = true;
    else throw new UsageError(`Unexpected argument for new: ${arg}`);
  }
  if (prompt !== undefined && promptFile !== undefined)
    throw new UsageError("Use either --prompt or --prompt-file, not both.");
  if (promptFile) prompt = readFileSync(promptFile, "utf8");
  if (agentValue !== undefined && !isAgent(agentValue))
    throw new UsageError("--agent must be codex or claude.");
  return {
    ...(agentValue ? { agent: agentValue } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(template !== undefined ? { template } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(fast !== undefined ? { fast } : {}),
    detach,
  };
}

function parsePromote(args: string[]): { message?: string; skipChecks: boolean } {
  let message: string | undefined;
  let skipChecks = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--message") {
      if (message !== undefined) throw new UsageError("--message may only be specified once.");
      message = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--message=")) {
      if (message !== undefined) throw new UsageError("--message may only be specified once.");
      message = arg.slice(10);
    } else if (arg === "--skip-checks") skipChecks = true;
    else throw new UsageError(`Unexpected argument for promote: ${arg}`);
  }
  return {
    ...(message !== undefined ? { message } : {}),
    skipChecks,
  };
}

function parseSessionSettings(args: string[]): { model?: string; effort?: string; fast?: boolean } {
  let model: string | undefined;
  let effort: string | undefined;
  let fast: boolean | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--model") {
      model = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--model=")) model = arg.slice(8);
    else if (arg === "--effort") {
      effort = value(args, index, arg);
      index++;
    } else if (arg?.startsWith("--effort=")) effort = arg.slice(9);
    else if (arg === "--fast") fast = true;
    else throw new UsageError(`Unexpected argument for attach: ${arg}`);
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(fast !== undefined ? { fast } : {}),
  };
}

function parseDoctor(args: string[]): {
  agent?: Agent;
  json: boolean;
  acknowledgeOpenNetwork: boolean;
  host?: string;
  all: boolean;
} {
  let agent: Agent | undefined;
  let json = false;
  let acknowledgeOpenNetwork = false;
  let host: string | undefined;
  let all = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--agent") {
      const candidate = value(args, index, arg);
      if (!isAgent(candidate)) throw new UsageError("--agent must be codex or claude.");
      agent = candidate;
      index++;
    } else if (arg?.startsWith("--agent=")) {
      const candidate = arg.slice(8);
      if (!isAgent(candidate)) throw new UsageError("--agent must be codex or claude.");
      agent = candidate;
    } else if (arg === "--json") json = true;
    else if (arg === "--host") host = value(args, index++, arg);
    else if (arg?.startsWith("--host=")) host = arg.slice(7);
    else if (arg === "--all") all = true;
    else if (arg === "--acknowledge-open-network") acknowledgeOpenNetwork = true;
    else throw new UsageError(`Unexpected argument for doctor: ${arg}`);
  }
  if (host && all) throw new UsageError("doctor accepts either --host or --all, not both.");
  return {
    ...(agent ? { agent } : {}),
    json,
    acknowledgeOpenNetwork,
    ...(host ? { host } : {}),
    all,
  };
}

export async function dispatch(argv: string[]): Promise<number> {
  if (argv[0] === "__daemon-run") {
    only(argv.slice(1), [], "internal daemon entrypoint");
    return runDaemonForeground();
  }
  if (argv[0] === "__setup-worker") {
    const [, projectId, taskId, run, timeout, startedAt, previewRun, ...unexpected] = argv;
    if (!projectId || !taskId || !run || !timeout || !startedAt || unexpected.length)
      throw new Error("Invalid background setup worker invocation.");
    return runSetupWorker(projectId, taskId, run, Number(timeout), startedAt, previewRun);
  }
  if (argv[0] === "__daemon-settlement-worker") {
    const [, payload, ...unexpected] = argv;
    if (!payload || unexpected.length)
      throw new Error("Invalid daemon settlement worker invocation.");
    return runDaemonSettlementWorker(payload);
  }
  if (argv[0] === "__daemon-lifecycle-worker") {
    const [, payload, ...unexpected] = argv;
    if (!payload || unexpected.length)
      throw new Error("Invalid daemon lifecycle worker invocation.");
    return runDaemonLifecycleWorker(payload);
  }
  if (argv[0] === "__daemon-intent-worker") {
    const [, payload, ...unexpected] = argv;
    if (!payload || unexpected.length) throw new Error("Invalid daemon intent worker invocation.");
    return runDaemonIntentWorker(payload);
  }
  const [first, ...rest] = argv;
  if (first === undefined || first === "help" || first === "-h" || first === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (first === "version" || first === "-v" || first === "--version") {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (first === "doctor") {
    const options = parseDoctor(rest);
    const result = doctor(options.acknowledgeOpenNetwork, options.agent);
    if (options.all || options.host)
      return doctorFleet(result, {
        ...(options.host ? { host: options.host } : {}),
        all: options.all,
        json: options.json,
        ...(options.agent ? { agent: options.agent } : {}),
        acknowledgeOpenNetwork: options.acknowledgeOpenNetwork,
      });
    return printDoctor(result, options.json);
  }
  if (first === "status") {
    let host: string | undefined;
    let refresh = false;
    let json = false;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index];
      if (arg === "--host") host = value(rest, index++, arg);
      else if (arg?.startsWith("--host=")) host = arg.slice(7);
      else if (arg === "--refresh") refresh = true;
      else if (arg === "--json") json = true;
      else throw new UsageError(`Unexpected argument for status: ${arg}`);
    }
    return showFleetStatus({ refresh, ...(host ? { host } : {}), json });
  }
  if (first === "update") {
    let host: string | undefined;
    let all = false;
    let version: string | undefined;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index];
      if (arg === "--host") host = value(rest, index++, arg);
      else if (arg?.startsWith("--host=")) host = arg.slice(7);
      else if (arg === "--all") all = true;
      else if (arg === "--to") version = value(rest, index++, arg);
      else if (arg?.startsWith("--to=")) version = arg.slice(5);
      else throw new UsageError(`Unexpected argument for update: ${arg}`);
    }
    if (Boolean(host) === all)
      throw new UsageError("update requires exactly one of --host or --all.");
    return updateFleet({ ...(host ? { host } : {}), all, ...(version ? { version } : {}) });
  }
  if (first === "auth") {
    const [agentValue, ...authArgs] = rest;
    if (agentValue === "status") {
      let host: string | undefined;
      let all = false;
      let refresh = false;
      let json = false;
      for (let index = 0; index < authArgs.length; index++) {
        const arg = authArgs[index];
        if (arg === "--host") host = value(authArgs, index++, arg);
        else if (arg?.startsWith("--host=")) host = arg.slice(7);
        else if (arg === "--all") all = true;
        else if (arg === "--refresh") refresh = true;
        else if (arg === "--json") json = true;
        else throw new UsageError(`Unexpected argument for auth status: ${arg}`);
      }
      if (host && all)
        throw new UsageError("auth status accepts either --host or --all, not both.");
      return showAuthenticationStatus({ refresh, ...(host ? { host } : {}), all, json });
    }
    if (!isAgent(agentValue ?? "")) throw new UsageError("auth requires codex or claude.");
    only(authArgs, ["--oauth", "--api-key"], "auth");
    if (authArgs.includes("--oauth") && authArgs.includes("--api-key"))
      throw new UsageError("Use either --oauth or --api-key, not both.");
    if (agentValue === "claude" && authArgs.length)
      throw new UsageError("--oauth and --api-key apply only to Codex authentication.");
    return authenticate(
      agentValue as Agent,
      authArgs.includes("--api-key")
        ? "api-key"
        : authArgs.includes("--oauth")
          ? "oauth"
          : undefined,
    );
  }
  if (first === "init") {
    only(rest, [], "init");
    return initializeMachine();
  }
  if (first === "list" || first === "ls") {
    if (rest[0] === "templates") {
      only(rest.slice(1), ["--json"], "list templates");
      return listTemplates(rest.includes("--json"));
    }
    only(rest, ["--json"], "list");
    return list(rest.includes("--json"));
  }
  if (first === "debug") {
    const [command, task, ...args] = rest;
    if (command === "daemon") {
      if (task || args.length) throw new UsageError("debug daemon accepts no arguments.");
      return runDaemonForeground(true);
    }
    if (command === "shell" && task && !args.length) return debugShell(task);
    throw new UsageError("debug requires daemon or shell <task>.");
  }
  if (first === "connect") {
    const host = rest[0];
    if (!host || host.startsWith("-")) throw new UsageError("connect requires an SSH target.");
    let name: string | undefined;
    let reverseHost: string | undefined;
    let install = true;
    let admin = true;
    for (let index = 1; index < rest.length; index++) {
      const arg = rest[index];
      if (arg === "--name") name = value(rest, index++, arg);
      else if (arg?.startsWith("--name=")) name = arg.slice(7);
      else if (arg === "--reverse-host") reverseHost = value(rest, index++, arg);
      else if (arg?.startsWith("--reverse-host=")) reverseHost = arg.slice(15);
      else if (arg === "--no-install") install = false;
      else if (arg === "--admin") admin = true;
      else if (arg === "--observe-only") admin = false;
      else throw new UsageError(`Unexpected argument for connect: ${arg}`);
    }
    return connectHost({
      host,
      ...(name ? { name } : {}),
      ...(reverseHost ? { reverseHost } : {}),
      install,
      admin,
    });
  }
  if (first === "hosts") {
    only(rest, ["--json"], "hosts");
    const fleet = readFleet();
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify({ fleet })}\n`);
    else if (!fleet) process.stdout.write("No Boxers fleet is configured.\n");
    else {
      process.stdout.write(`Fleet ${fleet.fleetId}\n`);
      for (const member of fleet.members)
        process.stdout.write(
          `  ${member.name}\t${member.hostId}\t${member.roles.join(",")}\t${member.endpoints.map((endpoint) => endpoint.target).join(",") || "local"}\n`,
        );
    }
    return 0;
  }
  if (first === "disconnect") {
    if (rest.length !== 1) throw new UsageError("disconnect requires one host name or ID.");
    return disconnectHost(rest[0] as string);
  }
  if (first === "service") {
    const [command, ...args] = rest;
    if (command === "status") {
      only(args, ["--json"], "service status");
      const status = daemonServiceStatus();
      process.stdout.write(
        args.includes("--json")
          ? `${JSON.stringify(status)}\n`
          : `${status.active && (!status.supported || status.enabled) ? "ok" : "FAIL"}  daemon service (${status.platform}): ${status.detail}\n`,
      );
      return status.active && (!status.supported || status.enabled) ? 0 : 1;
    }
    if (command === "install") {
      if (args[0] !== "--executable" || !args[1] || args.length !== 2)
        throw new UsageError("service install requires --executable <path>.");
      const status = installDaemonService(args[1]);
      process.stdout.write(`${JSON.stringify(status)}\n`);
      return 0;
    }
    throw new UsageError("service requires install or status.");
  }
  if (first === "project") {
    if (rest[0] === "init") {
      const options = parseInit(rest.slice(1));
      return initialize(options);
    }
    if (rest[0] === "status") {
      only(rest.slice(1), ["--json"], "project status");
      return projectStatus(rest.includes("--json"));
    }
    const [commandName, machine, ...args] = rest;
    if (commandName !== "add" || !machine)
      throw new UsageError(
        "project requires init, status, or add <machine> --clone --into <absolute-path>.",
      );
    let destination: string | undefined;
    let clone = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--clone") clone = true;
      else if (arg === "--into") {
        destination = value(args, index, arg);
        index++;
      } else if (arg?.startsWith("--into=")) destination = arg.slice(7);
      else throw new UsageError(`Unexpected argument for project add: ${arg}`);
    }
    if (!clone || !destination)
      throw new UsageError("project add requires --clone --into <absolute-path>.");
    const project = requireProject();
    return runRemoteCommand(
      machine,
      [
        "__remote-project-clone",
        projectCloneSource(project),
        project.integration.base,
        destination,
      ],
      true,
    );
  }
  if (first === "remote") {
    const [command, ...args] = rest;
    if (command === "ssh-identity") {
      only(args, [], "remote ssh-identity");
      const identity = ensureManagedSshIdentity();
      process.stdout.write(
        `${JSON.stringify({ version: 1, publicKey: identity.publicKey, fingerprint: identity.fingerprint })}\n`,
      );
      return 0;
    }
    if (command === "authorize-peer") {
      if (args.length !== 1) throw new UsageError("remote authorize-peer requires one payload.");
      acceptPeerAuthorization(args[0] as string);
      process.stdout.write(`${JSON.stringify({ authorized: true })}\n`);
      return 0;
    }
    if (command === "revoke-peer") {
      if (args.length !== 1) throw new UsageError("remote revoke-peer requires one host ID.");
      revokeManagedPeer(args[0] as string);
      process.stdout.write(`${JSON.stringify({ authorized: false })}\n`);
      return 0;
    }
    if (command === "gateway") {
      if (args.length !== 1) throw new UsageError("remote gateway requires one host ID.");
      return runSshGateway(args[0] as string);
    }
    if (command === "identity") {
      only(args, [], "remote identity");
      process.stdout.write(`${JSON.stringify(remoteIdentity())}\n`);
      return 0;
    }
    if (command === "enroll") {
      if (args.length !== 1) throw new UsageError("remote enroll requires one payload.");
      acceptEnrollment(args[0] as string);
      process.stdout.write(`${JSON.stringify({ enrolled: true })}\n`);
      return 0;
    }
    if (command === "unenroll") {
      if (args.length !== 1) throw new UsageError("remote unenroll requires one host name or ID.");
      acceptUnenrollment(args[0] as string);
      process.stdout.write(`${JSON.stringify({ enrolled: false })}\n`);
      return 0;
    }
    if (command === "sync-fleet") {
      if (args.length !== 1) throw new UsageError("remote sync-fleet requires one payload.");
      process.stdout.write(`${JSON.stringify(acceptFleetSync(args[0] as string))}\n`);
      return 0;
    }
    if (command === "verify-peer") {
      if (
        (args.length !== 1 && args.length !== 2) ||
        (args.length === 2 && args[1] !== "--accept-new-host-key")
      )
        throw new UsageError(
          "remote verify-peer requires one host ID and optional --accept-new-host-key.",
        );
      return verifyEnrolledPeer(args[0] as string, args[1] === "--accept-new-host-key");
    }
    if (command === "update") {
      if (args.length !== 1) throw new UsageError("remote update requires one request.");
      process.stdout.write(`${JSON.stringify(acceptManagedUpdate(args[0] as string))}\n`);
      return 0;
    }
    if (command === "snapshot") {
      only(args, ["--refresh-status"], "remote snapshot");
      return remoteSnapshot(args.includes("--refresh-status"));
    }
    if (command === "watch") {
      only(args, [], "remote watch");
      return remoteWatch();
    }
    only(args, [], `remote ${command ?? ""}`.trim());
    throw new UsageError("remote requires a supported protocol command.");
  }
  if (first === "daemon") {
    const [command, ...args] = rest;
    if (command === "install") {
      only(args, [], "daemon install");
      const executable = resolveBoxersExecutable();
      const status = installDaemonService(executable);
      process.stdout.write(`Installed the Boxers daemon service: ${status.detail}\n`);
      return 0;
    }
    if (command === "start") {
      only(args, [], "daemon start");
      return daemonStart();
    }
    if (command === "stop") {
      only(args, ["--force"], "daemon stop");
      return daemonStop(args.includes("--force"));
    }
    if (command === "restart") {
      only(args, ["--force"], "daemon restart");
      return daemonRestart(args.includes("--force"));
    }
    if (command === "status") {
      only(args, ["--json"], "daemon status");
      return daemonStatus(args.includes("--json"));
    }
    throw new UsageError("daemon requires install, start, restart, stop, or status.");
  }
  if (first === "__remote-new") {
    const [project, task, ...newArgs] = rest;
    if (!project || !task) throw new UsageError("remote creation requires project and task.");
    const options = parseNew(newArgs);
    return newTaskInProject(project, task, {
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.template !== undefined ? { template: options.template } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.fast !== undefined ? { fast: options.fast } : {}),
      detach: options.detach,
    });
  }
  if (first === "__remote-project-clone") {
    const [source, base, destination, ...unexpected] = rest;
    if (!source || !base || !destination || unexpected.length)
      throw new UsageError("remote project clone requires source, base, and destination.");
    return cloneAndInitializeProject(source, base, destination);
  }
  if (rest.length === 0) throw new UsageError(`Missing command for task "${first}".`);
  const [taskCommand, ...args] = rest;
  const qualified = first.split("/");
  if (qualified.length === 3 && taskCommand === "new") {
    const [machine, project, task] = qualified;
    if (!machine || !project || !task)
      throw new UsageError("Remote creation requires <machine>/<project>/<task>.");
    return runRemoteCommand(machine, ["__remote-new", project, task, ...args], true);
  }
  if (qualified.length > 1) {
    if (qualified.length !== 2)
      throw new UsageError("Remote task commands require <machine>/<task>.");
    const [machine, task] = qualified;
    if (!machine || !task) throw new UsageError("Remote task commands require <machine>/<task>.");
    if (taskCommand === "new")
      throw new UsageError("Remote new requires <machine>/<project>/<task>.");
    const remoteCommands = new Set([
      "attach",
      "status",
      "review",
      "check",
      "promote",
      "sync",
      "preview",
      "discard",
    ]);
    if (taskCommand && remoteCommands.has(taskCommand))
      return runRemoteTaskCommand(
        machine,
        task,
        [taskCommand, ...args],
        !(taskCommand === "status" && args.includes("--json")),
      );
  }
  switch (taskCommand) {
    case "new": {
      const options = parseNew(args);
      return newTask(first, {
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
        ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
        ...(options.template !== undefined ? { template: options.template } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
        ...(options.fast !== undefined ? { fast: options.fast } : {}),
        detach: options.detach,
      });
    }
    case "attach": {
      const settings = parseSessionSettings(args);
      return attach(first, settings);
    }
    case "status":
      only(args, ["--json", "--refresh"], "status");
      return taskStatus(first, args.includes("--json"), args.includes("--refresh"));
    case "review":
      only(args, [], "review");
      return reviewTask(first);
    case "check":
      only(args, [], "check");
      return checkTask(first);
    case "promote": {
      const options = parsePromote(args);
      return promote(first, options.message, options.skipChecks);
    }
    case "sync":
      only(args, [], "sync");
      return sync(first);
    case "preview": {
      const action = args[0] ?? "show";
      if (!["show", "start", "stop", "restart", "logs"].includes(action) || args.length > 1)
        throw new UsageError("preview accepts start, stop, restart, or logs.");
      return preview(first, action as "show" | "start" | "stop" | "restart" | "logs");
    }
    case "discard":
      only(args, ["--force"], "discard");
      return discard(first, args.includes("--force"));
    default:
      throw new UsageError(`Unknown command: ${taskCommand}. Run "boxers help".`);
  }
}
