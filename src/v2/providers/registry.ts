import type { Agent } from "../types.ts";
import { claudeHarness } from "./claude.ts";
import { codexHarness } from "./codex.ts";
import type { AgentHarness } from "./types.ts";

const harnesses = {
  codex: codexHarness,
  claude: claudeHarness,
} satisfies Record<Agent, AgentHarness>;

export function harnessForAgent(agent: Agent): AgentHarness {
  return harnesses[agent];
}
