# Spec 2：Agent 编排层

| 字段 | 值 |
|------|-----|
| 状态 | approved |
| 日期 | 2026-07-10 |
| 风险级别 | 中 |
| 修订日期 | 2026-07-10（review 修复）|

> **风险判断理由：** 本 Spec 新增 `AgentRunner` 核心编排组件，并扩展 `AgentEvent` 类型（新增 `user_input`、`thinking`、`abort`），同时定义 Agent-UI 通信协议（AsyncIterable 事件总线）。不涉及渲染框架变更，不引入外部鉴权服务，属于"新增核心编排逻辑 + 扩展事件类型"场景，对应中级风险。

---

## 背景 / 目标 / 范围

### 背景

Spec 1 已完成 `src/agent/provider/` 层，提供统一的 `LLMProvider` 接口与 `ProviderRegistry`。当前 `App.tsx` 中消息收发逻辑仍为占位实现（`useState` 直接 mock），缺少真实的 Agent 编排层来驱动：用户输入 → 组装 messages → 调用 provider → 处理 streaming → 通知 UI。

paw 的核心原则是 **Agent 编排逻辑与 UI 渲染完全解耦**，两者只通过事件通信，互不感知内部实现。Agent 层不能持有任何 UI 引用，UI 层不能直接调用 provider。

### 目标

1. 定义 `AgentRunner`：负责核心 Agent 循环的唯一编排者
2. 明确 `AgentRunner` 与 UI 之间的通信协议（事件总线）
3. 支持 streaming 期间的用户取消（abort）
4. 明确 Agent 层的错误处理职责边界
5. 为后续多轮对话、工具调用扩展留好接口

### 包含

- `AgentRunner` 接口定义与职责边界
- Agent 核心循环流程（输入 → messages 组装 → stream → 事件输出）
- `AgentEvent` 类型扩展（`user_input` / `thinking` / `agent_abort`）
- Agent-UI 通信协议：基于 `AsyncIterable<AgentEvent>` 的事件总线
- 用户取消（abort）机制：`AbortController` 集成方案
- AgentRunner 层的错误处理职责（捕获、归因、转换为 `stream_error` 事件）
- 文件结构规划

### 不包含

- 多轮对话上下文的持久化存储（独立需求）
- 工具调用（Tool Use）/ Function Calling（后续 Spec）
- 系统提示词（System Prompt）的管理与配置 UI
- 费用统计 / token 计量

---

## 技术方案

### 1. 整体架构

**架构层次说明（P0-02）：**

- `AgentRunner`（`src/agent/runner.ts`）：**对外接口层**，向 UI 暴露 `send() / abort() / switchProvider() / confirmToolCall()` 及 `events: AsyncIterable<AgentEvent>`。负责管理 AbortController 生命周期、捕获所有错误并转为事件输出、发射所有 AgentEvent。UI 只与 `AgentRunner` 交互。
- `AgentOrchestrator`（由 **Spec 5** 实现）：**内部执行层**，负责 LLM 调用 + 工具调用回路。通过回调（或内部 AsyncIterable）将事件返回给 `AgentRunner` 统一发射，**不直接持有事件发射器**，不与 UI 交互。
- `AgentRunner` 持有 `AgentOrchestrator` 实例；`AgentOrchestrator` 通过回调将事件/错误报告给 `AgentRunner`，由 `AgentRunner` 统一 emit 到 `events` 总线。

**文字版架构层次图：**

