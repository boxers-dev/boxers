import { writeStdout } from "../core/output.ts";
import type { Agent } from "./types.ts";

const TEMPLATE_IMAGE = "ghcr.io/boxers-dev/boxers-templates";
const TEMPLATE_AGENTS = ["codex", "claude"] as const satisfies readonly Agent[];

export interface BuiltInTemplate {
  name: string;
  description: string;
  agents: readonly Agent[];
}

export const builtInTemplates: readonly BuiltInTemplate[] = [
  {
    name: "default",
    description: "Node.js LTS with current Codex or Claude tooling, pnpm, and Yarn.",
    agents: TEMPLATE_AGENTS,
  },
  {
    name: "bun",
    description: "A smaller task image with the current pinned Bun runtime.",
    agents: TEMPLATE_AGENTS,
  },
  {
    name: "tauri",
    description: "Tauri desktop tooling with Rust, Clang, CMake, Vulkan, and SPIR-V.",
    agents: TEMPLATE_AGENTS,
  },
];

function templateImage(agent: Agent, name: string): string {
  return `${TEMPLATE_IMAGE}:${agent}-${name}`;
}

export function resolveTemplate(agent: Agent, requested?: string): string {
  const template = requested ?? "default";
  if (!template.trim()) throw new Error("--template must not be empty.");
  if (builtInTemplates.some((candidate) => candidate.name === template))
    return templateImage(agent, template);
  return template;
}

export function listTemplates(json: boolean): number {
  const templates = builtInTemplates.map((template) => ({
    ...template,
    agents: [...template.agents],
    images: Object.fromEntries(
      template.agents.map((agent) => [agent, templateImage(agent, template.name)]),
    ) as Record<Agent, string>,
  }));
  if (json) {
    writeStdout(`${JSON.stringify({ templates, customImagesSupported: true })}\n`);
    return 0;
  }
  writeStdout("Built-in task templates\n");
  for (const template of templates)
    writeStdout(
      `  ${template.name.padEnd(8)} ${template.description} (${template.agents.join(", ")})\n`,
    );
  writeStdout("\nYou can also pass a local or OCI image reference with `--template <image>`.\n");
  return 0;
}
