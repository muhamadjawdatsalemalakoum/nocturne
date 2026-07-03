import { buildDag, findCycle, topoSort, unreachableNodes } from "./dag.js";
import { extractRefs } from "./template.js";
import { workflowSchema, type Workflow } from "./schema.js";

export interface Issue {
  code: string;
  message: string;
  nodeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

/** True for Windows drive paths, UNC paths, and POSIX absolute paths. */
export function isAbsolutePathLike(p: string): boolean {
  if (!p) return false;
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith("/");
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["anthropic-key", /sk-ant-[a-zA-Z0-9_-]{10,}/],
  ["openai-key", /sk-[a-zA-Z0-9]{20,}/],
  ["aws-access-key", /AKIA[0-9A-Z]{16}/],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["bearer-token", /bearer\s+[a-zA-Z0-9._-]{20,}/i],
];

/**
 * Collect ancestors (transitive predecessors) of every node.
 * Only called for acyclic graphs (callers guard on findCycle), so a topological
 * pass is well-defined and order-independent: ancestors(n) = ∪ over preds p of {p} ∪ ancestors(p).
 */
function ancestorMap(wf: Pick<Workflow, "nodes" | "edges">): Map<string, Set<string>> {
  const { predecessors } = buildDag(wf);
  const out = new Map<string, Set<string>>();
  for (const id of topoSort(wf)) {
    const acc = new Set<string>();
    for (const p of predecessors.get(id) ?? []) {
      acc.add(p);
      for (const a of out.get(p) ?? []) acc.add(a);
    }
    out.set(id, acc);
  }
  return out;
}

/**
 * Full validation: schema + graph structure + portability.
 * `parsed` is the schema-validated workflow (throws earlier if schema fails).
 */
export function validateWorkflow(input: unknown): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const parse = workflowSchema.safeParse(input);
  if (!parse.success) {
    for (const iss of parse.error.issues) {
      errors.push({ code: "schema", message: `${iss.path.join(".") || "(root)"}: ${iss.message}` });
    }
    return { ok: false, errors, warnings };
  }
  const wf = parse.data;

  if (wf.nocturne > 1) {
    errors.push({
      code: "version",
      message: `Unsupported format version ${wf.nocturne} (this build understands up to 1)`,
    });
  }

