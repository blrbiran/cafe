import { useEffect, useState } from "react";
import { Shell } from "./Shell.tsx";
import { navigate, useRoute } from "./route.ts";
import { closeThread, openThread, useStore } from "./store.ts";
import { useT } from "./i18n.ts";
import { FeedPage } from "./pages/Feed.tsx";
import { ConversationPage } from "./pages/Conversation.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { NetworkPage } from "./pages/Network.tsx";
import { LivePage } from "./pages/Live.tsx";

export function App() {
  const t = useT();
  const route = useRoute();
  const error = useStore((s) => s.error);
  const loaded = useStore((s) => s.loaded);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const threadId = route.page === "thread" ? route.threadId : undefined;
  const from = route.page === "thread" ? (route.from ?? "all") : "all";

  useEffect(() => {
    if (threadId) void openThread(threadId);
    else closeThread();
  }, [threadId]);

  const closeDetail = () => {
    const id = threadId;
    navigate({ page: "feed", filter: from });
    // Put focus back on the card that opened the drawer.
    if (id) setTimeout(() => document.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)?.focus(), 0);
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

  return (
    <Shell
      route={route}
      detailOpen={!!threadId}
      settingsOpen={settingsOpen}
      onOpenSettings={() => setSettingsOpen(true)}
      onCloseSettings={() => setSettingsOpen(false)}
      onScrim={() => {
        setSettingsOpen(false);
        if (threadId) closeDetail();
      }}
      detail={
        threadId ? (
          <aside className="thread-drawer fixed inset-y-0 right-0 z-40 flex w-[min(780px,calc(100vw-180px))] flex-col border-l border-line bg-page shadow-float max-md:w-full" aria-label={t.navFeed}>
            <ConversationPage threadId={threadId} drawer onClose={closeDetail} />
          </aside>
        ) : undefined
      }
    >
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
      ) : route.page === "thread" ? (
        <FeedPage filter={from} />
      ) : (
        <FeedPage filter={route.filter} />
      )}
    </Shell>
  );
}