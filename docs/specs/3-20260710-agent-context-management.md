# Spec: 对话上下文管理

| 字段 | 值 |
|------|-----|
| 状态 | approved |
| 日期 | 2026-07-10 |
| 修订日期 | 2026-07-10（review 修复）|
| 风险级别 | 中 |

> **风险级别理由：** 本 Spec 新增多个 `AgentEvent` 类型（`session_created` / `session_switched` / `session_deleted` / `context_trimmed`），并修改 Agent 编排层的核心数据结构（message history）。不涉及渲染框架更换或 Agent-UI 通信协议的破坏性修改，符合"中风险"定级标准。

---

## 背景 / 目标 / 范围

### 背景

Spec 1 完成了 `LLMProvider.stream()` 的抽象层，但调用方每次传入的 `messages` 数组目前是无状态的占位逻辑（见 `src/App.tsx` 中的本地 `useState`）。随着对话轮次增加，需要解决以下问题：

1. 多轮对话时如何维护完整的 message history 并传给 LLM。
2. 当 history 积累的 token 数超过 context window 上限时，需要有确定性的裁剪策略，同时不破坏对话语义。
3. 用户希望同时维护多个独立的对话线程（session），并能在会话间切换，不互相污染。
4. 应用重启后，历史对话应可恢复，不依赖进程内存。

### 目标

1. 定义 `Session` 和 `MessageRecord` 的内存数据结构。
2. 实现确定性的 context 裁剪策略（token 估算 + 保留规则）。
3. 实现多 session 的增删改查与切换。
4. 实现会话持久化（JSONL 格式落盘至 `~/.paw/sessions/`）。
5. 明确内存状态与磁盘的同步时机，避免数据丢失。

### 包含

- `MessageRecord` 数据结构定义
- `Session` 数据结构定义（含元数据）
- `ContextManager`：context window 裁剪策略实现
- `SessionManager`：多 session CRUD + 活跃 session 切换
- 持久化层：JSONL 落盘格式、文件路径规范、读写接口
- 新增 `AgentEvent` 类型：`session_created` / `session_switched` / `session_deleted` / `context_trimmed`
- `settings.json` 新增配置项：`contextWindow` / `systemPrompt`

### 不包含

- UI 层的 session 列表渲染（session 管理功能通过 Spec 4 定义的 Overlay 组件提供用户操作入口，具体 UI 交互由 Spec 4 定义）
- 跨 session 的消息搜索
- 消息的编辑与重新生成（forking）
- token 精确计量（本 Spec 只做字符估算，精确计量为独立需求）
- 云端同步

---

## 技术方案

### 1. 核心数据结构

```ts
// src/agent/context/types.ts

/** 单条消息记录（内存中使用） */
export interface MessageRecord {
  id: string                        // crypto.randomUUID()
  role: "user" | "assistant" | "system"
  content: string
  createdAt: number                 // Unix timestamp（毫秒）
  tokenEstimate: number             // 字符数 / 4 的整数向上取整（粗估）
}

/** 会话元数据 */
export interface SessionMeta {
  id: string                        // 文件名中使用的 slug，如 "20260710-abc123"
  title: string                     // 取第一条用户消息前 20 字；可手动修改
  createdAt: number
  updatedAt: number
  messageCount: number
  providerSnapshot: {               // 创建时的 provider 快照，用于信息展示
    providerId: string
    model: string
  }
}

/** 内存中的完整会话 */
export interface Session {
  meta: SessionMeta
  messages: MessageRecord[]         // 按 createdAt 升序排列
  systemPrompt: string | null       // 覆盖全局 settings.systemPrompt
}
```

### 2. Context Window 裁剪策略

**估算方式：** `tokenEstimate = Math.ceil(content.length / 4)`（中英文混合场景下 4 字符/token 为保守估算）。

**裁剪触发条件：** 在每次调用 `LLMProvider.stream()` 前，计算本次准备发送的 user/assistant messages 总 `tokenEstimate`。可用预算为：

