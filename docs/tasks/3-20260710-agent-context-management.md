# Task: 对话上下文管理

| 字段 | 值 |
|------|-----|
| 关联 Spec | docs/specs/3-20260710-agent-context-management.md |
| 状态 | pending |

---

## 任务清单

### T1 — 定义核心类型

**文件：** `src/agent/context/types.ts`

定义以下接口与类型，供 `ContextManager`、`SessionManager` 及上层调用方共同使用：

- `MessageRecord`：单条消息记录，包含 `id`（`crypto.randomUUID()`）、`role`（`"user" | "assistant" | "system"`）、`content`、`createdAt`（Unix 毫秒时间戳）、`tokenEstimate`（`Math.ceil(content.length / 4)`）
- `SessionMeta`：会话元数据，包含 `id`（slug 格式，如 `"20260710-abc123"`）、`title`（取第一条用户消息前 20 字，可手动修改）、`createdAt`、`updatedAt`、`messageCount`、`providerSnapshot`（`providerId` + `model`）
- `Session`：内存中的完整会话，包含 `meta: SessionMeta`、`messages: MessageRecord[]`（按 `createdAt` 升序排列）、`systemPrompt: string | null`（覆盖全局 `settings.systemPrompt`）
- `ContextConfig`：裁剪配置，包含 `contextWindow: number`、`systemPrompt: string | null`、`systemPromptTokenEstimate: number`（默认 500）
- `TrimResult`：裁剪结果，包含 `messages: ChatMessage[]`（实际发送给 LLM 的切片）、`trimmedCount: number`（0 表示未裁剪）

同时在 `src/agent/context/index.ts` 中统一导出所有内容。

**预期结果：** `bunx tsc --noEmit` 通过；其他模块可从 `src/agent/context` 直接 import 上述类型，无循环依赖。

---

### T2 — 实现 ContextManager

**文件：** `src/agent/context/ContextManager.ts`

实现 `ContextManager` 类，核心方法为 `buildPrompt(session: Session, config: ContextConfig): TrimResult`：

- 该方法为**纯函数，无副作用，不自行 emit 任何事件**
- token 预算公式：`availableBudget = contextWindow - systemPromptTokenEstimate - Math.ceil(contextWindow * 0.1)`（`replyReserve` 为 `contextWindow * 0.1`）
- 优先保留所有 `role === "system"` 的消息，system 消息不参与裁剪
- 在 `user/assistant` 消息中，按"最新 N 轮对话对"策略从后向前保留，N 从大到小递减，直到总 `tokenEstimate` 满足 `availableBudget`
- 最少保留最新 1 轮 `user + assistant` 对，防止传空消息
- `session.messages` 不被修改，裁剪只发生在构造临时切片时
- 返回 `TrimResult`，其中 `trimmedCount` 为被移除的消息条数（`0` 表示未裁剪）
- 调用方（`AgentRunner`）在 `trimmedCount > 0` 时负责 emit `context_trimmed` 事件

**预期结果：** 手动注入超过 `availableBudget` 的消息后，`buildPrompt()` 返回的切片 token 总量不超过预算；system 消息始终出现在切片中；至少保留 1 轮 `user + assistant` 对。

---

### T3 — 实现 SessionManager

**文件：** `src/agent/context/SessionManager.ts`

实现 `SessionManager` 类，管理多 session 的内存状态与磁盘持久化：

**构造函数：** 接受可选 `options?: { ephemeral?: boolean }`。`ephemeral: true` 模式下，`appendMessage()` 只更新内存，不写磁盘；`SubagentRunner` 必须使用此模式。

**方法实现：**

- `listSessions(): Promise<SessionMeta[]>`：扫描 `~/.paw/sessions/` 目录，仅读取各 `.meta.json` 文件，不加载全量 JSONL messages
- `loadSession(sessionId: string): Promise<Session>`：读取对应 JSONL 文件，逐行解析为 `MessageRecord[]`，结合 `.meta.json` 组装 `Session`
- `createSession(opts?): Promise<Session>`：生成新 session id（`YYYYMMDD-<随机6字符>`），写入初始 `.jsonl` 空文件和 `.meta.json`，原子更新 `active.json`，emit `session_created` 事件
- `switchSession(sessionId: string): Promise<Session>`：加载目标 session，原子更新 `active.json`，emit `session_switched` 事件；调用前若有 streaming，调用方必须先调用 `AgentRunner.abort()`
- `deleteSession(sessionId: string): Promise<void>`：将对应 `.jsonl` 和 `.meta.json` 移至 `~/.paw/sessions/.trash/`（不直接删除），原子更新 `active.json`，emit `session_deleted` 事件
- `appendMessage(message: MessageRecord): Promise<void>`：向活跃 session 追加消息；非 `ephemeral` 模式下增量追加一行到 `.jsonl`，并原子替换写更新 `.meta.json`（更新 `messageCount` + `updatedAt`）；`ephemeral` 模式下只更新内存
- `getActiveSession(): Session | null`：返回当前内存中的活跃 session

**持久化实现规范：**

