import { fileURLToPath } from "node:url";

export const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/no-mistakes-required.yml", import.meta.url),
);

/**
 * Extract the gate's inline `run:` block from the workflow source, so tests
 * execute the exact script CI runs instead of a copy of it. The block is a
 * literal YAML scalar: every non-blank line carries the same 10-space indent,
 * and blank lines inside it are empty.
 */
export function extractGateScript(workflow) {
  const start = workflow.indexOf("        run: |\n");
  if (start === -1) throw new Error("no-mistakes gate step has no run block");
  const lines = workflow.slice(start + "        run: |\n".length).split("\n");
  const script = [];
  for (const line of lines) {
    if (line === "") {
      script.push("");
      continue;
    }
    if (!line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  if (script.length === 0) throw new Error("no-mistakes gate run block is empty");
  return `${script.join("\n").replace(/\n+$/, "")}\n`;
}
