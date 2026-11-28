import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { Attachment } from "@cafe/protocol";
import type { DaemonRequest } from "./daemon-http.ts";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

/** Upload one file to a daemon; the returned metadata goes on an Order or reply. */
export async function uploadAttachment(base: string, file: string, token?: string, request: DaemonRequest = (path, init) => fetch(`${base}${path}`, { ...init, redirect: "error" })): Promise<Attachment> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`cannot read ${file}`);
  const name = basename(path);
  const mime = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await request(`/api/artifacts?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, {
    method: "POST",
    body: readFileSync(path),
    headers,
  });
  const body = (await res.json().catch(() => ({}))) as { attachment?: Attachment; error?: string; message?: string };
  if (!res.ok || !body.attachment) throw new Error(`upload ${file} failed: ${body.error ?? res.status}: ${body.message ?? ""}`.trim());
  return body.attachment;
}

export const ATTACH_MARKER = "CAFE_ATTACH:";

/**
 * A Barista's stdout / final text can carry files with lines like
 * `CAFE_ATTACH: /abs/path.log`. They are removed from the text and uploaded; the
 * reply carries metadata only (v4-1 phase 2).
 */
export function parseAttachMarkers(text: string): { text: string; files: string[] } {
  const files: string[] = [];
  const kept = text.split("\n").filter((line) => {
    const m = /^\s*CAFE_ATTACH:\s*(.+?)\s*$/.exec(line);
    if (!m) return true;
    files.push(m[1]!);
    return false;
  });
  return { text: kept.join("\n").trim(), files };
}

export async function extractAttachments(base: string, text: string, token?: string): Promise<{ text: string; attachments: Attachment[] }> {
  const parsed = parseAttachMarkers(text);
  const attachments: Attachment[] = [];
  for (const f of parsed.files) attachments.push(await uploadAttachment(base, f, token));
  return { text: parsed.text, attachments };
}