```
┌───────────────────────────────────────────────────────────────────────┐
│  UI 层（App.tsx / React 组件）                                         │
│  只读操作：消费 agentRunner.events（AsyncIterable<AgentEvent>）        │
│  写操作：send(text) / abort() / switchProvider() / confirmToolCall()  │
└──────────────────────────┬────────────────────────────────────────────┘
                           │ AgentEvent（只向上流动）
                           │ 方法调用（只向下）
┌──────────────────────────▼────────────────────────────────────────────┐
│  AgentRunner（src/agent/runner.ts）— 对外接口层                        │
│  - 暴露 send / abort / switchProvider / confirmToolCall / events      │
│  - 维护内部状态机（IDLE / STREAMING / ABORTING）                       │
│  - 统一 emit 所有 AgentEvent                                           │
│  - 持有 AgentOrchestrator 实例（Spec 5 接入后）                        │
│  - 持有 ConversationHistory（Spec 3 接入后改为 SessionManager）        │
└──────────────────────────┬────────────────────────────────────────────┘
                           │ 回调通知事件（不直接持有事件发射器）
┌──────────────────────────▼────────────────────────────────────────────┐
│  AgentOrchestrator（src/agent/orchestrator.ts，Spec 5 实现）— 内部执行层│
│  - 执行 LLM 调用 + 工具调用回路                                        │
│  - 通过回调将 StreamChunk / 工具事件返回给 AgentRunner                 │
│  - 不持有事件发射器，不与 UI 交互                                       │
└──────────────────────────┬────────────────────────────────────────────┘
                           │ stream(messages): AsyncIterable<StreamChunk>
┌──────────────────────────▼────────────────────────────────────────────┐
│  Provider 层（src/agent/provider/，Spec 1 已定义）                     │
│  LLMProvider / ProviderRegistry                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### 2. AgentEvent 类型完整定义

> **P0-01 约定**：所有 AgentEvent 统一采用嵌套 `payload` 格式：`{ type: "xxx"; payload: { ... } }`，不得使用顶层平铺字段。后续 Spec 只追加新类型，不得重定义已有类型。最终权威源为 `src/agent/events.ts`（参见文末"AgentEvent 权威类型附录"章节）。

在 Spec 1 基础上新增三个事件类型：

```ts
// src/agent/events.ts

// ── Spec 1 已有 ────────────────────────────────────────────

export interface StreamChunkEvent {
  type: "stream_chunk"
  payload: { delta: string }
}

export interface StreamDoneEvent {
  type: "stream_done"
  /**
   * stopReason 说明：
   * - "stop"：正常生成完毕
   * - "tool_use"：模型请求工具调用（Spec 5 引入后生效），AgentOrchestrator 需进入工具调用分支
   * AgentRunner 在收到 stopReason === "tool_use" 时不结束 STREAMING 状态，
   * 等待 AgentOrchestrator 完成工具执行后继续循环。
   */
  payload: { totalText: string; stopReason: "stop" | "tool_use" }
}

export interface StreamErrorEvent {
  type: "stream_error"
  payload: { kind: LLMErrorKind; message: string }
}

export interface ProviderChangedEvent {
  type: "provider_changed"
  payload: { providerId: string; model: string }
}

// ── Spec 2 新增 ────────────────────────────────────────────

/** 用户提交输入时立即 emit，用于 UI 在消息列表中显示用户消息 */
export interface UserInputEvent {
  type: "user_input"
  payload: { text: string; messageId: string }
}

/** AgentRunner 开始处理（发出请求前），用于 UI 显示"思考中"状态 */
export interface ThinkingEvent {
  type: "thinking"
  payload: { messageId: string }
}

/**
 * 用户或系统主动中止了正在进行的 stream
 * UI 据此将正在流式渲染的消息标记为"已中止"
 */
export interface AgentAbortEvent {
  type: "agent_abort"
  payload: { messageId: string; partialText: string }
}

/**
 * 工具调用需要用户确认（Spec 5 实现后生效）
 * payload 不含 resolve 回调——UI 通过 AgentRunner.confirmToolCall() 回传决策
 */
export interface ToolConfirmRequiredEvent {
  type: "tool_confirm_required"
  payload: {
    toolCallId: string
    toolName: string
    input: unknown
    safetyLevel: "confirm" | "dangerous"
  }
}

/**
 * Provider 切换失败（Spec 1 P2-03 新增）
 * switchProvider() 调用失败时 emit，UI 显示错误提示并保持原 provider
 */
