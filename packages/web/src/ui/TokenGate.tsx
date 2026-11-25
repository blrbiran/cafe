import { useState } from "react";
import { token, useToken } from "../api.ts";
import { useT } from "../i18n.ts";

/**
 * Shown instead of the app when the daemon refused this browser's token (#97): a page opened from
 * another device has no token, or a stale one. The token goes into this browser only.
 */
export function TokenGate() {
  const t = useT();
  const [value, setValue] = useState("");
  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-4">
      <form
        className="well flex w-full max-w-md flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) useToken(value);
        }}
      >
        <h1 className="m-0 text-base font-semibold text-fg-strong">{t.tokenGateTitle}</h1>
        <p className="m-0 text-sm text-muted">{t.tokenGateBody}</p>
        <div className="mono rounded border border-line bg-card px-2 py-1.5 text-xs text-fg-strong">cafe config get token</div>
        {token && (
          <p role="alert" className="m-0 text-sm text-danger">
            {t.tokenGateWrong}
          </p>
        )}
        <input
          type="password"
          autoComplete="off"
          autoFocus
          aria-label={t.tokenGatePlaceholder}
          placeholder={t.tokenGatePlaceholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="btn-primary self-start" disabled={!value.trim()}>
          {t.tokenGateSubmit}
        </button>
        <p className="m-0 text-xs text-muted">{t.tokenGateRemember}</p>
      </form>
    </main>
  );
}
