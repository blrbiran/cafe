import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Copied from ccloop src/ownership/ownerLiveness.ts (parseLstartUtc, readProcessStart).
// PIDs are recycled, so a pid alone never identifies a process: pair it with its start time.

const execFileAsync = promisify(execFile);
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** `ps -o lstart=` under TZ=UTC prints e.g. "Fri Oct  2 04:05:03 2026" with no zone; read it as UTC, never as local time. */
export function parseLstartUtc(text: string): number | null {
  const match = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (match === null) return null;
  const month = MONTHS[match[1]!];
  if (month === undefined) return null;
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000;
}

/** The process's start time as `ps` prints it (read under TZ=UTC LC_ALL=C), or null when it is gone/unreadable. */
export async function readProcessStart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      timeout: 1_000,
      maxBuffer: 16 * 1024,
    });
    const text = stdout.trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/** "present" while any member of process group `pgid` exists. Copied from ccloop reapRunProcesses defaultProbe. */
export function probeGroup(pgid: number): "gone" | "present" | { error: string } {
  try {
    process.kill(-pgid, 0);
    return "present";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "gone" : code === "EPERM" ? "present" : { error: String(code) };
  }
}

export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // raced to exit
  }
}
