import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv } from "../src/core/dotenv.js";

describe(".env loader", () => {
  it("loads keys, honors quotes/comments, never overrides real env vars", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-env-"));
    fs.writeFileSync(
      path.join(dir, ".env"),
      [
        "# comment",
        "TT_TEST_PLAIN=hello",
        'TT_TEST_QUOTED="sk-ant-abc123"',
        "TT_TEST_EXISTING=from-file",
        "not a valid line",
        "",
      ].join("\n")
    );
    process.env.TT_TEST_EXISTING = "from-env";
    loadDotEnv(dir);
    expect(process.env.TT_TEST_PLAIN).toBe("hello");
    expect(process.env.TT_TEST_QUOTED).toBe("sk-ant-abc123");
    expect(process.env.TT_TEST_EXISTING).toBe("from-env"); // env wins
  });

  it("is a no-op when no .env exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-noenv-"));
    expect(() => loadDotEnv(dir)).not.toThrow();
  });
});
