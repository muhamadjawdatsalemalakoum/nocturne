#!/usr/bin/env node
// A scriptable stand-in for `claude -p ... --output-format json`.
// Behavior is driven by a scenario JSON file (env FAKE_CLAUDE_SCENARIO).
//
// Scenario shape:
//   {
//     "rules": [
//       { "match": { "contains": "branch b" }, "responses": [ <behavior>, ... ] },
//       ...
//     ],
//     "default": <behavior>
//   }
// A behavior is one of:
//   { "ok": "text", "cost": 0.01, "sessionId": "s1", "echoResume": true }
//   { "limit": "Usage limit reached. resets at 3pm" }
//   { "auth": true }
//   { "fail": "message", "status": 500 }
//   { "hang": true }
// Each rule consumes its responses in sequence across invocations (persisted to a
// sidecar state file); the last response repeats once exhausted.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
function argVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
// prompt is the token right after -p
const prompt = argVal("-p") ?? "";
const resume = argVal("--resume");

const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
const statePath = process.env.FAKE_CLAUDE_STATE ?? (scenarioPath ? scenarioPath + ".state.json" : undefined);

function loadJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

const scenario = scenarioPath ? loadJson(scenarioPath, {}) : {};
const state = statePath && existsSync(statePath) ? loadJson(statePath, {}) : {};

function matches(rule, text) {
  const m = rule.match ?? {};
  if (m.any) return true;
  if (typeof m.contains === "string") return text.includes(m.contains);
  if (typeof m.equals === "string") return text === m.equals;
  return false;
}

let behavior = scenario.default ?? { ok: "OK", cost: 0.001 };
const rules = Array.isArray(scenario.rules) ? scenario.rules : [];
for (let i = 0; i < rules.length; i++) {
  const rule = rules[i];
  if (matches(rule, prompt)) {
    const responses = Array.isArray(rule.responses) ? rule.responses : [rule.response ?? {}];
    const key = "rule_" + i;
    const idx = Math.min(state[key] ?? 0, responses.length - 1);
    behavior = responses[idx];
    state[key] = (state[key] ?? 0) + 1;
    if (statePath) {
      try {
        writeFileSync(statePath, JSON.stringify(state));
      } catch {
        /* ignore */
      }
    }
    break;
  }
}

const streaming = process.argv.includes("stream-json");
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}
function emitLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (behavior.hang) {
  // never respond; parent must time out and kill us
  setInterval(() => {}, 1 << 30);
} else {
  // Build the final result object for this behavior.
  let result;
  const activities = [];
  if (behavior.auth) {
    result = { type: "result", subtype: "error", is_error: true, api_error_status: 401, result: "Failed to authenticate. API Error: 401 Invalid authentication credentials", total_cost_usd: 0 };
  } else if (behavior.limit) {
    result = { type: "result", subtype: "error", is_error: true, api_error_status: 429, result: behavior.limit, total_cost_usd: 0 };
  } else if (behavior.fail) {
    result = { type: "result", subtype: "error", is_error: true, api_error_status: behavior.status ?? 500, result: behavior.fail, total_cost_usd: behavior.cost ?? 0 };
  } else {
    let text = behavior.ok ?? "OK";
    if (behavior.echoResume && resume) text += ` [resumed:${resume}]`;
    if (behavior.echoPrompt) text += ` PROMPT<${prompt}>`;
    result = { type: "result", subtype: "success", is_error: false, result: text, session_id: behavior.sessionId ?? randomUUID(), total_cost_usd: behavior.cost ?? 0.001, usage: { input_tokens: 10, output_tokens: 5 } };
    // success activities for the live feed
    for (const t of behavior.tools ?? []) {
      const name = typeof t === "string" ? t.split(" ")[0] : t.name;
      const fp = typeof t === "string" ? t.split(" ").slice(1).join(" ") : t.file_path;
      activities.push({ type: "assistant", message: { content: [{ type: "tool_use", name, input: fp ? { file_path: fp } : {} }] } });
    }
    activities.push({ type: "assistant", message: { content: [{ type: "text", text }] } });
  }

  if (streaming) {
    const delay = behavior.delayMs ?? 0;
    emitLine({ type: "system", subtype: "init" });
    let i = 0;
    const step = () => {
      if (i < activities.length) {
        emitLine(activities[i++]);
        setTimeout(step, delay);
      } else {
        emitLine(result);
        process.exit(0);
      }
    };
    setTimeout(step, delay);
  } else {
    emit(result);
    process.exit(0);
  }
}
