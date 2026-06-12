import fs from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader (no dependency): lets non-technical users put
 * ANTHROPIC_API_KEY=sk-ant-... in a `.env` file next to where they run the
 * CLI instead of learning shell environment variables. Real environment
 * variables always win; the file is optional and gitignored.
 */
export function loadDotEnv(dir: string = process.cwd()): void {
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