  // ---- structural ----
  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) errors.push({ code: "dup-id", message: `Duplicate node id "${n.id}"`, nodeId: n.id });
    ids.add(n.id);
  }
  for (const e of wf.edges) {
    if (!ids.has(e.source)) errors.push({ code: "dangling-edge", message: `Edge "${e.id}" source "${e.source}" does not exist` });
    if (!ids.has(e.target)) errors.push({ code: "dangling-edge", message: `Edge "${e.id}" target "${e.target}" does not exist` });
  }

  const starts = wf.nodes.filter((n) => n.type === "start");
  const ends = wf.nodes.filter((n) => n.type === "end");
  if (starts.length !== 1) errors.push({ code: "start", message: `Workflow must have exactly one start node (found ${starts.length})` });
  if (ends.length < 1) errors.push({ code: "end", message: "Workflow must have at least one end node" });

  const cycle = findCycle(wf);
  if (cycle.length) {
    errors.push({ code: "cycle", message: `Graph contains a cycle: ${cycle.join(" -> ")}` });
  }

  // reachability (only meaningful when acyclic and a start exists)
  if (!cycle.length && starts.length === 1) {
    const unreachable = unreachableNodes(wf);
    for (const id of unreachable) {
      warnings.push({ code: "unreachable", message: `Node "${id}" is not reachable from start`, nodeId: id });
    }
    const reachableEnd = ends.some((e) => !unreachable.includes(e.id));
    if (ends.length && !reachableEnd) {
      errors.push({ code: "end-unreachable", message: "No end node is reachable from start" });
    }
  }

  // ---- per-node: portability + templates ----
  const ancestors = cycle.length ? new Map<string, Set<string>>() : ancestorMap(wf);
  const paramNames = new Set(wf.params.map((p) => p.name));

  // secret scan is best-effort — cover every field that gets serialized/shared, not
  // just agent prompts (a secret in a param default or approval message leaks too).
  const scanSecret = (text: string, where: string, nodeId?: string) => {
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(text)) {
        warnings.push({ code: "secret", message: `${where} appears to contain a ${name}; remove before sharing`, nodeId });
      }
    }
  };
  for (const p of wf.params) {
    scanSecret(p.default, `Param "${p.name}" default`);
    scanSecret(p.description, `Param "${p.name}" description`);
  }

  for (const n of wf.nodes) {
    if (n.type === "approval") scanSecret((n.data as { message: string }).message, `Approval "${n.id}" message`, n.id);
    if (n.type !== "agent") continue;
    const d = n.data;

    if (isAbsolutePathLike(d.cwd)) {
      errors.push({ code: "abs-path", message: `Node "${n.id}" cwd must be relative (got "${d.cwd}")`, nodeId: n.id });
    }
    if (d.cwd.includes("..")) {
      warnings.push({ code: "cwd-escape", message: `Node "${n.id}" cwd escapes the project root ("${d.cwd}")`, nodeId: n.id });
    }

    scanSecret(d.prompt, `Node "${n.id}" prompt`, n.id);

    if (d.continueFrom) {
      const contNode = wf.nodes.find((x) => x.id === d.continueFrom);
      if (!contNode) {
        errors.push({ code: "bad-continue", message: `Node "${n.id}" continueFrom "${d.continueFrom}" does not exist`, nodeId: n.id });
      } else if (contNode.type !== "agent") {
        errors.push({ code: "bad-continue", message: `Node "${n.id}" continueFrom "${d.continueFrom}" must reference an agent step (only agents have a session)`, nodeId: n.id });
      } else if (!cycle.length && !(ancestors.get(n.id)?.has(d.continueFrom))) {
        errors.push({ code: "bad-continue", message: `Node "${n.id}" continueFrom "${d.continueFrom}" is not an upstream step`, nodeId: n.id });
      }
    }

    const refs = extractRefs(d.prompt);
    const anc = ancestors.get(n.id) ?? new Set<string>();
    for (const ref of refs) {
      if (ref.root === "params") {
        const pname = ref.parts[1];
        if (!pname || ref.parts.length !== 2 || !paramNames.has(pname)) {
          errors.push({ code: "bad-ref", message: `Node "${n.id}" references unknown param {{${ref.raw}}}`, nodeId: n.id });
        }
      } else if (ref.root === "steps") {
        const target = ref.parts[1];
        if (ref.parts[2] !== "output" || ref.parts.length !== 3 || !target) {
          errors.push({ code: "bad-ref", message: `Node "${n.id}" has malformed step ref {{${ref.raw}}}`, nodeId: n.id });
        } else if (!ids.has(target)) {
          errors.push({ code: "bad-ref", message: `Node "${n.id}" references output of missing node {{${ref.raw}}}`, nodeId: n.id });
        } else if (!cycle.length && !anc.has(target)) {
          errors.push({ code: "bad-ref", message: `Node "${n.id}" references {{${ref.raw}}} which is not upstream of it`, nodeId: n.id });
        }
      } else if (ref.root === "workflow") {
        if (ref.parts.length !== 2 || !["name", "description", "id"].includes(ref.parts[1] ?? "")) {
          errors.push({ code: "bad-ref", message: `Node "${n.id}" references unknown field {{${ref.raw}}}`, nodeId: n.id });
        }
      } else if (ref.root === "run") {
        if (ref.parts.length !== 2 || ref.parts[1] !== "projectRoot") {
          errors.push({ code: "bad-ref", message: `Node "${n.id}" references unknown field {{${ref.raw}}}`, nodeId: n.id });
        }
      } else {
        errors.push({ code: "bad-ref", message: `Node "${n.id}" references unknown root {{${ref.raw}}}`, nodeId: n.id });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
