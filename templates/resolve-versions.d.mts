export interface NodeRelease {
  version?: string;
  lts?: string | boolean;
}

export function nodeLtsVersion(releases: NodeRelease[]): string;
export function rustVersion(text: string): string;