```
availableBudget = contextWindow - systemPromptTokenEstimate - replyReserve
```

若 messages 总 `tokenEstimate` 超过 `availableBudget`，则触发裁剪。`ContextConfig.systemPromptTokenEstimate` 默认值为 500，`replyReserve` 取 `contextWindow * 0.1`（预留 10%）；Spec 8 memory 注入后，由上层统一计算实际 system prompt token 数并传入 `systemPromptTokenEstimate`。

**保留规则（优先级从高到低）：**

| 优先级 | 规则 | 说明 |
|--------|------|------|
| 1 | 保留全部 `system` 消息 | system prompt 不参与裁剪 |
| 2 | 保留最新 N 轮 user+assistant 对 | N 从大到小递减，直到满足 token 预算 |
| 3 | 最少保留 1 轮 user+assistant 对 | 防止无限裁剪后传空 messages |

**裁剪不修改 `Session.messages`（磁盘数据保持完整）。** 裁剪只发生在构造传给 `LLMProvider.stream()` 的临时 `ChatMessage[]` 切片时。

```ts
// src/agent/context/ContextManager.ts

export interface TrimResult {
  messages: ChatMessage[]           // 实际发送给 LLM 的切片
  trimmedCount: number              // 被裁剪掉的消息条数（0 表示未裁剪）
}

export class ContextManager {
  /** 根据 contextWindow 配置，从 session.messages 构造发送切片（纯计算函数，无副作用） */
  buildPrompt(session: Session, config: ContextConfig): TrimResult
}

export interface ContextConfig {
  contextWindow: number                  // 最大 token 数，来自 settings.json
  systemPrompt: string | null            // 全局 system prompt（可被 session 覆盖）
  systemPromptTokenEstimate: number      // system prompt 占用的 token 预估（默认 500）；Spec 8 memory 注入后由上层统一计算并传入
}
```

**`buildPrompt()` 为纯计算函数，无副作用，不自行 emit 任何事件。** 调用方（`AgentRunner` 或 `AgentOrchestrator`）在收到 `TrimResult` 后，若 `trimmedCount > 0` 则负责向事件总线 emit `context_trimmed` 事件（见第 4 节）。

### 3. SessionManager：多 session 管理

```ts
// src/agent/context/SessionManager.ts

export class SessionManager {
  /**
   * @param options.ephemeral - 若为 true，appendMessage() 只更新内存，不写磁盘；
   *                            SubagentRunner 必须使用此模式，消息历史随任务销毁
   */
  constructor(options?: { ephemeral?: boolean })

  /** 从 ~/.paw/sessions/ 加载所有 session 元数据（只读取各 .meta.json，不加载全量 messages） */
  async listSessions(): Promise<SessionMeta[]>

  /** 加载指定 session 的完整 messages */
  async loadSession(sessionId: string): Promise<Session>

  /** 创建新 session，写入初始 JSONL 和 .meta.json 文件 */
  async createSession(opts?: { title?: string; systemPrompt?: string }): Promise<Session>

  /** 切换活跃 session（触发 session_switched 事件） */
  async switchSession(sessionId: string): Promise<Session>

  /** 删除 session（移动至 ~/.paw/sessions/.trash/，而非直接删除） */
  async deleteSession(sessionId: string): Promise<void>

  /** 向活跃 session 追加消息，并增量落盘 */
  async appendMessage(message: MessageRecord): Promise<void>

  /** 获取当前活跃 session */
  getActiveSession(): Session | null
}
```

**活跃 session 持久化：** 在 `~/.paw/sessions/active.json` 存储 `{ activeSessionId: string }`，应用启动时读取，自动恢复上次会话。

---

**与 Spec 2 ConversationHistory 的替代关系（P0-03）：**

Spec 3 实现后，Spec 2 `src/agent/history.ts` 的 `ConversationHistory` **被废弃**：
- `AgentRunner` 改持 `SessionManager` 引用，通过 `ContextManager.buildPrompt()` 构建每次请求的消息切片
- `MessageRecord` 为 `ChatMessage`（Spec 1）的超集，两者字段兼容

