import { closeSync, constants, existsSync, fstatSync, ftruncateSync, openSync, renameSync, statSync, writeSync } from "node:fs";

// Adapted from ccloop src/runtime/streamLines.ts (CappedLineFile): positional writes through a kept-open
// descriptor (bytes are on disk when write() returns, so a SIGKILLed daemon loses nothing it accepted); when a
// chunk would pass the cap the file is cut back to the last complete line and a marker is written there.

export const LOG_CAP_BYTES = 16 * 1024 * 1024;
export const logTruncatedMarker = (atBytes: number): string =>
  `[cafe] log truncated at ${atBytes} bytes (cap reached); later output from this worker is discarded until it restarts\n`;

export class CappedLineFile {
  private readonly fd: number;
  private size: number;
  private lastLineEnd: number;
  private stopped = false;
  private closed = false;
  truncatedAt: number | null = null;

  private readonly cap: number;
  private readonly marker?: (atBytes: number) => string;

  constructor(path: string, cap: number, marker?: (atBytes: number) => string) {
    this.cap = cap;
    this.marker = marker;
    this.fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    this.size = fstatSync(this.fd).size;
    this.lastLineEnd = this.size;
  }

  write(chunk: Buffer): void {
    if (this.stopped || this.closed) return;
    try {
      if (this.size + chunk.length <= this.cap) {
        this.writeAt(chunk, this.size);
        const newline = chunk.lastIndexOf(10);
        if (newline >= 0) this.lastLineEnd = this.size + newline + 1;
        this.size += chunk.length;
        return;
      }
      const room = this.cap - this.size;
      const newline = room > 0 ? chunk.subarray(0, room).lastIndexOf(10) : -1;
      let end = this.lastLineEnd;
      if (newline >= 0) {
        this.writeAt(chunk.subarray(0, newline + 1), this.size);
        end = this.size + newline + 1;
      }
      this.stopped = true;
      this.truncatedAt = end;
      const marker = this.marker === undefined ? Buffer.alloc(0) : Buffer.from(this.marker(end), "utf8");
      if (marker.length > 0) this.writeAt(marker, end);
      ftruncateSync(this.fd, end + marker.length);
      this.size = end + marker.length;
    } catch (error) {
      this.stopped = true;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  get sizeBytes(): number {
    return this.size;
  }

  private writeAt(bytes: Buffer, position: number): void {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset, position + offset);
  }
}

/**
 * Open a worker log for a new launch. A log already past half the cap is rotated to `<path>.1` (one generation
 * kept), so restarts keep recent history without the file growing without bound.
 */
export function openWorkerLog(path: string, cap = LOG_CAP_BYTES): CappedLineFile {
  try {
    if (existsSync(path) && statSync(path).size > cap / 2) renameSync(path, `${path}.1`);
  } catch {
    // rotation is best effort
  }
  return new CappedLineFile(path, cap, logTruncatedMarker);
}
