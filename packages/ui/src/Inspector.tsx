import { useState } from "react";
import { useStore } from "./store";
import { IconTrash } from "./icons";
import { PROMPT_PRESETS, TOOL_PRESETS, TOOL_CHIPS, WAIT_DURATIONS } from "./templates";
import { STEP_CATEGORIES, searchSteps, type LibraryStep } from "./steps";

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
  const [libOpen, setLibOpen] = useState(false);
  const [libQ, setLibQ] = useState("");
  const [libCat, setLibCat] = useState<string | undefined>(undefined);

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
          <label>Run inputs</label>
          <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
            Things you fill in when you press Run — use <code>{"{{params.name}}"}</code> in any prompt.
          </div>
          {meta.params.length === 0 && (
            <div className="params-empty">No inputs yet — add one if a prompt should ask for something at run time (a ticket id, a topic, a branch…).</div>
          )}
          {meta.params.map((p, i) => (
            <div className="param-row" key={i} data-testid={`param-row-${i}`}>
              <div className="pr-head">
                <input
                  className="input pr-name" type="text" value={p.name} placeholder="name"
                  spellCheck={false}
                  onChange={(e) => {
                    const name = e.target.value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1");
                    setMeta({ params: meta.params.map((q, j) => (j === i ? { ...q, name } : q)) });
                  }}
                />
                <button className="panel-toggle" title="Remove input" onClick={() => setMeta({ params: meta.params.filter((_, j) => j !== i) })}>
                  <IconTrash />
                </button>
              </div>
              <input
                className="input pr-sub" type="text" value={p.description} placeholder="what is this? (shown at run time)"
                onChange={(e) => setMeta({ params: meta.params.map((q, j) => (j === i ? { ...q, description: e.target.value } : q)) })}
              />
              <input
                className="input pr-sub" type="text" value={p.default} placeholder="default value (optional)"
                onChange={(e) => setMeta({ params: meta.params.map((q, j) => (j === i ? { ...q, default: e.target.value } : q)) })}
              />
              {meta.params.some((q, j) => j !== i && q.name === p.name && p.name) && (
                <div className="danger-note">Duplicate name — the later one wins. Rename it.</div>
              )}
            </div>
          ))}
          <button
            className="btn" data-testid="add-param" style={{ marginTop: 6 }}
            onClick={() => setMeta({ params: [...meta.params, { name: `input_${meta.params.length + 1}`, description: "", default: "" }] })}
          >
            + Add input
          </button>
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
            <label>Runs</label>
            <div className="stepper" data-testid="f-repeat">
              <button aria-label="fewer runs" onClick={() => update(node.id, { repeat: Math.max(1, ((d.repeat as number) ?? 1) - 1) })}>−</button>
              <span className="mono">{((d.repeat as number) ?? 1)}×</span>
              <button aria-label="more runs" onClick={() => update(node.id, { repeat: Math.min(20, ((d.repeat as number) ?? 1) + 1) })}>+</button>
              {((d.repeat as number) ?? 1) > 1 && (
                <span className="hint" style={{ margin: 0 }}>runs {(d.repeat as number)} times, outputs joined</span>
              )}
            </div>
          </div>

          <div className="field">
            <label>Prompt</label>
            <div className="preset-row" style={{ flexWrap: "wrap" }}>
              {PROMPT_PRESETS.map((p) => (
                <button key={p.label} className="preset" onClick={() => applyPrompt(p.text)}>{p.label}</button>
              ))}
              <button className="preset lib" data-testid="steps-lib-btn" onClick={() => setLibOpen(true)}>Library…</button>
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

      {kind === "condition" && (
        <>
          <div className="field">
            <label>Check</label>
            <div className="select">
              <select
                data-testid="cond-left"
                value={(d.left as string) ?? ""}
                onChange={(e) => update(node.id, { left: e.target.value })}
              >
                <option value="" disabled>what to look at…</option>
                {upstream.map((u) => (
                  <option key={u.id} value={`{{steps.${u.id}.output}}`}>
                    output of “{(u.data as { title?: string }).title || u.id}”
                  </option>
                ))}
                {meta.params.map((p) => (
                  <option key={p.name} value={`{{params.${p.name}}}`}>param “{p.name}”</option>
                ))}
              </select>
            </div>
            {upstream.length === 0 && meta.params.length === 0 && (
              <div className="hint">Connect an agent step into this condition first — then its output appears here.</div>
            )}
          </div>
          <div className="field">
            <label>Condition</label>
            <div className="select">
              <select data-testid="cond-op" value={(d.op as string) ?? "contains"} onChange={(e) => update(node.id, { op: e.target.value })}>
                <option value="contains">contains</option>
                <option value="not_contains">does not contain</option>
                <option value="equals">equals</option>
                <option value="not_equals">does not equal</option>
                <option value="matches">matches regex</option>
                <option value="not_empty">is not empty</option>
                <option value="gt">is greater than</option>
                <option value="lt">is less than</option>
              </select>
            </div>
          </div>
          {d.op !== "not_empty" && (
            <div className="field">
              <label>Value</label>
              <input className="input" data-testid="cond-value" type="text" value={(d.value as string) ?? ""} onChange={(e) => update(node.id, { value: e.target.value })} placeholder={d.op === "matches" ? "a regular expression" : "text to compare against"} />
            </div>
          )}
          <div className="hint">
            Wire the <strong style={{ color: "var(--done)" }}>✓ true</strong> handle to what happens when this holds, and{" "}
            <strong style={{ color: "var(--failed)" }}>✕ false</strong> to the other path. The untaken branch is skipped.
          </div>
        </>
      )}

      {(kind === "start" || kind === "end") && <div className="hint">{kind === "start" ? "Where the run begins." : "Marks a finished branch."}</div>}

      {kind !== "start" && kind !== "end" && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn" onClick={dup}>Duplicate</button>
          <button className="btn danger" data-testid="delete-node" onClick={del}><IconTrash /> Delete</button>
        </div>
      )}

      {libOpen && (
        <div className="overlay" onClick={() => setLibOpen(false)}>
          <div className="modal wide steps-lib" onClick={(e) => e.stopPropagation()} data-testid="steps-lib">
            <h2>Steps library</h2>
            <div className="sub">Industry-standard steps for every kind of work — pick one, then make it yours.</div>
            <input
              className="input" autoFocus placeholder="Search: DRY, pivot, postmortem, SEO, executive summary…"
              value={libQ} onChange={(e) => setLibQ(e.target.value)} data-testid="steps-search"
            />
            <div className="lib-cats">
              <button className={`preset ${!libCat ? "on" : ""}`} onClick={() => setLibCat(undefined)}>All</button>
              {STEP_CATEGORIES.map((c) => (
                <button key={c} className={`preset ${libCat === c ? "on" : ""}`} onClick={() => setLibCat(libCat === c ? undefined : c)}>{c}</button>
              ))}
            </div>
            <div className="lib-list">
              {searchSteps(libQ, libCat).map((s: LibraryStep) => (
                <button
                  key={s.id} className="lib-item" data-testid={`lib-${s.id}`}
                  onClick={() => {
                    update(node.id, {
                      prompt: s.prompt,
                      title: s.title,
                      ...(s.model ? { model: s.model } : {}),
                      ...(s.tools ? { allowedTools: s.tools } : {}),
                    });
                    setLibOpen(false);
                  }}
                >
                  <span className="li-top">
                    <strong>{s.title}</strong>
                    {s.standard && <span className="chip">{s.standard}</span>}
                    <span className="li-cat">{s.category}</span>
                  </span>
                  <span className="li-preview">{s.prompt.slice(0, 130)}…</span>
                </button>
              ))}
              {searchSteps(libQ, libCat).length === 0 && <div className="hint">Nothing matches — try fewer words.</div>}
            </div>
            <div className="actions"><button className="btn ghost" onClick={() => setLibOpen(false)}>Close</button></div>
          </div>
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
