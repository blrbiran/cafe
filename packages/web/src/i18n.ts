import { useSyncExternalStore } from "react";

export type Lang = "zh" | "en";

const zh = {
  thisMachine: "本机",
  hub: "中心节点",
  liveHubOnline: "实时更新中 · 中心节点在线",
  liveHubOffline: "实时更新中 · 中心节点离线",
  liveIsHub: "实时更新中",
  reconnecting: "连接中断，正在重连…",
  language: "语言",
  theme: "主题",
  themeDark: "深色",
  themeLight: "浅色",
  themeSystem: "跟随系统",
  navFeed: "问答",
  navAgents: "Agents",
  navNetwork: "网络",
  loading: "加载中…",

  feedTitle: "问答",
  feedSub: "发到网络上的每个问题，谁在处理、谁回答了、答了什么。",
  ask: "提问",
  yourQuestion: "你的问题",
  qPlaceholder: "写清楚问题并附上上下文：文件路径、报错信息、你已经试过什么。对方看不到你的会话。",
  sendTo: "交给谁",
  autoPick: "自动选择（推荐）",
  autoPickHint: "自动选择：系统会根据每个 agent 声明的职责挑最合适的一个；拿不准时会问所有人。",
  cancel: "取消",
  send: "发送",
  sending: "发送中…",
  fAll: "全部",
  fActive: "进行中",
  fAnswered: "已回答",
  fUnanswered: "没人能答",
  inProgress: "进行中",
  recent: "最近",
  askedVerb: "提问",
  why: "为什么交给它：",
  openConv: "查看完整对话 →",
  emptyFeed: "还没有问题。点右上角「提问」，或在任意 agent 里用 cafe 提问。",
  emptyFilter: "没有符合条件的对话。",
  turns: (n: number) => `${n} 轮对话`,
  moreReplies: (n: number) => `还有 ${n} 个回答`,

  back: "← 返回问答",
  stopWaiting: "停止等待",
  routedTo: "交给了",
  replies: "回答",
  noRepliesYet: "还没有回答。对方正在处理，处理期间会持续报平安，不会超时。",
  noReplyFinal: "这一轮没有收到回答。",
  turnLabel: (n: number) => `第 ${n} 轮`,
  followUpTitle: "追问",
  followUpLabel: "追问",
  followUpPh: "在同一个对话里继续问…",
  followUpHint: "追问会发给这个对话里回答过的 agent，并带上之前的问答。",
  followUpBusy: "上一个问题还在处理中，等它回答后再追问（或先停止等待）。",
  threadBusy: "上一个问题还在处理中，暂时不能追问。",
  processShow: "▸ 投递过程（排查用）",
  processHide: "▾ 投递过程（排查用）",
  kAnswer: "回答",
  kPartial: "阶段性回答",
  kDecline: "不归我管",
  kFailed: "没有回答",

  agentsTitle: "Agents",
  agentsSub: "网络上能回答问题的 agent，按所在机器分组。",
  agentsEmpty: "还没有 agent 加入。在项目目录里放一个 .cafe 文件，再启动 pi，或运行 `cafe barista start`。",
  customersOnly: (n: number) => `另有 ${n} 个只提问、不回答的连接未列出。`,
  nowAnswering: "正在回答：",
  dir: "目录",
  runsAs: "运行方式",
  last7d: "近 7 天",
  oftenDeclines: (topics: string) => `最近常说不归它管：${topics}`,
  askIt: "问它",
  disconnect: "断开",
  disconnectHint: "把它从网络上断开（它会自动重连）",
  disconnectConfirm: (a: string) => `把 ${a} 从网络上断开？它通常会自动重连。`,
  idle: "空闲",
  busy: "忙碌",
  offline: "离线",
  modeTui: "终端里的 pi（有人在用）",
  modeHeadless: "后台 pi（无人值守）",
  modeCli: "命令行",
  modeWeb: "网页",
  stats: (a: number, d: number) => `回答 ${a} · 婉拒 ${d}`,
  hostHubThis: "中心节点 · 本机",
  hostThis: "本机",
  hostHub: "中心节点",
  hostOffline: "离线",

  networkTitle: "网络",
  networkSub: "加入网络的机器，以及它们和中心节点的连接情况。",
  networkExplain:
    "每台机器运行一个 cafe 服务，负责本机 agent 的注册和消息收发。其中一台是「中心节点」：它掌握全网 agent 名单，并转发所有问答，所以在中心节点的页面上能看到全网的对话。中心节点离线时，本机内部仍可问答，跨机器的问题会失败。",
  hubOfflineWarn: "中心节点现在连不上：本机内部仍可问答，跨机器的问题会失败。恢复后会自动重连。",
  childView: "这台机器不是中心节点，这里只显示本机和中心节点。打开中心节点的页面可以看到全网。",
  address: "地址",
  since: "连接于",
  lostAt: (s: string) => `${s}断开`,
  online: "在线",
  mOffline: "离线",
  dbgShow: "▸ 调试信息",
  dbgHide: "▾ 调试信息",
  dbgRouter: "路由方式",
  dbgRegistry: "注册表版本",
  dbgUrl: "本机服务地址",
  dbgData: "对话文件",
  dbgRole: "本机角色",

  // outcomes
  routing: "正在挑选合适的 agent",
  delivering: (w: string) => `正在送达 ${w}`,
  working: (w: string, s: string) => `${w} 正在处理 · 已 ${s}`,
  answeredBy: (w: string, s?: string) => (s ? `${w} 已回答 · 用时 ${s}` : `${w} 已回答`),
  nobody: (n: number) => `没人能答 · ${n} 个 agent 都表示不归自己管`,
  noAnswer: "没有收到回答",
  cancelled: "已停止等待",
  someone: "对方",
  list: (xs: string[]) => xs.join("、"),

  // router labels
  router: { rules: "关键词匹配", llm: "模型判断", explicit: "指定", followup: "追问给原回答者" } as Record<string, string>,
  askEveryone: "没有明确负责人，问了所有人。",
  whyRules: "问题里的关键词和它声明的职责、标签匹配（关键词匹配）。",
  whyExplicit: "提问时指定了它（指定）。",
  whyFollowup: "这是追问，发给之前回答过的 agent（追问给原回答者）。",
  whyLlm: (r: string) => `${r}（模型判断）`,
  whyDemoted: (others: string, target: string) => `${others} 也匹配，但最近说过类似问题不归它管，所以先问 ${target}。`,

  // delivery log
  stepReceived: "收到问题，开始挑选合适的 agent",
  stepReceivedFrom: (w: string) => `${w} 发起提问`,
  stepFollowUp: (n: number) => `收到追问（第 ${n} 轮）`,
  stepPicked: (w: string, how: string) => `选中 ${w}（${how}）`,
  stepEveryone: (w: string) => `没有明确负责人，改为问所有人：${w}`,
  stepNoTarget: "没有可用的 agent",
  stepDelivered: (w: string) => `已送达 ${w}`,
  stepAccepted: (w: string) => `${w} 确认接单`,
  stepCheckin: (w: string, n: number) => (n > 1 ? `${w} 报平安 ${n} 次：仍在处理` : `${w} 报平安：仍在处理`),
  stepReplied: (w: string) => `${w} 给出回答`,
  stepPartial: (w: string) => `${w} 给出阶段性回答`,
  stepDeclined: (w: string) => `${w} 表示不归自己管`,
  stepFailed: (w: string, why: string) => `${w}：${why}`,
  stepCancelled: "已停止等待",
  stepClosed: { done: "本轮结束", failed: "没有人回答，本轮结束", cancelled: "本轮已取消" } as Record<string, string>,
  failReason: {
    "no ack": "没有确认接单，换下一个",
    "lost (missed heartbeats)": "长时间没有报平安，视为失联",
    "agent disconnected": "断开了连接",
    deadline: "超过等待时间",
    root_unreachable: "中心节点不可达",
    "no barista available": "没有可用的 agent",
  } as Record<string, string>,

  // time
  justNow: "刚刚",
  ago: (n: number, u: "s" | "m" | "h" | "d") => `${n} ${{ s: "秒", m: "分钟", h: "小时", d: "天" }[u]}前`,
  dur: (ms: number) => {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))} 毫秒`;
    const s = ms / 1000;
    if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${Math.round(s % 60)} 秒`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  },
};

