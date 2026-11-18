# Cafe

Cafe 是一个 agent 网络：任意一方发出的消息，能被网络路由到最适合回答的一个或一组 agent，用网络（类 DNS）的思想让各 agent 各司其职。

## 参与者

**Agent**:
网络中的一个注册实体，对应一个正在运行的 agent 实例（TUI 或 headless）。同一 host、同一目录下的多个实例是多个 Agent。
_Avoid_: node, peer, client

**Barista**:
已注册且可接单的 Agent，带有身份、描述与可访问范围（scope），负责处理路由给它的 Order。
_Avoid_: producer, worker, provider

**Customer**:
某次 Order 的发起方。任何 Agent、CLI 调用者或人都可以作为 Customer；它是一次通信中的角色，不是 Agent 的类型。
_Avoid_: consumer, requester, client

**Daemon**:
每台 host 上的常驻路由节点，接受本机 Agent 注册并路由 Order。每台 host 至多一个。
_Avoid_: server, broker, hub, counter

**Root Daemon**:
网络中唯一的顶级 Daemon，维护全网 Barista 注册表并分发给各 Daemon；它同时充当其所在 host 的 Daemon。
_Avoid_: master, central server

**Host**:
运行一个 Daemon 的机器。
_Avoid_: PC, machine, node

## 消息

**Order**:
Customer 发出的一条请求，带唯一 id，可单播、多播或广播。
_Avoid_: request, message, query, job

**Reply**:
Barista 对某个 Order 的回应；Barista 也可以 decline（声明不归自己处理）。
_Avoid_: response, answer

**Notice**:
不需要 Reply 的单向通知。
_Avoid_: event, fire-and-forget message

**Thread**:
一次完整对话：首个 Order、其后的 Follow-up，以及它们的全部 Reply。Thread 的状态即其最新一个 Order 的状态。
_Avoid_: conversation, session, 问答 pair

**Follow-up**:
在已有 Thread 中继续发出的 Order；默认发给该 Thread 中已经回答过的 Barista，并附带此前的对话记录。
_Avoid_: reply-to, continuation

**Routing Decision**:
Daemon 针对一个 Order 给出的去向结论：目标 Barista 列表、投递方式及理由。
_Avoid_: dispatch, plan

## 身份与配置

**Cafe File**:
目录下的 `.cafe` 文件，声明在该目录启动的 Agent 的身份；从启动目录向上查找最近的一个。
_Avoid_: manifest, profile

**Address**:
Agent 的可读地址 `name#n@host`；省略 `#n` 时指该 host 上同名的全部 Agent。
_Avoid_: id, handle

**Registry**:
全网 Barista 的注册表，由 Root Daemon 维护并复制到每个 Daemon。
_Avoid_: directory, roster, zone

**Scope**:
Barista 声明的、它可访问和负责的目录或代码范围。
_Avoid_: workspace, domain
