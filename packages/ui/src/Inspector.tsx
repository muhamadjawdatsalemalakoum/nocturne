import { useStore } from "./store";
import { IconTrash } from "./icons";
import { PROMPT_PRESETS, TOOL_PRESETS, TOOL_CHIPS, WAIT_DURATIONS } from "./templates";

const MODELS = ["inherit", "haiku", "sonnet", "opus"] as const;
const PERMISSION_MODES = ["dontAsk", "default", "acceptEdits", "bypassPermissions", "plan"] as const;

export function Inspector() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const selectedId = useStore((s) => s.selectedId);
  const meta = useStore((s) => s.meta);
  const update = useStore((s) => s.updateNodeData);
  const setMeta = useStore((s) => s.setMeta);
  const del = useStore((s) => s.deleteSelected);
  const dup = useStore((s) => s.duplicateSelected);

  const node = nodes.find((n) => n.id === selectedId) ?? null;

  if (!node) {
    return (
      <div className="inspector" data-testid="inspector">
        <div className="kind">settings</div>
        <div className="field">
          <label>Workflow name</label>
          <input className="input" type="text" value={meta.name} onChange={(e) => setMeta({ name: e.target.value })} />
        </div>
        <div className="field">
          <label>Description</label>
          <textarea style={{ minHeight: 56, fontFamily: "var(--font-ui)", fontSize: 12.5 }} value={meta.description} onChange={(e) => setMeta({ description: e.target.value })} placeholder="What does this workflow do?" />
        </div>
        <div className="field">
          <label>Parameters</label>
          <textarea style={{ minHeight: 52 }} value={meta.params.map((p) => p.name).join("\n")} placeholder="one identifier per line"
            onChange={(e) => {
              const existing = new Map(meta.params.map((p) => [p.name, p]));
              const params = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean).map((name) => existing.get(name) ?? { name, description: "", default: "" });
              setMeta({ params });
            }} />
          <div className="hint">Fill these in at run time. Use <code>{"{{params.name}}"}</code> in a prompt.</div>
        </div>
        <div className="hint" style={{ marginTop: 12 }}>Select a step to edit it, or start from a template.</div>
      </div>
    );
  }

  const kind = node.type as string;
  const d = node.data as Record<string, unknown>;
  const upstream = ancestorsOf(node.id, nodes, edges).filter((n) => n.type === "agent");
  const tools = (d.allowedTools as string[]) ?? [];
  const toggleTool = (t: string) => update(node.id, { allowedTools: tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t] });
  const applyPrompt = (text: string) => {
    const prev = upstream[0]?.id; // nearest upstream agent (BFS-ordered)
    update(node.id, { prompt: prev ? text.replace("PREV", prev) : text.replace("{{steps.PREV.output}}", "") });
  };

  return (
    <div className="inspector" data-testid="inspector">
      <h3>{kind === "agent" ? (d.title as string) || "Agent step" : titleFor(kind)}</h3>
      <div className="kind">{kind} node</div>

      {kind === "agent" && (
        <>
          <div className="field">
            <label>Step title</label>
            <input className="input" data-testid="f-title" type="text" value={(d.title as string) ?? ""} onChange={(e) => update(node.id, { title: e.target.value })} />
          </div>

          <div className="field">
            <label>Model</label>
            <div className="seg" data-testid="f-model">
              {MODELS.map((m) => (
                <button key={m} data-m={m} data-testid={`model-${m}`} className={d.model === m ? "active" : ""} onClick={() => update(node.id, { model: m })}>{m}</button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Prompt</label>
            <div className="preset-row" style={{ flexWrap: "wrap" }}>
              {PROMPT_PRESETS.map((p) => (
                <button key={p.label} className="preset" onClick={() => applyPrompt(p.text)}>{p.label}</button>
              ))}
            </div>
            <textarea data-testid="f-prompt" value={(d.prompt as string) ?? ""} onChange={(e) => update(node.id, { prompt: e.target.value })} placeholder="Tap a starter above, or write what this agent should do." />
            <div className="hint">Hand off with <code>{"{{steps.<id>.output}}"}</code>.</div>
          </div>

          <div className="field">
            <label>Tools it can use</label>
            <div className="preset-row">
              {TOOL_PRESETS.map((p) => (
                <button key={p.label} className="preset" onClick={() => update(node.id, { allowedTools: p.tools })}>{p.label}</button>
              ))}
            </div>
            <div className="chips">
              {TOOL_CHIPS.map((t) => (
                <button key={t} className={`tchip ${tools.includes(t) ? "on" : ""}`} onClick={() => toggleTool(t)}>{t}</button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Permission</label>
            <div className="select">
              <select value={(d.permissionMode as string) ?? "dontAsk"} onChange={(e) => update(node.id, { permissionMode: e.target.value })}>
                {PERMISSION_MODES.map((m) => <option key={m} value={m}>{permissionLabel(m)}</option>)}
              </select>
            </div>
            {d.permissionMode === "bypassPermissions" && <div className="danger-note">Bypasses all permission checks for this step.</div>}
          </div>

          <details className="disclosure">
            <summary>Advanced</summary>
            <div className="disc-body">
              <div className="field">
                <label>Effort</label>
                <div className="select">
                  <select value={(d.effort as string) ?? ""} onChange={(e) => update(node.id, { effort: e.target.value || undefined })}>
                    <option value="">inherit</option>
                    {["low", "medium", "high", "xhigh", "max"].map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
              </div>
              <div className="field">
                <label>Continue session from</label>
                <div className="select">
                  <select value={(d.continueFrom as string) ?? ""} onChange={(e) => update(node.id, { continueFrom: e.target.value || null })}>
                    <option value="">fresh context</option>
                    {upstream.map((n) => <option key={n.id} value={n.id}>{(n.data as { title?: string }).title || n.id}</option>)}
                  </select>
                </div>
              </div>
              <div className="field">
                <label>Working subdirectory</label>
                <input className="input" type="text" value={(d.cwd as string) ?? ""} onChange={(e) => update(node.id, { cwd: e.target.value })} placeholder="(project root)" />
              </div>
              <div className="field">
                <label>Custom tool patterns</label>
                <input className="input" type="text" value={tools.filter((t) => !TOOL_CHIPS.includes(t)).join(" ")}
                  onChange={(e) => {
                    const custom = e.target.value.split(/\s+/).filter(Boolean);
                    update(node.id, { allowedTools: [...tools.filter((t) => TOOL_CHIPS.includes(t)), ...custom] });
                  }} placeholder="e.g. Bash(npm *)" />
              </div>
            </div>
          </details>
        </>
      )}

      {kind === "wait" && (
        <>
          <div className="field">
            <label>When to continue</label>
            <div className="seg" data-testid="f-waitmode">
              {(["limitReset", "duration", "until"] as const).map((m) => (
                <button key={m} data-testid={`wait-${m}`} className={d.mode === m ? "active" : ""} onClick={() => update(node.id, { mode: m })}>
                  {m === "limitReset" ? "on reset" : m}
                </button>
              ))}
            </div>
            {d.mode === "limitReset" && <div className="hint">Holds until your Claude usage window resets, then resumes — the point of the whole thing.</div>}
          </div>
          {d.mode === "duration" && (
            <div className="field">
              <label>Wait for</label>
              <div className="preset-row">
                {WAIT_DURATIONS.map((w) => (
                  <button key={w.label} className={`preset ${d.minutes === w.minutes ? "on" : ""}`} onClick={() => update(node.id, { minutes: w.minutes })}>{w.label}</button>
                ))}
              </div>
              <input className="input" type="number" min={1} value={(d.minutes as number) ?? 60} onChange={(e) => update(node.id, { minutes: Number(e.target.value) })} />
            </div>
          )}
          {d.mode === "until" && (
            <div className="field">
              <label>Continue at (next occurrence)</label>
              <input className="input" type="text" value={(d.time as string) ?? "02:00"} onChange={(e) => update(node.id, { time: e.target.value })} placeholder="02:00" />
            </div>
          )}
        </>
      )}

      {kind === "approval" && (
        <div className="field">
          <label>Message when it pauses</label>
          <div className="preset-row" style={{ flexWrap: "wrap" }}>
            {["Review the diff before continuing.", "Approve before shipping.", "Check the plan looks right."].map((m, i) => (
              <button key={i} className="preset" onClick={() => update(node.id, { message: m })}>{["Review", "Ship", "Plan"][i]}</button>
            ))}
          </div>
          <textarea style={{ fontFamily: "var(--font-ui)", fontSize: 12.5, minHeight: 60 }} value={(d.message as string) ?? ""} onChange={(e) => update(node.id, { message: e.target.value })} />
        </div>
      )}

      {(kind === "start" || kind === "end") && <div className="hint">{kind === "start" ? "Where the run begins." : "Marks a finished branch."}</div>}

      {kind !== "start" && kind !== "end" && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn" onClick={dup}>Duplicate</button>
          <button className="btn danger" data-testid="delete-node" onClick={del}><IconTrash /> Delete</button>
        </div>
      )}
    </div>
  );
}

function titleFor(kind: string): string {
  return kind === "wait" ? "Wait" : kind === "approval" ? "Approval gate" : kind === "start" ? "Start" : "End";
}
function permissionLabel(m: string): string {
  return m === "dontAsk" ? "Deny unlisted tools (safe default)" : m === "acceptEdits" ? "Auto-accept edits" : m === "bypassPermissions" ? "Bypass all checks" : m === "plan" ? "Plan mode" : "Ask (default)";
}
/** Ancestors of `id`, ordered nearest-first (BFS over reversed edges) so callers can
 *  pick the immediate predecessor regardless of node-array insertion order. */
function ancestorsOf(id: string, nodes: { id: string; type?: string; data: unknown }[], edges: { source: string; target: string }[]) {
  const preds = new Map<string, string[]>();
  for (const e of edges) {
    if (!preds.has(e.target)) preds.set(e.target, []);
    preds.get(e.target)!.push(e.source);
  }
  const order: string[] = [];
  const seen = new Set<string>([id]);
  let frontier = [...(preds.get(id) ?? [])];
  while (frontier.length) {
    const next: string[] = [];
    for (const p of frontier) {
      if (seen.has(p)) continue;
      seen.add(p);
      order.push(p);
      for (const pp of preds.get(p) ?? []) if (!seen.has(pp)) next.push(pp);
    }
    frontier = next;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return order.map((i) => byId.get(i)!).filter(Boolean);
}