- 使用 `Bun.file` 的接口，不引入 `node:fs`
- `.meta.json` 和 `active.json` 的写入采用"写临时文件 → fsync → rename 原子替换"模式
- 每个 session 文件操作通过异步互斥锁（或写队列）保证串行化，避免并发写竞争
- 应用启动时对每个 JSONL 文件执行逐行解析校验；发现损坏行时，降级跳过损坏行并记录警告日志，不崩溃退出
- `appendMessage()` 直接写入脱敏后内容（`hook_completed` 类消息的 `stdout` 由 `HookExecutor` 已脱敏，直接落盘）

**目录结构：**

```
~/.paw/sessions/
├── active.json
├── <sessionId>.meta.json
├── <sessionId>.jsonl
└── .trash/
```

**预期结果：** 新建 session 后 `~/.paw/sessions/` 下存在对应 `.jsonl` 和 `.meta.json`；发送一轮对话后 JSONL 包含 2 行；重启后活跃 session 自动恢复；`ephemeral` 模式下无文件写入。

---

### T4 — 扩展 AgentEvent 类型

**文件：** `src/agent/events.ts`

在现有 `AgentEvent` 联合类型中追加以下 4 个新事件类型（遵循嵌套 `payload` 格式，与现有事件保持一致）：

- `{ type: "session_created"; payload: { sessionId: string; title: string } }`：新 session 创建完成、文件落盘后触发
- `{ type: "session_switched"; payload: { sessionId: string } }`：活跃 session 切换后触发
- `{ type: "session_deleted"; payload: { sessionId: string } }`：session 移入 trash 后触发
- `{ type: "context_trimmed"; payload: { trimmedCount: number; sentCount: number } }`：本次请求触发裁剪时由调用方（`AgentRunner`）在 `buildPrompt()` 返回 `trimmedCount > 0` 后 emit

不修改现有事件类型定义，只追加。

**预期结果：** `bunx tsc --noEmit` 通过；消费方可以对新事件类型进行穷举匹配而不产生类型错误。

---

### T5 — 更新 AgentRunner 接入 SessionManager

**文件：** `src/agent/runner.ts`

将现有的 `ConversationHistory`（Spec 2）替换为 `SessionManager`，并接入 `ContextManager.buildPrompt()`：

- `AgentRunner` 改为持有 `SessionManager` 实例引用，初始化时从 `SessionManager.getActiveSession()` 获取当前 session
- 用户发送消息时：先执行 `before_user_message` hook（若存在），hook 以退出码 2 阻断则不调用 `appendMessage()`，不继续 LLM 请求，emit `hook_blocked` 事件；hook 通过后调用 `appendMessage()` 写入用户消息
- 调用 `LLMProvider.stream()` 前，通过 `ContextManager.buildPrompt(session, config)` 构造发送切片；若 `trimmedCount > 0`，emit `context_trimmed` 事件
- `config.contextWindow` 来自 `settings.json` 的 `contextWindow` 字段（默认 `16000`，取代 Spec 2 的 `maxHistoryTokens`）
- `config.systemPrompt` 优先取 `session.systemPrompt`，若为 `null` 则取 `settings.json` 的 `systemPrompt`
- LLM 回复完成（`stream_done`）后，调用 `appendMessage()` 写入 assistant 消息；streaming 进行中不落盘
- `SubagentRunner`（若存在）改为使用 `ephemeral: true` 的 `SessionManager` 实例，与主 session 完全隔离
- 移除 `ConversationHistory` 的导入和使用，废弃 `src/agent/history.ts`（或在文件头注释标注"已由 Spec 3 的 SessionManager 接管"）

**预期结果：** `bun run dev` 正常启动；发送消息后 JSONL 落盘正确；`bunx tsc --noEmit` 通过；Subagent 消息不出现在主 session 的 JSONL 中。

---

### T6 — 更新 settings.json schema 说明文档

**文件：** `docs/specs/1-<已有 Spec 1 文件名>.md`（或项目中记录 `settings.json` schema 的说明文档）

在 `settings.json` 的字段说明部分新增以下两项（不修改实际配置文件，只更新 schema 文档说明）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `contextWindow` | `number` | `16000` | token 上限（粗估），触发裁剪的阈值；取代 Spec 2 的 `maxHistoryTokens`，以本字段为准 |
| `systemPrompt` | `string \| null` | `null` | 全局 system prompt；可被 `Session.systemPrompt` 覆盖（session 级优先） |

同时在 Spec 2 对应文档中，在 `maxHistoryTokens` 相关描述处添加说明："上下文管理由 Spec 3 接管，此处为占位描述，实际以 `contextWindow` 字段为准。"

**预期结果：** schema 文档与实际实现保持一致，开发者可从文档中准确了解 `contextWindow` 和 `systemPrompt` 字段的含义与优先级规则。

---

## 执行顺序

```
T1 → T2 / T3（可并行）→ T4 → T5 → T6
```

T2 和 T3 均依赖 T1 定义的类型，可在 T1 完成后并行实现。T4 在 T2/T3 逻辑明确后补充事件类型。T5 依赖 T2/T3/T4 全部就绪。T6 为文档更新，可在 T5 实现后同步完成。

---

## 完成记录

| 任务 | 状态 | 验证结果 |
|------|------|----------|
| T1 | pending | — |
| T2 | pending | — |
| T3 | pending | — |
| T4 | pending | — |
| T5 | pending | — |
| T6 | pending | — |
