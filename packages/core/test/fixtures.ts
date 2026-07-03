import type { Workflow } from "../src/index.js";

/** A minimal valid linear workflow: start -> a -> b -> end. */
export function linearWorkflow(): Workflow {
  return {
    nocturne: 1,
    id: "wf-linear",
    name: "Linear",
    description: "",
    params: [{ name: "ticket", description: "", default: "" }],
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 } },
      {
        id: "a",
        type: "agent",
        position: { x: 200, y: 0 },
        data: {
          title: "Analyze",
          prompt: "Analyze ticket {{params.ticket}}",
          model: "haiku",
          cwd: "",
          allowedTools: [],
          permissionMode: "dontAsk",
          continueFrom: null,
          retry: { max: 1, backoffSec: 60 },
          outputSchema: null,
        },
      },
      {
        id: "b",
        type: "agent",
        position: { x: 400, y: 0 },
        data: {
          title: "Fix",
          prompt: "Given {{steps.a.output}} implement the fix",
          model: "sonnet",
          cwd: "src",
          allowedTools: ["Edit", "Write"],
          permissionMode: "dontAsk",
          continueFrom: null,
          retry: { max: 1, backoffSec: 60 },
          outputSchema: null,
        },
      },
      { id: "end", type: "end", position: { x: 600, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "b" },
      { id: "e3", source: "b", target: "end" },
    ],
  };
}

/** Diamond: start -> a -> {b,c} -> d(join) -> end. */
export function diamondWorkflow(): Workflow {
  const mkAgent = (id: string, title: string, prompt: string) =>
    ({
      id,
      type: "agent" as const,
      position: { x: 0, y: 0 },
      data: {
        title,
        prompt,
        model: "haiku" as const,
        cwd: "",
        allowedTools: [],
        permissionMode: "dontAsk" as const,
        continueFrom: null,
        retry: { max: 1, backoffSec: 60 },
        outputSchema: null,
      },
    });
  return {
    nocturne: 1,
    id: "wf-diamond",
    name: "Diamond",
    description: "",
    params: [],
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 } },
      mkAgent("a", "A", "start"),
      mkAgent("b", "B", "branch b from {{steps.a.output}}"),
      mkAgent("c", "C", "branch c from {{steps.a.output}}"),
      mkAgent("d", "D", "join {{steps.b.output}} and {{steps.c.output}}"),
      { id: "end", type: "end", position: { x: 0, y: 0 } } as Workflow["nodes"][number],
    ],
    edges: [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "b" },
      { id: "e3", source: "a", target: "c" },
      { id: "e4", source: "b", target: "d" },
      { id: "e5", source: "c", target: "d" },
      { id: "e6", source: "d", target: "end" },
    ],
  } as unknown as Workflow;
}
