/**
 * Turn a failed `fetch` into a reason a person can act on (#83).
 *
 * Node's fetch (undici) throws `TypeError: fetch failed` and puts the real reason in `err.cause`
 * (sometimes an AggregateError with one error per address tried). Reading only `err.message`
 * collapsed "connection refused", "no such host", "timed out" and "certificate rejected" into
 * the same two words.
 */
export interface FetchFailure {
  /** A stable code the Web UI can translate: ECONNREFUSED, ENOTFOUND, ETIMEDOUT, a TLS code, … */
  code?: string;
  /** English explanation with the code in it, plus the next step where there is an obvious one. */
  error: string;
}

const TLS_CODE = /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|ERR_TLS_CERT_ALTNAME)/;

function causeOf(err: unknown): { code?: string; message?: string; name?: string } | undefined {
  let e = err as any;
  for (let i = 0; i < 4 && e; i++) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return { code: "ETIMEDOUT", name: e.name };
    if (typeof e.code === "string") return e;
    if (Array.isArray(e.errors) && e.errors.length) {
      const coded = e.errors.find((x: any) => typeof x?.code === "string");
      if (coded) return coded;
    }
    e = e.cause;
  }
  return undefined;
}

export function describeFetchError(err: unknown, target: string): FetchFailure {
  const cause = causeOf(err);
  const code = cause?.code === "UND_ERR_CONNECT_TIMEOUT" ? "ETIMEDOUT" : cause?.code === "UND_ERR_SOCKET" ? "ECONNRESET" : cause?.code;
  switch (code) {
    case "ECONNREFUSED":
      return {
        code,
        error: `connection refused (ECONNREFUSED): nothing is listening on ${target}. If that Host runs in Docker, use the container's address or publish the port on the machine`,
      };
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return { code: "ENOTFOUND", error: `host not found (${code}): ${target.replace(/:\d+$/, "")} does not resolve; check the name or use an IP address` };
    case "ETIMEDOUT":
      return { code, error: `timed out (ETIMEDOUT) reaching ${target}: the address may be wrong, or a firewall drops the traffic` };
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return { code, error: `no route to ${target} (${code}): this machine cannot reach that network` };
    case "ECONNRESET":
      return { code, error: `connection reset (ECONNRESET) by ${target}: something answered but closed the connection (wrong port or protocol?)` };
  }
  if (code && TLS_CODE.test(code)) {
    return { code, error: `TLS certificate rejected (${code}) for ${target}: ${cause?.message ?? "verification failed"}` };
  }
  if (code) return { code, error: `${cause?.message ?? (err as Error)?.message ?? "request failed"} (${code})` };
  return { error: (err as Error)?.message ?? String(err) };
}
