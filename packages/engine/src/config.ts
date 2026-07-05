import { promises as fs } from "node:fs";
import path from "node:path";
import { nocturneHome } from "./store.js";
import { DEFAULT_CONFIG, type EngineConfig } from "./types.js";

export function configPath(home = nocturneHome()): string {
  return path.join(home, "config.json");
}

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Clamp/validate a parsed config so a bad type or value can never poison the engine. */
export function sanitizeConfig(input: Partial<EngineConfig>): EngineConfig {
  return {
    claudePath: str(input.claudePath) ?? DEFAULT_CONFIG.claudePath,
    maxConcurrent: Math.max(1, Math.floor(num(input.maxConcurrent, DEFAULT_CONFIG.maxConcurrent))),
    defaultLimitWaitMinutes: Math.max(0, num(input.defaultLimitWaitMinutes, DEFAULT_CONFIG.defaultLimitWaitMinutes)),
    autoResumeOnStart: typeof input.autoResumeOnStart === "boolean" ? input.autoResumeOnStart : DEFAULT_CONFIG.autoResumeOnStart,
    webhookUrl: str(input.webhookUrl),
    oauthToken: str(input.oauthToken),
    lan: input.lan === true,
    pairingToken: str(input.pairingToken),
    remote: input.remote === true,
    remoteSecret: str(input.remoteSecret),
    remoteRelays:
      Array.isArray(input.remoteRelays) && input.remoteRelays.every((r) => typeof r === "string" && r.startsWith("wss://"))
        ? input.remoteRelays
        : undefined,
  };
}

export async function loadConfig(home = nocturneHome()): Promise<EngineConfig> {
  try {
    const raw = await fs.readFile(configPath(home), "utf8");
    return sanitizeConfig(JSON.parse(raw) as Partial<EngineConfig>);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(cfg: EngineConfig, home = nocturneHome()): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(configPath(home), JSON.stringify(sanitizeConfig(cfg), null, 2), "utf8");
}
