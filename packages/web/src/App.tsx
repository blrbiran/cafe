import { useEffect, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import { authState } from "./auth.ts";
import { TokenGate } from "./ui/TokenGate.tsx";
import { PlainHttpBanner } from "./ui/Security.tsx";
import { Shell } from "./Shell.tsx";
import { navigate, useRoute } from "./route.ts";
import { closeThread, openThread, syncChannel, useStore } from "./store.ts";
import { useT } from "./i18n.ts";
import { FeedPage } from "./pages/Feed.tsx";
import { ConversationPage } from "./pages/Conversation.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { NetworkPage } from "./pages/Network.tsx";
import { LivePage } from "./pages/Live.tsx";
import { TeamsPage } from "./pages/Teams.tsx";

/** Keep an element mounted while it animates out, then unmount it. */
function usePresence(open: boolean, ms = 160): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const id = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, ms);
    return () => clearTimeout(id);
  }, [open, mounted, ms]);

  return { mounted, closing };
}

export function App() {
  const t = useT();
  const route = useRoute();
  const error = useStore((s) => s.error);
  const loaded = useStore((s) => s.loaded);
  const needsToken = useSyncExternalStore(authState.subscribe, () => authState.required);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const threadId = route.page === "thread" ? route.threadId : undefined;
  const from = route.page === "thread" ? (route.from ?? "all") : "all";
  const channel = route.page === "thread" ? (route.channel ?? "default") : route.page === "feed" ? route.channel : "default";

  // A direct link or refresh carries the channel in the URL; keep the store in step.
  useEffect(() => {
    if (route.page === "feed" || route.page === "thread") syncChannel(channel);
  }, [route.page, channel]);
  const detail = usePresence(!!threadId);
  const settings = usePresence(settingsOpen);
  // Remember the last Thread so the drawer still has content while it animates out.
  const [shownThreadId, setShownThreadId] = useState(threadId);

  useEffect(() => {
    if (threadId) {
      setShownThreadId(threadId);
      void openThread(threadId);
    }
  }, [threadId]);

  useEffect(() => {
    if (!detail.mounted) closeThread();
  }, [detail.mounted]);

  const closeDetail = () => {
    const id = threadId;
    navigate({ page: "feed", filter: from, channel });
    // Put focus back on the card that opened the drawer.
    if (id) setTimeout(() => document.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)?.focus(), 0);
  };

  /** Click on empty page space closes the open drawer, like the Settings scrim does. */
  const onBlankClick = (e: ReactMouseEvent<HTMLElement>) => {
    if (!threadId) return;
    const el = e.target as HTMLElement;
    if (el.closest('a,button,input,textarea,select,label,[role="link"],[data-thread-id]')) return;
    closeDetail();
  };

  useEffect(() => {
    if (settingsOpen || threadId) {
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (threadId) closeDetail();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
    return;
  }, [settingsOpen, threadId, from]);

  if (needsToken) return <TokenGate />;

  return (
    <Shell
      route={route}
      detailOpen={detail.mounted}
      settingsOpen={settings.mounted}
      settingsClosing={settings.closing}
      onOpenSettings={() => setSettingsOpen(true)}
      onCloseSettings={() => setSettingsOpen(false)}
      onBlankClick={onBlankClick}
      onScrim={() => {
        setSettingsOpen(false);
        if (threadId) closeDetail();
      }}
      detail={
        detail.mounted && shownThreadId ? (
          <aside
            className={`thread-drawer fixed inset-y-0 right-0 z-40 flex w-[min(780px,calc(100vw-180px))] flex-col border-l border-line bg-page shadow-float max-md:w-full ${detail.closing ? "is-closing" : ""}`}
            aria-label={t.navFeed}
          >
            <ConversationPage threadId={shownThreadId} drawer onClose={closeDetail} />
          </aside>
        ) : undefined
      }
    >
      <PlainHttpBanner
        onHowTo={() => {
          setSettingsOpen(true);
          // Open the trust steps in the Settings drawer once it has rendered.
          setTimeout(() => {
            const d = document.querySelector<HTMLDetailsElement>("#encrypted-access details");
            if (d) d.open = true;
            document.getElementById("encrypted-access")?.scrollIntoView({ block: "start" });
          }, 50);
        }}
      />
      {error && (
        <div role="alert" className="well text-sm" data-tone="danger">
          {error}
        </div>
      )}
      {!loaded ? (
        <div className="hint">{t.loading}</div>
      ) : route.page === "agents" ? (
        <AgentsPage />
      ) : route.page === "network" ? (
        <NetworkPage />
      ) : route.page === "live" ? (
        <LivePage />
      ) : route.page === "teams" ? (
        <TeamsPage />
      ) : route.page === "thread" ? (
        <FeedPage filter={from} channel={channel} />
      ) : (
        <FeedPage filter={route.filter} channel={route.channel} />
      )}
    </Shell>
  );
}