| 字段 | `HistoryEntry`（Spec 2，废弃） | `MessageRecord`（Spec 3，当前） |
|------|-------------------------------|--------------------------------|
| `id` | 无 | `string`（crypto.randomUUID()）|
| `role` | `"user" \| "assistant"` | `"user" \| "assistant" \| "system"` |
| `content` | `string` | `string` |
| `timestamp` | `number` | 改名为 `createdAt: number` |
| `tokenEstimate` | 无 | `number` |

Spec 2 相关章节应标注"上下文管理由 Spec 3 接管，此处为占位描述"。

---

**`ephemeral` 模式（SubagentRunner 隔离，P1-03）：**

`SessionManager` 支持 `ephemeral: true` 构造选项。该模式下：
- `appendMessage()` 只更新内存，不写磁盘
- `SubagentRunner` **必须** 使用 `ephemeral` 模式的 `SessionManager`（或纯内存 `ConversationHistory`），与持久化 session 完全隔离
- Subagent 消息历史随任务销毁，不进入用户对话 JSONL

---

**`switchSession()` 前置 abort（P2-13）：**

调用 `switchSession()` 前，若当前有 streaming 进行中，**必须先调用 `AgentRunner.abort()` 再切换**，禁止在 stream 进行中直接切换，以避免 assistant 消息写入错误 session。

---

> **TUI 入口（P3-02）：** session 管理功能通过 Spec 4 定义的 Overlay 组件提供用户操作入口，具体 UI 交互由 Spec 4 定义；本 Spec 仅定义后端 API。

### 4. AgentEvent 扩展

> **全量 `AgentEvent` 权威定义见 `src/agent/events.ts`，此处仅列本 Spec 新增类型。所有类型统一采用嵌套 `payload` 格式。**

```ts
// src/agent/events.ts（本 Spec 新增类型，遵循嵌套 payload 格式）
{ type: "session_created"; payload: { sessionId: string; title: string } }
{ type: "session_switched"; payload: { sessionId: string } }
{ type: "session_deleted"; payload: { sessionId: string } }
{ type: "context_trimmed"; payload: { trimmedCount: number; sentCount: number } }
```

| type | payload | 触发时机 |
|------|---------|---------|
| `session_created` | `{ sessionId: string; title: string }` | 新 session 创建完成，文件落盘后 |
| `session_switched` | `{ sessionId: string }` | 活跃 session 切换后（id） |
| `session_deleted` | `{ sessionId: string }` | session 移入 trash 后 |
| `context_trimmed` | `{ trimmedCount: number; sentCount: number }` | 本次请求触发裁剪时，发送前；由调用方在 `buildPrompt()` 返回 `trimmedCount > 0` 后 emit |

### 5. 持久化格式与路径规范

**目录结构：**

```
~/.paw/
├── sessions/
│   ├── active.json                          # { "activeSessionId": "20260710-abc123" }
│   ├── 20260710-abc123.meta.json            # SessionMeta（独立文件，与 JSONL 分离）
│   ├── 20260710-abc123.jsonl                # 消息记录（仅 MessageRecord 行，追加写）
│   ├── 20260711-def456.meta.json
│   ├── 20260711-def456.jsonl
│   └── .trash/                             # deleteSession 移入此处，不立即删除
│       ├── 20260709-old001.meta.json
│       └── 20260709-old001.jsonl
└── settings.json                           # 已由 Spec 1 定义
```

**JSONL 文件格式：**

每个 JSONL 文件**仅包含消息记录**，每行为一条 `MessageRecord`（`"type": "message"`）。Session 元数据单独存储在同名 `.meta.json` 文件中；JSONL 文件只做**追加**，永不整体读-改-写。

```jsonl
{"type":"message","id":"uuid-1","role":"user","content":"介绍一下 Bun","createdAt":1752134400000,"tokenEstimate":5}
{"type":"message","id":"uuid-2","role":"assistant","content":"Bun 是一个现代 JavaScript 运行时……","createdAt":1752134450000,"tokenEstimate":120}
```

