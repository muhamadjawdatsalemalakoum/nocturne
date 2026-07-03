import { describe, it, expect } from "vitest";
import { sanitizeEnv, buildArgs, parseCliJson } from "../src/index.js";

describe("sanitizeEnv", () => {
  it("strips poisoning and session vars, keeps the rest", () => {
    const env = sanitizeEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_BASE_URL: "http://proxy",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      ANTHROPIC_AUTH_TOKEN: "tok",
      BAGGAGE: "b",
      AI_AGENT: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDECODE: "1",
      CLAUDE_CONFIG_DIR: "/home/x/.claude",
    });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/x");
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/home/x/.claude"); // preserved: finds credentials
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["BAGGAGE"]).toBeUndefined();
    expect(env["AI_AGENT"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
    expect(env["CLAUDECODE"]).toBeUndefined();
  });

  it("injects an OAuth token when provided", () => {
    const env = sanitizeEnv({ PATH: "/x" }, { oauthToken: "my-token" });
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("my-token");
  });

  it("strips proxy and custom-header vars (case-insensitive) that could MITM/override auth", () => {
    const env = sanitizeEnv({
      PATH: "/x",
      HTTPS_PROXY: "http://evil",
      https_proxy: "http://evil",
      HTTP_PROXY: "http://evil",
      ALL_PROXY: "http://evil",
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer x",
    });
    expect(env["PATH"]).toBe("/x");
    expect(env["HTTPS_PROXY"]).toBeUndefined();
    expect(env["https_proxy"]).toBeUndefined();
    expect(env["HTTP_PROXY"]).toBeUndefined();
    expect(env["ALL_PROXY"]).toBeUndefined();
    expect(env["ANTHROPIC_CUSTOM_HEADERS"]).toBeUndefined();
  });
});

describe("buildArgs", () => {
  const baseOpts = { prompt: "do it", cwd: "/x", timeoutMs: 1000 };

  it("always requests json output and passes the prompt", () => {
    const a = buildArgs(baseOpts);
    expect(a[0]).toBe("-p");
    expect(a[1]).toBe("do it");
    expect(a).toContain("--output-format");
    expect(a).toContain("json");
  });

  it("omits --model for inherit, includes it otherwise", () => {
    expect(buildArgs({ ...baseOpts, model: "inherit" })).not.toContain("--model");
    const a = buildArgs({ ...baseOpts, model: "haiku" });
    expect(a).toContain("--model");
    expect(a[a.indexOf("--model") + 1]).toBe("haiku");
  });

  it("includes resume, tools, permission mode, budget and schema when set", () => {
    const a = buildArgs({
      ...baseOpts,
      resumeSessionId: "sess-1",
      allowedTools: ["Edit", "Bash(npm *)"],
      permissionMode: "dontAsk",
      maxBudgetUsd: 2,
      outputSchema: { type: "object" },
    });
    expect(a[a.indexOf("--resume") + 1]).toBe("sess-1");
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("Edit Bash(npm *)");
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("2");
    expect(a[a.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
  });
});

describe("parseCliJson", () => {
  it("parses a clean single object", () => {
    expect(parseCliJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("finds the last JSON line among noise", () => {
    const out = 'war: something\n{"result":"ok","is_error":false}\n';
    expect(parseCliJson(out)).toMatchObject({ result: "ok" });
  });
  it("returns null on unparseable output", () => {
    expect(parseCliJson("not json at all")).toBeNull();
    expect(parseCliJson("")).toBeNull();
  });
});
