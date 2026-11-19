/** Turn a daemon HTTP error body into one human line, without repeating its code. */
export function formatApiError(body: { error?: unknown; message?: unknown }, status: number): string {
  const code = String(body.error ?? status);
  const message = String(body.message ?? "");
  if (!message) return code;
  return message.startsWith(code) ? message : `${code}: ${message}`;
}