**`.meta.json` 文件格式：**

```json
{"id":"20260710-abc123","title":"介绍一下 Bun","createdAt":1752134400000,"updatedAt":1752134500000,"messageCount":4,"providerSnapshot":{"providerId":"anthropic-default","model":"claude-sonnet-5"}}
```

**读取时：** JSONL 文件每行解析为 `MessageRecord`；元数据从对应 `.meta.json` 读取。

**持久化实现规范（原子性与并发安全）：**

1. **`SessionMeta` 独立文件**：元数据存储在 `<sessionId>.meta.json`，与消息 JSONL 完全分离；消息 JSONL 只做追加，永不整体读-改-写。
2. **原子替换写**：需要整体替换的文件操作（如 meta 更新、`active.json` 更新）使用"写临时文件 → fsync → rename 原子替换"模式，进程崩溃不会留下半写文件。
3. **异步互斥锁**：每个 session 文件操作通过异步互斥锁（或写队列）保证串行化，避免并发写竞争丢失消息。
4. **启动完整性扫描**：应用启动时对每个 JSONL 文件执行逐行解析校验；若发现损坏行，降级重建（跳过损坏行并记录警告日志）而非崩溃退出。
5. **落盘前脱敏**：消息内容持久化前，对 `hook_completed` 类型消息的 `stdout` 字段执行脱敏处理——`HookExecutor`（Spec 7）已将 API Key 替换为 `[REDACTED]`，`appendMessage()` 直接写入脱敏后内容，确保原始 API Key 不落盘到 JSONL。

> 注：使用 `Bun.file` 的 `text()` 和 `writer()` 接口，不引入 `node:fs`。

### 6. settings.json 新增配置项

在 Spec 1 定义的 `~/.paw/settings.json` 顶层新增以下字段（均为可选，提供默认值）：

