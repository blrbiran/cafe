import { constants } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectorStatusRow } from "@cafe/protocol";

const TAIL_BYTES = 64 * 1024;
const STALE_MS = 75_000;
const connectionStates = new Set(["connecting", "connected", "disconnected"]);

type RunState = { status?: string; pid?: number; childPid?: number; startedAt?: number };
type Heartbeat = { type: string; at: number; pid?: number; ok?: boolean; intervalMs?: number; connection?: "connecting" | "connected" | "disconnected" };

function alive(pid?: number): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lastHeartbeat(path: string, run: RunState): Promise<Heartbeat | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return;
      const offset = Math.max(0, stat.size - TAIL_BYTES);
      const buffer = Buffer.alloc(stat.size - offset);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
      if (offset) lines.shift();
      for (const line of lines.reverse()) {
        if (!line.startsWith("{")) continue;
        try {
          const beat: Heartbeat = JSON.parse(line);
          if (beat?.type !== "heartbeat" || !Number.isFinite(beat.at) || beat.at < (run.startedAt ?? 0)) continue;
          if (beat.pid === run.childPid || (beat.pid === undefined && beat.connection === undefined)) return beat;
        } catch {
          // The connector can be writing the line while we read it.
        }
      }
    } finally {
      await file.close();
    }
  } catch {
    // A connector that has never run has no log.
  }
}

async function stateOf(home: string, name: string): Promise<ConnectorStatusRow["state"]> {
  let run: RunState;
  try {
    run = JSON.parse(await readFile(join(home, "connector-data", name, "run.json"), "utf8")) ?? {};
  } catch {
    return "stopped";
  }
  if (run.status === "crashed") return "crashed";
  if (run.status !== "running") return "stopped";
  if (!alive(run.pid)) return "crashed";
  if (!alive(run.childPid)) return "connecting";
  const beat = await lastHeartbeat(join(home, "logs", `connector-${name}.log`), run);
  if (!beat) return name === "discord" ? "connecting" : "running";
  const interval = beat.intervalMs;
  const maxAge = typeof interval === "number" && Number.isFinite(interval) && interval > 0
    ? Math.max(STALE_MS, interval * 2.5)
    : STALE_MS;
  if (beat.ok === false || (interval !== 0 && Date.now() - beat.at > maxAge)) return "disconnected";
  if (beat.connection && connectionStates.has(beat.connection)) return beat.connection;
  return "running";
}

/** A local Host's read-only connector list. Keep config, raw logs and process details out of the API. */
export async function connectorStatuses(home: string): Promise<ConnectorStatusRow[]> {
  const entries = await readdir(join(home, "connectors"), { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const result: ConnectorStatusRow[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && /^[a-zA-Z0-9_.-]+$/.test(entry.name)) {
      result.push({ name: entry.name, state: await stateOf(home, entry.name) });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
