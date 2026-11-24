import type { Dict } from "./i18n.ts";

/** What the daemon says about a failed reachability check (#83). */
export interface HostProbe {
  verified?: boolean;
  code?: string;
  error?: string;
}

const TLS_CODE = /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

/** The plain-language reason, with the code kept at the end for whoever troubleshoots. */
function reason(t: Dict, p: HostProbe): string | undefined {
  if (!p.code) return undefined;
  const text = t.hostReasons[p.code] ?? (TLS_CODE.test(p.code) ? t.hostReasons.TLS : undefined);
  return text ? `${text} (${p.code})` : undefined;
}

/** "Unreachable: …" for the Test / Reconnect buttons. */
export function hostFailure(t: Dict, p: HostProbe): string {
  return `${t.hostUnreachable}: ${reason(t, p) ?? p.error ?? ""}`;
}

/** The note after saving an address: a warning when the hub could not reach it. */
export function savedAddressNote(t: Dict, p: HostProbe): { text: string; ok: boolean } {
  if (p.verified === false) return { text: t.hostAddressUnverified(reason(t, p) ?? p.error ?? t.hostUnreachable), ok: false };
  return { text: t.hostAddressSaved, ok: true };
}