export interface ProviderChangeErrorEvent {
  type: "provider_change_error"
  payload: { providerId: string; reason: string }
}

// ── 联合类型 ────────────────────────────────────────────────

export type AgentEvent =
  | StreamChunkEvent
  | StreamDoneEvent
  | StreamErrorEvent
  | ProviderChangedEvent
  | ProviderChangeErrorEvent
  | UserInputEvent
  | ThinkingEvent
  | AgentAbortEvent
  | ToolConfirmRequiredEvent
```

> **注意**：`input_submitted` 不属于 `AgentEvent`（P2-08）。UI 发起输入统一通过 `AgentRunner.send(text)` 调用，不通过 AgentEvent 传递。

### 3. AgentRunner 接口定义

```ts
// src/agent/runner.ts

export interface AgentRunner {
  /**
   * 消费此 AsyncIterable 获取所有 AgentEvent。
   * UI 层在初始化时订阅，整个应用生命周期内持续消费。
   * 若 AgentRunner 被销毁，此迭代器正常结束（return）。
   */
  readonly events: AsyncIterable<AgentEvent>

  /**
   * 向 Agent 提交用户输入，触发一次完整的 Agent 循环。
   * 为 async 方法（P1-05）：若当前处于 STREAMING 状态，先 abort 并 await 旧流终止，
   * 再启动新流；若处于 ABORTING 状态，新请求入队，待转回 IDLE 后处理。
   * @param text 用户输入的纯文本
   */
  send(text: string): Promise<void>

  /**
   * 中止当前正在进行的 stream。
   * 若无进行中的 stream，调用无副作用。
   * emit agent_abort 事件。
   * 若 AgentOrchestrator 存在活跃 SubagentManager 实例，同时调用
   * subagentManager.cancelAll()（P1-11）。
   */
  abort(): void

  /**
   * 新建一个空 session 并切换到该 session，原 session 保留在历史中。
   * emit session_created + session_switched 事件（由 SessionManager 触发）。
   * 若当前有 streaming 进行中，先 abort 再新建 session。
   */
  reset(): Promise<void>

  /**
   * 切换当前 provider（转发给 ProviderRegistry）。
   * emit provider_changed 事件。
   */
  switchProvider(providerId: string): Promise<void>

  /**
   * 回传工具调用确认决策（P1-01）。
   * 由 UI 在收到 tool_confirm_required 事件后调用，替代 payload.resolve 回调。
   * abort() 调用时，所有待决 confirm 自动以 approved=false 结算。
   * @param toolCallId  对应 tool_confirm_required 事件中的 toolCallId
   * @param approved    用户决策（true=允许，false=拒绝）
   */
  confirmToolCall(toolCallId: string, approved: boolean): void

