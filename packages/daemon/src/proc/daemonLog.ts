import { existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CappedLineFile, LOG_CAP_BYTES, logTruncatedMarker } from "./cappedLog.ts";

export interface DaemonLogOptions {
  version?: string;
  pid?: number;
  mode?: string;
  /** Test hook: shrink the cap instead of writing 16 MB. */
  capBytes?: number;
}

export function daemonLogPath(home: string): string {
  return join(home, "daemon.log");
}

/**
 * The daemon's own log writer (#66). Every line gets an ISO timestamp and the host, a start line
 * separates one cafe version from the next, and the file is capped (one `.1` generation kept) so a
 * long-running daemon cannot fill the disk. The daemon owns the file instead of handing stdout to
 * launchd/systemd, which is why service files point their own output at `daemon.stdout.log`.
 */
export function daemonLog(host: string, home: string, opts: DaemonLogOptions = {}): ((msg: string) => void) & { close(): void } {
  const cap = opts.capBytes ?? LOG_CAP_BYTES;
  const path = daemonLogPath(home);
  try {
    if (existsSync(path) && statSync(path).size > cap / 2) renameSync(path, `${path}.1`);
  } catch {
    // rotation is best effort
  }
  const file = new CappedLineFile(path, cap, logTruncatedMarker);
  const stamp = () => new Date().toISOString();
  const write = (line: string) => {
    try {
      file.write(Buffer.from(`${line}\n`, "utf8"));
    } catch {
      // a log write must never take the daemon down
    }
  };
  if (opts.version !== undefined) {
    write(`[${stamp()}] [cafe ${host}] starting cafe ${opts.version}${opts.pid !== undefined ? ` pid ${opts.pid}` : ""}${opts.mode ? ` mode ${opts.mode}` : ""}`);
  }
  const log = ((msg: string) => write(`[${stamp()}] [cafe ${host}] ${msg}`)) as ((msg: string) => void) & { close(): void };
  log.close = () => file.close();
  return log;
}