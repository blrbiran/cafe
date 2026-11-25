import { useEffect, useState } from "react";
import { api, token } from "../api.ts";
import { useT } from "../i18n.ts";
import { pageSecurity, type PageSecurity } from "../security.ts";

/**
 * "Which part is encrypted" for the page itself (v4-9, Q120). The TLS port serves the same Web UI,
 * so a plain-HTTP page opened over the network can point at `https://<same host>:<tls port>/`.
 * `/api/tls` is public, so this works before the person has entered a token.
 */
type TlsInfo = { fingerprint256: string | null; tlsPort?: number; web?: string[] };
let tlsInfo: Promise<TlsInfo> | undefined;
const loadTls = () => (tlsInfo ??= api.tls().catch(() => ({ fingerprint256: null })));

export function usePageSecurity(): { sec: PageSecurity; tls?: TlsInfo } {
  const [tls, setTls] = useState<TlsInfo>();
  useEffect(() => {
    let live = true;
    void loadTls().then((x) => live && setTls(x));
    return () => {
      live = false;
    };
  }, []);
  return { sec: pageSecurity(location, { tlsPort: tls?.tlsPort, https: tls?.web }, token), tls };
}

const DISMISS_KEY = "cafe.plainBannerDismissed";
function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** One line above the content on a plain-HTTP page that crosses the network. */
export function PlainHttpBanner({ onHowTo }: { onHowTo: () => void }) {
  const t = useT();
  const { sec } = usePageSecurity();
  const [hidden, setHidden] = useState(dismissed);
  if (sec.encrypted || sec.loopback || hidden) return null;
  return (
    <div role="status" className="well flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-tone="warn">
      <span>{t.secBanner}</span>
      {sec.httpsUrl && (
        <a className="linkbtn" href={sec.httpsUrl}>
          {t.secOpenEncrypted}
        </a>
      )}
      <button type="button" className="linkbtn" onClick={onHowTo}>
        {t.secHowTrust}
      </button>
      <button
        type="button"
        className="linkbtn ml-auto"
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, "1");
          } catch {
            // Hidden for this load only.
          }
          setHidden(true);
        }}
      >
        {t.secDismiss}
      </button>
    </div>
  );
}

export function TrustSteps({ fingerprint, open }: { fingerprint?: string | null; open?: boolean }) {
  const t = useT();
  return (
    <details className="text-xs" open={open}>
      <summary className="cursor-pointer text-fg-strong">{t.secTrustSteps}</summary>
      <div className="mt-2 flex flex-col gap-1.5 text-muted">
        <a className="linkbtn self-start" href="/ca.crt" download="cafe-ca.crt">
          {t.secDownloadCa}
        </a>
        {fingerprint && (
          <span>
            {t.secFingerprint}: <code className="mono break-all text-fg-strong">{fingerprint}</code>
          </span>
        )}
        <span>{t.secFingerprintCheck}</span>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
          <li>{t.secTrustMac}</li>
          <li>{t.secTrustIos}</li>
          <li>{t.secTrustWin}</li>
          <li>{t.secTrustAndroid}</li>
          <li>{t.secTrustFirefox}</li>
        </ul>
        <span>{t.secTrustScope}</span>
        <span>{t.secTrustNote}</span>
      </div>
    </details>
  );
}

/** Settings section: is this page encrypted, the encrypted addresses, and how to trust the CA. */
export function EncryptedAccess({ trustOpen }: { trustOpen?: boolean }) {
  const t = useT();
  const { sec, tls } = usePageSecurity();
  const https = tls?.web;
  const [copied, setCopied] = useState<string>();
  const page = sec.encrypted ? t.secPageEncrypted : sec.loopback ? t.secPageLoopback : t.secPagePlain;
  return (
    <section id="encrypted-access" className="mb-5 border-b border-line pb-4">
      <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.secTitle}</h3>
      <p className="mt-1 mb-2 text-xs text-muted">{t.secDesc}</p>
      <div className="well flex flex-col gap-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">{t.secThisPage}</span>
          <span className={sec.encrypted || sec.loopback ? "text-fg-strong" : "text-warn"}>{page}</span>
        </div>
        {tls && !tls.tlsPort ? (
          <span className="text-muted">{t.secTlsOff}</span>
        ) : tls && !tls.web ? (
          <span className="text-muted">{t.secNotOnNetwork}</span>
        ) : (
          <>
            {https && !https.length && <span className="text-muted">{t.secNoAddress}</span>}
            {!!https?.length && (
              <div className="flex flex-col gap-1.5">
                <span className="text-muted">{t.secAddresses}</span>
                {https.map((u) => (
                  <div key={u} className="flex items-center justify-between gap-2">
                    <code className="mono break-all text-fg-strong">{u}</code>
                    <button type="button" className="btn-sm shrink-0 whitespace-nowrap" onClick={() => void navigator.clipboard?.writeText(u).then(() => setCopied(u), () => {})}>
                      {copied === u ? t.copied : t.secCopy}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <TrustSteps fingerprint={tls?.fingerprint256} open={trustOpen} />
          </>
        )}
      </div>
    </section>
  );
}