  /**
   * 释放资源（关闭事件迭代器、中止进行中的请求）。
   */
  dispose(): void
}
```

### 4. 核心循环流程

**P1-02**：`before_user_message` hook 的执行时机在 `ConversationHistory.append()` 和磁盘写入**之前**；hook 以退出码 2 阻断时，只 emit `hook_blocked`，不写历史，不写盘，流程终止。

```
用户输入（send(text)）
│
├─ 0. 执行 before_user_message hook（若已配置）
│      ├─ hook 退出码 2（阻断）→ emit hook_blocked，流程终止，不写历史不写盘
│      └─ hook 成功 → 继续
│
├─ 1. 生成 messageId（crypto.randomUUID()）
├─ 2. emit UserInputEvent { text, messageId }
├─ 3. 将用户消息追加到 ConversationHistory（写盘）
├─ 4. emit ThinkingEvent { messageId: replyId }
├─ 5. 创建新的 AbortController，保存为 currentAbortController
│
├─ 6. 调用 provider.stream(history.toMessages(), { signal })
│      │
│      ├─ 每收到 StreamChunk：
│      │    ├─ 若 done === false：emit StreamChunkEvent { delta }（delta 非空时才 emit）
│      │    │    并累积到 accumulatedText
│      │    │    [Spec 1.1 扩展：若 thinkingDelta 非空，额外 emit stream_thinking_chunk，见 Spec 1.1 §7]
│      │    └─ 若 done === true：
│      │         [Spec 1.1 扩展：若有 accumulatedThinking，先 emit stream_thinking_done，见 Spec 1.1 §7]
│      │         ├─ stopReason === "stop"：
│      │         │    emit StreamDoneEvent { totalText, stopReason: "stop" }
│      │         │    并将 assistant 消息追加到 ConversationHistory
│      │         └─ stopReason === "tool_use"（Spec 5 实现后生效）：
│      │              emit StreamDoneEvent { totalText, stopReason: "tool_use" }
│      │              由 AgentOrchestrator 进入工具调用分支，
│      │              不结束 STREAMING 状态，继续循环
│      │
│      └─ 若抛出异常：
│           ├─ 若 AbortError（用户主动中止）：
│           │    [Spec 1.1 扩展：若有 accumulatedThinking，先 emit stream_thinking_done，见 Spec 1.1 §7]
│           │    emit AgentAbortEvent { messageId: replyId, partialText }
│           └─ 其他错误：
│                emit StreamErrorEvent { kind, message }
│                （不追加到历史，下次请求重试）
│
└─ 7. 清空 currentAbortController（置为 null），状态机切换到 IDLE
```

### 5. 对话历史管理

> **P0-03 占位声明**：`src/agent/history.ts` 中的 `ConversationHistory` 为**占位实现**，Spec 3 实现后由 `SessionManager` 替代。`AgentRunner` 在 Spec 3 实现后改持 `SessionManager` 引用，并通过 `ContextManager.buildPrompt()` 构建每次请求的消息切片。当前章节描述仅适用于 Spec 3 接入之前。

> **P2-07 说明**：本 Spec 不定义 `maxHistoryTokens` 硬编码参数。上下文截断由 Spec 3 的 `ContextManager` 负责实现，具体截断阈值通过 `settings.json` 的 `contextWindow` 字段配置。

```ts
// src/agent/history.ts（占位实现，Spec 3 后由 SessionManager 替代）

export interface HistoryEntry {
  role: "user" | "assistant" | "system"
  content: string
}

export interface ConversationHistory {
  /** 追加一条记录 */
  append(entry: HistoryEntry): void

  /** 转换为 provider 层需要的 ChatMessage[] 格式 */
  toMessages(): ChatMessage[]

  /** 清空历史（保留 system prompt） */
  clear(): void

  /** 只读快照，用于序列化或调试 */
  readonly entries: ReadonlyArray<HistoryEntry>
}
```

**Spec 3 接入后的迁移路径：**

- `AgentRunner` 改持 `SessionManager` 引用（`src/agent/context/session.ts`）
- 通过 `ContextManager.buildPrompt(session, config)` 构建 `ChatMessage[]`，由调用方在 `trimmedCount > 0` 时主动 emit `context_trimmed` 事件（P2-04）
- `src/agent/history.ts` 文件废弃，`ConversationHistory` 接口不再使用

**P2-13 说明**：`SessionManager.switchSession()` 调用时若有 streaming 进行中，须先调用 `AgentRunner.abort()` 并等待状态机转为 `IDLE` 后，再执行 session 切换，防止助手消息写入错误的 session。

### 6. 中止机制与状态机

**P1-05：send() 三态状态机**

`AgentRunner` 内部维护以下三态状态机，确保事件顺序不乱：

| 状态 | 说明 |
|------|------|
| `IDLE` | 可接受新请求，`send()` 立即启动新流 |
| `STREAMING` | 有正在进行的 stream，新 `send()` 先调用 `abort()` 并 await 状态机转为 `IDLE`，再启动新流 |
| `ABORTING` | 等待当前流终止（已触发 abort，等待 AgentAbortEvent emit），新 `send()` 入队，待转回 `IDLE` 后处理 |

**关键约束**：`abort()` 后必须 await 旧流终止（`AgentAbortEvent` 已 emit，状态机回到 `IDLE`）才能发起新流，保证事件顺序不乱。

```ts
// runner.ts 内部伪代码（仅表达设计意图，非实现代码）