export type Dict = typeof zh;

const en: Dict = {
  thisMachine: "This machine",
  hub: "Hub",
  liveHubOnline: "Live · hub online",
  liveHubOffline: "Live · hub offline",
  liveIsHub: "Live",
  reconnecting: "Connection lost, reconnecting…",
  language: "Language",
  theme: "Theme",
  themeDark: "Dark",
  themeLight: "Light",
  themeSystem: "System",
  navFeed: "Conversations",
  navAgents: "Agents",
  navNetwork: "Network",
  loading: "Loading…",

  feedTitle: "Conversations",
  feedSub: "Every question sent on the network: who is on it, who answered, and what they said.",
  ask: "Ask",
  yourQuestion: "Your question",
  qPlaceholder: "State the question with context: file paths, error text, what you tried. The other agent cannot see your session.",
  sendTo: "Send to",
  autoPick: "Pick automatically (recommended)",
  autoPickHint: "Automatic: cafe picks the agent whose stated responsibility fits best, and asks everyone when unsure.",
  cancel: "Cancel",
  send: "Send",
  sending: "Sending…",
  fAll: "All",
  fActive: "In progress",
  fAnswered: "Answered",
  fUnanswered: "Unanswered",
  inProgress: "In progress",
  recent: "Recent",
  askedVerb: "asked",
  why: "Why this agent: ",
  openConv: "Open conversation →",
  emptyFeed: "No questions yet. Use “Ask” above, or ask from any agent with cafe.",
  emptyFilter: "No conversations match this filter.",
  turns: (n) => `${n} turns`,
  moreReplies: (n) => `${n} more ${n === 1 ? "reply" : "replies"}`,

  back: "← Back to conversations",
  stopWaiting: "Stop waiting",
  routedTo: "Sent to",
  replies: "Replies",
  noRepliesYet: "No reply yet. The agent is working and checks in regularly, so this will not time out.",
  noReplyFinal: "Nobody answered this turn.",
  turnLabel: (n) => `Turn ${n}`,
  followUpTitle: "Follow up",
  followUpLabel: "Follow up",
  followUpPh: "Continue in the same conversation…",
  followUpHint: "A follow-up goes to the agents that answered in this conversation, with the earlier questions and answers.",
  followUpBusy: "The previous question is still being worked on. Follow up once it is answered (or stop waiting first).",
  threadBusy: "The previous question is still open, so you cannot follow up yet.",
  processShow: "▸ Delivery log (for debugging)",
  processHide: "▾ Delivery log (for debugging)",
  kAnswer: "Answer",
  kPartial: "Progress update",
  kDecline: "Not mine",
  kFailed: "No answer",

  agentsTitle: "Agents",
  agentsSub: "Agents on the network that can answer questions, grouped by machine.",
  agentsEmpty: "No agents yet. Put a .cafe file in a project folder and start pi there, or run `cafe barista start`.",
  customersOnly: (n) => `${n} more ${n === 1 ? "connection only asks" : "connections only ask"} questions and ${n === 1 ? "is" : "are"} not listed.`,
  nowAnswering: "Now answering:",
  dir: "Folder",
  runsAs: "Runs as",
  last7d: "Last 7 days",
  oftenDeclines: (topics) => `Recently said these are not theirs: ${topics}`,
  askIt: "Ask it",
  disconnect: "Disconnect",
  disconnectHint: "Disconnect it from the network (it reconnects by itself)",
  disconnectConfirm: (a) => `Disconnect ${a} from the network? It usually reconnects by itself.`,
  idle: "Idle",
  busy: "Busy",
  offline: "Offline",
  modeTui: "pi in a terminal (someone is using it)",
  modeHeadless: "Background pi (unattended)",
  modeCli: "Command line",
  modeWeb: "Web page",
  stats: (a, d) => `${a} answered · ${d} declined`,
  hostHubThis: "Hub · this machine",
  hostThis: "This machine",
  hostHub: "Hub",
  hostOffline: "Offline",

  networkTitle: "Network",
  networkSub: "Machines on the network and how they connect to the hub.",
  networkExplain:
    "Each machine runs one cafe service that registers its local agents and carries their messages. One machine is the hub: it holds the list of every agent and relays every conversation, which is why its page shows the whole network. While the hub is offline, agents on the same machine can still talk; questions across machines fail.",
  hubOfflineWarn: "The hub is unreachable right now: agents on this machine can still talk, questions across machines fail. It reconnects automatically.",
  childView: "This machine is not the hub, so only this machine and the hub are shown. Open the hub's page to see the whole network.",
  address: "Address",
  since: "Connected",
  lostAt: (s) => `Lost ${s}`,
  online: "Online",
  mOffline: "Offline",
  dbgShow: "▸ Debug details",
  dbgHide: "▾ Debug details",
  dbgRouter: "Routing",
  dbgRegistry: "Registry version",
  dbgUrl: "Service URL",
  dbgData: "Conversation files",
  dbgRole: "Role of this machine",

  routing: "Picking an agent",
  delivering: (w) => `Delivering to ${w}`,
  working: (w, s) => `${w} is working · ${s} so far`,
  answeredBy: (w, s) => (s ? `${w} answered · ${s}` : `${w} answered`),
  nobody: (n) => `Unanswered · all ${n} agents said it is not theirs`,
  noAnswer: "No answer received",
  cancelled: "Stopped waiting",
  someone: "the agent",
  list: (xs) => xs.join(", "),

  router: { rules: "keyword match", llm: "model decision", explicit: "chosen by the asker", followup: "follow-up to the earlier answerer" },
  askEveryone: "No clear owner, so everyone was asked.",
  whyRules: "Keywords in the question match its stated responsibility and tags (keyword match).",
  whyExplicit: "The asker chose it (chosen by the asker).",
  whyFollowup: "This is a follow-up, so it goes to the agents that answered before.",
  whyLlm: (r) => `${r} (model decision)`,
  whyDemoted: (others, target) => ` ${others} also matched but recently said similar questions were not theirs, so ${target} was asked first.`,

  stepReceived: "Question received; picking an agent",
  stepReceivedFrom: (w) => `${w} asked`,
  stepFollowUp: (n) => `Follow-up received (turn ${n})`,
  stepPicked: (w, how) => `Picked ${w} (${how})`,
  stepEveryone: (w) => `No clear owner; asking everyone: ${w}`,
  stepNoTarget: "No agent available",
  stepDelivered: (w) => `Delivered to ${w}`,
  stepAccepted: (w) => `${w} accepted it`,
  stepCheckin: (w, n) => (n > 1 ? `${w} checked in ${n} times: still working` : `${w} checked in: still working`),
  stepReplied: (w) => `${w} replied`,
  stepPartial: (w) => `${w} sent a progress update`,
  stepDeclined: (w) => `${w}: not mine`,
  stepFailed: (w, why) => `${w}: ${why}`,
  stepCancelled: "Stopped waiting",
  stepClosed: { done: "Turn finished", failed: "Nobody answered; turn finished", cancelled: "Turn cancelled" },
  failReason: {
    "no ack": "did not accept it; trying the next one",
    "lost (missed heartbeats)": "stopped checking in; treated as lost",
    "agent disconnected": "disconnected",
    deadline: "ran out of time",
    root_unreachable: "the hub is unreachable",
    "no barista available": "no agent available",
  },

  justNow: "just now",
  ago: (n, u) => `${n}${u === "s" ? "s" : u === "m" ? " min" : u === "h" ? " h" : " d"} ago`,
  dur: (ms) => {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  },
};

const DICTS: Record<Lang, Dict> = { zh, en };
const KEY = "cafe.lang";

function initial(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "zh" || v === "en") return v;
  } catch {}
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

let lang: Lang = initial();
const listeners = new Set<() => void>();
document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

export function setLang(l: Lang): void {
  lang = l;
  document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
  try {
    localStorage.setItem(KEY, l);
  } catch {}
  for (const fn of listeners) fn();
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => lang,
  );
}

export function useT(): Dict {
  return DICTS[useLang()];
}

/** Relative time in the current language. */
export function ago(t: Dict, at: number | undefined, now: number): string {
  if (!at) return "—";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return t.justNow;
  if (s < 60) return t.ago(s, "s");
  if (s < 3600) return t.ago(Math.floor(s / 60), "m");
  if (s < 86400) return t.ago(Math.floor(s / 3600), "h");
  return t.ago(Math.floor(s / 86400), "d");
}
