export function writeStandins(dir: string, versions?: { claude?: string | false; codex?: string | false; replay?: { node: string; script: string } }): string;
export function standinCalls(dir: string): string[];