// 状态机：IDLE | STREAMING | ABORTING
private state: "IDLE" | "STREAMING" | "ABORTING" = "IDLE"
private currentAbortController: AbortController | null = null
// 等待当前流终止的 Promise（ABORTING 状态下新 send() 等待此 Promise）
// 创建时机：send() 开始时、进入 STREAMING 状态之前
// resolve 时机：流正常结束（stream_done emit 后）或中止（agent_abort emit 后），
//              状态切换回 IDLE 之前 resolve
private streamSettledPromise: Promise<void> | null = null
private resolveStreamSettled: (() => void) | null = null

abort(): void {
  if (this.state === "STREAMING" && this.currentAbortController) {
    this.state = "ABORTING"
    this.currentAbortController.abort()
    // 若 AgentOrchestrator 存在活跃 SubagentManager，同时取消所有子 Agent（P1-11）
    if (this.orchestrator?.activeSubagentManager) {
      this.orchestrator.activeSubagentManager.cancelAll()
    }
    // AgentAbortEvent 在 stream 异常处理中 emit（捕获到 AbortError 时）
    // emit 完成后调用 resolveStreamSettled()，状态机切换到 IDLE
  }
}

async send(text: string): Promise<void> {
  // 若处于 STREAMING，先 abort 并等待旧流终止
  if (this.state === "STREAMING") {
    this.abort()
  }
  // 若处于 ABORTING，等待旧流终止后再继续
  // 边界情况：若流在 abort() 调用到此处之间已瞬间完成（state 已回到 IDLE），
  // streamSettledPromise 为 null，直接跳过 await，不阻塞
  if (this.state === "ABORTING" && this.streamSettledPromise) {
    await this.streamSettledPromise
  }
  // 现在 state === "IDLE"，创建新的 settled Promise，再进入 STREAMING
  this.streamSettledPromise = new Promise(resolve => {
    this.resolveStreamSettled = resolve
  })
  this.state = "STREAMING"
  // ... 后续正常流程
  // 流结束时（无论正常/中止/出错）：
  //   this.resolveStreamSettled?.()
  //   this.state = "IDLE"
  //   this.streamSettledPromise = null
}
```

`AbortSignal` 需透传至 `LLMProvider.stream()`，各 provider 实现负责将 signal 传给底层 `fetch` 调用。`LLMProvider` 接口签名需相应更新：

```ts
// src/agent/provider/types.ts（更新）

export interface LLMProvider {
  readonly id: string
  readonly label: string
  readonly model: string
  stream(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal }
  ): AsyncIterable<StreamChunk>
}
```

### 7. 错误处理职责边界

| 层级 | 职责 |
|------|------|
| `LLMProvider` 实现层 | 将 HTTP 错误、网络错误、SSE 解析错误转换为 `LLMError`（含 `kind` 分类），并 throw |
| `AgentRunner` | 统一 catch，根据错误类型决定：是 `AbortError` → emit `agent_abort`；是 `LLMError` → emit `stream_error`；其他 → 归类为 `unknown` 后 emit `stream_error` |
| UI 层 | 只消费 `AgentEvent`，不处理异常，不关心 LLMError 细节 |

`AgentRunner` **不得**让任何异常向上逃逸到 UI 层；所有错误必须经过 `stream_error` 或 `agent_abort` 事件化后输出。

### 8. UI 层订阅方式（设计约束）

UI 层（`App.tsx`）通过以下方式消费事件，具体实现将在 UI 集成 Spec 中定义，此处仅说明约束：

```ts
// App.tsx（示意，非实现代码）