```json
{
  "contextWindow": 16000,
  "systemPrompt": "You are a helpful assistant."
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `contextWindow` | `number` | `16000` | token 上限（粗估），触发裁剪的阈值；取代 Spec 2 的 `maxHistoryTokens`（默认 32000），以本 Spec 配置为准，Spec 2 相关描述仅为占位 |
| `systemPrompt` | `string \| null` | `null` | 全局 system prompt；可被 `Session.systemPrompt` 覆盖 |

> **P2-07：** Spec 2 的 `maxHistoryTokens` 被本 Spec 的 `contextWindow` 取代。`AgentRunner` 实现时以 `contextWindow` 为准，`maxHistoryTokens` 相关逻辑不实现。

### 7. 文件结构

```
src/agent/context/
├── types.ts              # MessageRecord / Session / SessionMeta / ContextConfig
├── ContextManager.ts     # buildPrompt()：token 估算 + 裁剪逻辑（纯函数，无副作用）
├── SessionManager.ts     # CRUD + 活跃 session + 持久化读写 + ephemeral 模式
└── index.ts              # 统一导出
```

### 8. 内存与磁盘同步时机

| 操作 | 同步策略 |
|------|---------|
| 用户发送消息 | `before_user_message` hook 执行**早于** `appendMessage()` 写盘（见下方说明）；hook 通过后立即 `appendMessage`（异步写盘，不阻塞 UI） |
| LLM 回复完成（`stream_done`） | 立即 `appendMessage` 保存 assistant 消息 |
| LLM 回复中途（streaming） | 仅保存到内存，不落盘；流完成后一次性落盘 |
| 切换 session | 原子更新 `active.json`（确保下次启动恢复正确） |
| 创建 session | 立即写入 JSONL + `.meta.json` + `active.json` |
| 删除 session | 移动 JSONL 和 `.meta.json` 到 `.trash/`，原子更新 `active.json` |

> **Hook 阻断写盘时机（P1-02）：** `before_user_message` hook 执行**早于** `appendMessage()` 写盘。若 hook 以退出码 2 阻断，消息**不写入 JSONL 也不写入内存 history**，仅 emit `hook_blocked` 事件；调用方不得在阻断后继续调用 `appendMessage()`。

> **不采用定时落盘：** 避免引入后台 timer 增加复杂度；增量 append 方式写盘代价极低，可在每次消息后同步完成。

---

## 验收标准

- [ ] 新建 session 后，`~/.paw/sessions/<id>.jsonl` 和 `~/.paw/sessions/<id>.meta.json` 文件均存在且格式合法
- [ ] 发送一轮对话（user + assistant）后，JSONL 文件包含 2 行（user + assistant），`.meta.json` 中 `messageCount` 和 `updatedAt` 已更新
- [ ] 重启应用后，活跃 session 自动恢复，历史消息正确加载
- [ ] 切换 session 后，`active.json` 中 `activeSessionId` 更新为新 session id
- [ ] 删除 session 后，原 JSONL 和 `.meta.json` 文件出现在 `.trash/` 目录下，不存在于 sessions 根目录
- [ ] 当 messages 总 `tokenEstimate` 超过 `availableBudget`（`contextWindow - systemPromptTokenEstimate - replyReserve`）时，`buildPrompt()` 返回的切片 token 总量不超过该预算
- [ ] 裁剪时 system 消息始终保留在切片中
- [ ] 裁剪时至少保留最新 1 轮 user+assistant 对
- [ ] 触发裁剪时，`context_trimmed` 事件被调用方正确 emit，`trimmedCount > 0`
- [ ] `context_trimmed` 事件须在 TUI 消息区渲染为浅灰色系统提示（由 Spec 4 实现），本 Spec 保证事件正确 emit
- [ ] `contextWindow` 未配置时，默认使用 `16000`
- [ ] `systemPrompt` 在 `Session.systemPrompt` 不为 null 时，优先使用 session 级别的值
- [ ] `SessionManager.listSessions()` 只读取每个 `.meta.json` 文件，不加载全量 JSONL messages
- [ ] 并发写入同一 session 时（如 user 消息与 LLM 回复几乎同时触发），两条消息均正确落盘，JSONL 无损坏
- [ ] 进程在 `.meta.json` 写入中途被 kill 后，下次启动能正确恢复（原子替换写保证旧文件完整性）
- [ ] streaming 进行中调用 `switchSession()` 时，必须先 abort 当前 stream 再切换，不允许消息乱入
- [ ] `before_user_message` hook 以退出码 2 阻断时，消息不写入 JSONL 也不写入内存 history
- [ ] `SubagentRunner` 使用 `ephemeral` 模式时，消息不写入磁盘，任务销毁后 JSONL 无残留
- [ ] `bunx tsc --noEmit` 通过

---

## 验证方式

1. `bun run dev` 启动 TUI，手动执行创建/切换/删除 session 操作，通过终端另开窗口 `cat ~/.paw/sessions/*.jsonl` 和 `cat ~/.paw/sessions/*.meta.json` 确认落盘内容。
2. 手动修改 JSONL 文件注入大量消息（tokenEstimate 累计超 availableBudget），触发 `buildPrompt()` 裁剪，确认 `context_trimmed` 事件日志输出正确。
3. 退出应用后重启，确认活跃 session 和消息历史恢复正常。
4. 模拟进程中途崩溃（kill -9），确认 `.meta.json` 文件未损坏，下次启动能正常加载。
5. `bunx tsc --noEmit` 类型检查通过。

---

## 回滚策略

`src/agent/context/` 目录完全独立于 UI 层。回滚步骤：

1. 删除 `src/agent/context/` 目录。
2. 移除 `src/agent/events.ts` 中新增的 4 个 `AgentEvent` 类型。
3. 移除 `settings.json` 中的 `contextWindow` 和 `systemPrompt` 字段（可选，留存不影响现有逻辑）。
4. 恢复 `AgentRunner` 持有 `ConversationHistory` 引用（见 Spec 2）。

App.tsx 和 UI 层不感知 `SessionManager` 内部实现，回滚不影响现有 TUI 渲染。
