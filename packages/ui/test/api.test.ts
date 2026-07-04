import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../src/api";

afterEach(() => vi.restoreAllMocks());

function mockFetchOnce(status: number, body: unknown, statusText = "S") {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response;
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
}

describe("api client", () => {
  it("returns parsed json on success", async () => {
    mockFetchOnce(200, { ok: true, version: "1.2.3" });
    expect(await api.health()).toEqual({ ok: true, version: "1.2.3" });
  });

  it("throws the server's {error} message on failure", async () => {
    mockFetchOnce(400, { error: "cross-origin request blocked" });
    await expect(api.saveWorkflow({} as never)).rejects.toThrow("cross-origin request blocked");
  });

  it("falls back to statusText when the error body has no message", async () => {
    mockFetchOnce(500, {}, "Internal Server Error");
    await expect(api.getRun("x")).rejects.toThrow("Internal Server Error");
  });

  it("encodes the workflow name in newWorkflow", async () => {
    const spy = mockFetchOnce(200, { nocturne: 1 });
    await api.newWorkflow("a b&c");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("name=a%20b%26c"), expect.anything());
  });

  it("posts the retrace request and returns suggestions", async () => {
    const spy = mockFetchOnce(200, { suggestions: [], sessionsScanned: 0, windowHours: 24, cost: 0 });
    const res = await api.suggest({ hours: 24, max: 5 });
    expect(res.windowHours).toBe(24);
    expect(spy).toHaveBeenCalledWith("/api/suggest", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ hours: 24, max: 5 });
  });
});