// 初始化时订阅事件
for await (const event of agentRunner.events) {
  switch (event.type) {
    case "user_input":           // 追加用户消息到渲染列表
    case "thinking":             // 显示加载动画
    case "stream_chunk":         // 增量更新 assistant 消息气泡
    case "stream_done":          // 隐藏加载动画，消息标记为完成
    case "stream_error":         // 显示错误提示
    case "agent_abort":          // 将部分消息标记为"已中止"
    case "provider_changed":     // 更新状态栏
    case "tool_confirm_required": // 显示工具确认弹窗（Spec 5 后生效）
  }
}
```

**约束：**
- UI 层对 `AgentRunner` 的唯一写入操作为 `send()`、`abort()`、`switchProvider()`、`confirmToolCall()`
- UI 层不直接访问 `ProviderRegistry` 或任何 provider 实现
- `AgentRunner` 不持有任何 React 状态或组件引用

### 9. 文件结构

```
src/agent/
├── events.ts           # AgentEvent 联合类型（Spec 1 已有，本 Spec 扩展）
├── runner.ts           # AgentRunner 接口 + createAgentRunner() 工厂函数
├── history.ts          # ConversationHistory 接口 + 默认实现
├── provider/           # Spec 1 已定义，本 Spec 补充 AbortSignal 支持
│   ├── types.ts        # LLMProvider 接口（新增 options.signal 参数）
│   ├── registry.ts
│   ├── impl/
│   │   ├── openai.ts
│   │   ├── anthropic.ts
│   │   ├── azure.ts
│   │   └── ollama.ts
│   └── errors.ts
└── index.ts            # 统一导出 AgentRunner、createAgentRunner、AgentEvent 等
```

`createAgentRunner(registry: ProviderRegistry): AgentRunner` 作为工厂函数，在 `src/main.ts` 或应用入口初始化，注入到 UI。

---

## 验收标准

- [ ] `AgentRunner` 接口与 `ConversationHistory` 接口有完整 TypeScript 类型定义，`bunx tsc --noEmit` 通过
- [ ] `send()` 调用后，事件序列为：`user_input` → `thinking` → N×`stream_chunk` → `stream_done`
- [ ] streaming 过程中调用 `abort()`，事件序列为：`agent_abort`（含已接收的 `partialText`）
- [ ] 在 stream 进行中再次调用 `send()`，旧 stream 被中止（emit `agent_abort`），旧流 `agent_abort` 事件先于新流 `user_input` 事件到达 UI（状态机保证顺序）
- [ ] provider 返回 `auth_failed` 错误时，emit `stream_error { kind: "auth_failed" }`，无未捕获异常
- [ ] provider 返回 `network_timeout` 错误时，emit `stream_error { kind: "network_timeout" }`，无未捕获异常
- [ ] `reset()` 后对话历史清空，下次 `send()` 携带空历史（仅 system prompt）
- [ ] `switchProvider()` 成功后 emit `provider_changed`，下次 `send()` 使用新 provider
- [ ] `AgentRunner` 不持有任何 UI 引用；UI 层不直接引用任何 provider 实现
- [ ] `LLMProvider.stream()` 签名支持 `options.signal`，各 provider 实现将 signal 传入底层 `fetch`
- [ ] `dispose()` 后 `events` 迭代器正常结束，无内存泄漏
- [ ] `before_user_message` hook 执行时机在 `ConversationHistory.append()` 之前；hook 以退出码 2 阻断时，emit `hook_blocked`，历史和磁盘均无写入
- [ ] `abort()` 在 `ABORTING` 状态下调用 `subagentManager.cancelAll()`（Spec 5/9 接入后验证）
- [ ] `confirmToolCall()` 方法存在，且 abort() 调用时所有待决 confirm 以 approved=false 结算（Spec 5 接入后验证）
- [ ] **TUI 触发路径**：需在 Spec 4 定义 abort 的触发快捷键（如 `Ctrl+C` 或上下文感知 `Esc`），本 Spec 的 `abort()` 方法须有可验证的 TUI 触发路径（P2-09）

---

## 验证方式

1. **类型检查：** `bunx tsc --noEmit` 全量通过
2. **单元测试（`bun test`）：**
   - 使用 mock `LLMProvider`（可控 yield 时机）验证事件序列
   - 模拟 abort 验证 `agent_abort` 事件及 `partialText` 内容
   - 模拟 provider throw 各类 `LLMError` 验证 `stream_error` 的 `kind` 字段
3. **集成验证：** 接入真实 provider（如 Ollama 本地），在 TUI 中手动验证流式渲染与 Esc 中止
4. **边界验证：** 手动触发 streaming 中途断网，确认 `stream_error` 而非进程崩溃

---

## 回滚策略

`AgentRunner` 完全封装于 `src/agent/` 目录，UI 层（`App.tsx`）当前仍为占位实现（`useState` mock）。回滚只需：

1. 移除 `src/agent/runner.ts` 和 `src/agent/history.ts`
2. 撤销 `src/agent/events.ts` 中新增的三个事件类型（`user_input` / `thinking` / `agent_abort`）及 `tool_confirm_required`
3. 撤销 `src/agent/provider/types.ts` 中 `options.signal` 参数（向后兼容，可选参数，移除不影响现有 provider 实现）

**回滚 Spec 3 时**（P0-03）：若已迁移到 `SessionManager`，需恢复 `src/agent/history.ts` 的 `ConversationHistory` 占位实现，并将 `AgentRunner` 引用切回 `ConversationHistory`。

`App.tsx` 占位逻辑无需改动，TUI 渲染不受影响。

---

## 附录：AgentEvent 权威类型定义（P0-01）

> **规则声明**：以下为 Spec 1–2 定义的所有 `AgentEvent` 类型的完整列表。后续 Spec 只追加新类型，**不得重定义已有类型**。最终权威源为 `src/agent/events.ts`，任何 Spec 与该文件有出入时，以源码文件为准。

| 事件类型 | 定义 Spec | payload 字段 | 说明 |
|----------|-----------|--------------|------|
| `stream_chunk` | Spec 1 | `{ delta: string }` | LLM 增量输出一段文本 |
| `stream_done` | Spec 1 | `{ totalText: string; stopReason: "stop" \| "tool_use" }` | LLM 本轮输出完成；`stopReason === "tool_use"` 时 AgentOrchestrator 进入工具调用分支 |
| `stream_error` | Spec 1 | `{ kind: LLMErrorKind; message: string }` | LLM 调用出错 |
| `provider_changed` | Spec 1 | `{ providerId: string; model: string }` | Provider 切换成功 |
| `provider_change_error` | Spec 1（P2-03 新增） | `{ providerId: string; reason: string }` | Provider 切换失败，UI 显示错误并保持原 provider |
| `user_input` | Spec 2 | `{ text: string; messageId: string }` | 用户提交输入，UI 立即追加用户消息气泡 |
| `thinking` | Spec 2 | `{ messageId: string }` | AgentRunner 开始处理，UI 显示"思考中" |
| `agent_abort` | Spec 2 | `{ messageId: string; partialText: string }` | 用户或系统主动中止流，UI 标记消息为"已中止" |
| `tool_confirm_required` | Spec 2（接口预留，Spec 5 实现） | `{ toolCallId: string; toolName: string; input: unknown; safetyLevel: "confirm" \| "dangerous" }` | 需要用户确认工具调用；UI 通过 `AgentRunner.confirmToolCall()` 回传决策 |
| `stream_thinking_chunk` | Spec 1.1 | `{ delta: string; messageId: string }` | 接收到一段 thinking 增量文本；UI 追加至对应消息的 `streamingThinking` |
| `stream_thinking_done` | Spec 1.1 | `{ totalThinking: string; messageId: string }` | thinking 内容完整接收完毕；UI 将 `streamingThinking` 合并写入 `thinking` |

> 后续 Spec 追加的类型（如 `context_trimmed`、`hook_blocked`、`memory_added` 等）将在对应 Spec 中定义，并在 `src/agent/events.ts` 中追加，不修改上表已有条目。
