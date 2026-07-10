# Task: Agent 编排层

| 字段 | 值 |
|------|-----|
| 关联 Spec | docs/specs/2-20260710-agent-orchestration.md |
| 状态 | pending |

---

## 任务清单

### T1 — 扩展 AgentEvent 类型（Spec 2 新增部分）

**文件：** `src/agent/events.ts`

**要做什么：**
- 在 Spec 1 已建立的 `src/agent/events.ts` 基础上追加 Spec 2 新增的以下 4 个事件接口（均采用嵌套 `payload` 格式，遵循 P0-01 约定，不修改已有类型）：
  - `UserInputEvent`：`type: "user_input"`，`payload: { text: string; messageId: string }`；触发时机：用户提交输入时立即 emit，用于 UI 在消息列表中显示用户消息气泡
  - `ThinkingEvent`：`type: "thinking"`，`payload: { messageId: string }`；触发时机：`AgentRunner` 开始处理、发出请求前，用于 UI 显示"思考中"状态
  - `AgentAbortEvent`：`type: "agent_abort"`，`payload: { messageId: string; partialText: string }`；触发时机：用户或系统主动中止了正在进行的 stream，UI 据此将消息标记为"已中止"
  - `ToolConfirmRequiredEvent`：`type: "tool_confirm_required"`，`payload: { toolCallId: string; toolName: string; input: unknown; safetyLevel: "confirm" | "dangerous" }`；触发时机：工具调用需要用户确认（Spec 5 实现后生效）；payload 不含 resolve 回调，UI 通过 `AgentRunner.confirmToolCall()` 回传决策
- 将上述 4 个接口追加到 `AgentEvent` 联合类型中，使联合类型覆盖 Spec 1 的 5 个类型和 Spec 2 的 4 个类型，共 9 个
- 在文件末尾更新权威附录注释，列出 Spec 1–2 定义的全部事件类型及其 payload 说明，注明后续 Spec 追加位置

**预期结果：** `src/agent/events.ts` 包含全部 9 个事件接口和完整的 `AgentEvent` 联合类型，`bunx tsc --noEmit` 通过。后续 Spec 可直接在此文件追加，不需要改动现有定义。

---

### T2 — 实现 ConversationHistory（占位实现）

**文件：** `src/agent/history.ts`

**要做什么：**
- 定义 `HistoryEntry` 接口，包含 `role: "user" | "assistant" | "system"` 和 `content: string` 字段
- 定义 `ConversationHistory` 接口，包含以下方法：
  - `append(entry: HistoryEntry): void`：追加一条记录
  - `toMessages(): ChatMessage[]`：将历史转换为 `LLMProvider.stream()` 所需的 `ChatMessage[]` 格式（`ChatMessage` 从 `src/agent/provider/types.ts` 导入）
  - `clear(): void`：清空历史（后续保留 system prompt 的逻辑由 Spec 3 扩展）
  - `readonly entries: ReadonlyArray<HistoryEntry>`：只读快照，用于序列化或调试
- 实现 `createConversationHistory()` 工厂函数，返回满足 `ConversationHistory` 接口的默认实现（内存存储，基于 `HistoryEntry[]` 数组）
- 在文件顶部注释标明：此为占位实现，Spec 3 实现后将由 `SessionManager` 替代；届时此文件废弃，`AgentRunner` 改持 `SessionManager` 引用

**预期结果：** `src/agent/history.ts` 可被 `AgentRunner` 导入使用，接口定义完整，工厂函数可创建可用实例，`bunx tsc --noEmit` 通过。

---

### T3 — 实现 AgentRunner 接口与三态状态机

**文件：** `src/agent/runner.ts`

**要做什么：**
- 定义 `AgentRunner` 接口，包含以下成员（与 Spec 2 接口定义严格对齐）：
  - `readonly events: AsyncIterable<AgentEvent>`：事件总线，UI 初始化时订阅，整个应用生命周期内持续消费
  - `send(text: string): Promise<void>`：提交用户输入，触发一次完整 Agent 循环（包含 hooks 执行、`UserInputEvent`、`ThinkingEvent`、provider stream、事件输出）
  - `abort(): void`：中止当前进行中的 stream，emit `AgentAbortEvent`；无进行中 stream 时调用无副作用
  - `reset(): Promise<void>`：清空对话历史并重置状态；若有 streaming 进行中，先 abort 再重置
  - `switchProvider(providerId: string): Promise<void>`：转发给 `ProviderRegistry.switchProvider()`，emit `provider_changed` 事件
  - `confirmToolCall(toolCallId: string, approved: boolean): void`：回传工具调用确认决策（Spec 5 接入后生效）；`abort()` 时所有待决 confirm 自动以 `approved=false` 结算
  - `dispose(): void`：释放资源，关闭事件迭代器，中止进行中的请求
- 实现内部三态状态机，状态为 `IDLE | STREAMING | ABORTING`，语义如下：
  - `IDLE`：可接受新请求，`send()` 立即启动新流
  - `STREAMING`：有正在进行的 stream；新 `send()` 先调用 `abort()` 并 await 旧流终止（状态转为 `IDLE`），再启动新流
  - `ABORTING`：已触发 abort，等待当前流终止；新 `send()` 入队，待状态回到 `IDLE` 后处理
  - 用 `streamSettledPromise`（在进入 `STREAMING` 前创建）追踪当前流的终止信号；流结束（正常/中止/出错）时 resolve 此 Promise，状态切换回 `IDLE`
- 实现 `send()` 内的完整 Agent 循环，流程如下：
  1. 执行 `before_user_message` hook（若已配置）；hook 退出码为 2 时，emit `hook_blocked` 事件，流程终止，不写历史不写盘
  2. 生成 `messageId`（使用 `crypto.randomUUID()`）
  3. emit `UserInputEvent { text, messageId }`
  4. 将用户消息追加到 `ConversationHistory`（调用 `history.append()`）
  5. 生成 `replyId`（使用 `crypto.randomUUID()`）
  6. emit `ThinkingEvent { messageId: replyId }`
  7. 创建新的 `AbortController`，保存为 `currentAbortController`
  8. 调用 `provider.stream(history.toMessages(), { signal })`，逐 chunk 处理：
     - `done === false`：emit `StreamChunkEvent { delta }`，并累积到 `accumulatedText`
     - `done === true` 且 `stopReason === "stop"`：emit `StreamDoneEvent { totalText, stopReason: "stop" }`，将 assistant 消息追加到 `ConversationHistory`
     - `done === true` 且 `stopReason === "tool_use"`：emit `StreamDoneEvent { totalText, stopReason: "tool_use" }`，不结束 `STREAMING` 状态（Spec 5 后由 `AgentOrchestrator` 接管工具调用分支）
  9. 异常处理：`AbortError` → emit `AgentAbortEvent { messageId: replyId, partialText: accumulatedText }`；`LLMError` → emit `StreamErrorEvent { kind, message }`；其他 → 归类为 `"unknown"` 后 emit `StreamErrorEvent`
  10. 流结束时（无论正常/中止/出错）：resolve `streamSettledPromise`，清空 `currentAbortController`，状态切换回 `IDLE`
- `AgentRunner` **不得**持有任何 React 组件引用或 UI 状态；所有错误必须经过事件化输出，不得向上逃逸
- 实现 `createAgentRunner(registry: ProviderRegistry): AgentRunner` 工厂函数，接受 `ProviderRegistry` 实例（后续 Spec 5 接入后接受 `AgentOrchestrator`），在 `src/main.ts` 或应用入口调用并注入到 UI

**预期结果：** `AgentRunner` 接口与实现完整，状态机正确管理三态转换，事件输出顺序可预期（`user_input` → `thinking` → N×`stream_chunk` → `stream_done`；abort 时 `agent_abort` 先于新流的 `user_input`），`bunx tsc --noEmit` 通过。

---

### T4 — 更新 LLMProvider.stream() 签名，各 provider 适配 AbortSignal

**文件：**
- `src/agent/provider/types.ts`
- `src/agent/provider/impl/openai.ts`
- `src/agent/provider/impl/anthropic.ts`
- `src/agent/provider/impl/azure.ts`
- `src/agent/provider/impl/ollama.ts`

**要做什么：**
- **`types.ts`**：在 `LLMProvider` 接口的 `stream()` 方法签名中，新增可选的第二个参数 `options?: { signal?: AbortSignal }`，完整签名变为：`stream(messages: ChatMessage[], options?: { signal?: AbortSignal }): AsyncIterable<StreamChunk>`；此变更向后兼容（可选参数），不影响已有调用方
- **各 provider 实现（`impl/` 下四个文件）**：同步更新 `stream()` 方法签名以匹配新接口，将 `options?.signal` 透传给底层 `fetch` 调用的 `signal` 选项，确保 `AbortController.abort()` 能终止进行中的 HTTP 请求

**预期结果：** `LLMProvider` 接口支持 `AbortSignal`，四个 provider 实现均将 signal 正确传入 `fetch`；`bunx tsc --noEmit` 通过；`AbortController.abort()` 调用后对应 `fetch` 请求立即终止。

---

### T5 — 更新 App.tsx，接入 AgentRunner 并替换占位逻辑

**文件：** `src/App.tsx`

**要做什么：**
- 在应用入口（`src/main.ts` 或 `src/App.tsx`）调用 `createAgentRunner(registry)` 创建 `AgentRunner` 实例，将其注入到 `App` 组件（通过 props 或 context）
- 用 `for await (const event of agentRunner.events)` 替换原有的占位 `useState` mock 逻辑，在异步循环中根据 `event.type` 分发处理：
  - `"user_input"`：将用户消息追加到渲染消息列表
  - `"thinking"`：显示加载动画（"思考中"状态）
  - `"stream_chunk"`：增量更新当前 assistant 消息气泡的文本内容
  - `"stream_done"`：隐藏加载动画，将当前消息标记为完成
  - `"stream_error"`：显示差异化错误提示（复用 Spec 1 T8 定义的 `kind` → 提示文本映射）
  - `"agent_abort"`：将正在流式渲染的消息标记为"已中止"，展示已接收的 `partialText`
  - `"provider_changed"`：更新状态栏的 provider 和 model 展示
  - `"tool_confirm_required"`：显示工具确认弹窗（Spec 5 后完整实现，当前可展示占位提示）
- 用户在输入框提交文本时，调用 `agentRunner.send(text)` 替换原占位逻辑
- 绑定中止快捷键（`Ctrl+C` 或上下文感知 `Esc`，具体键位由 Spec 4 确认），触发时调用 `agentRunner.abort()`；此为 `abort()` 的可验证 TUI 触发路径（P2-09）
- 组件卸载或应用退出时调用 `agentRunner.dispose()`，确保事件迭代器正常结束
- UI 层不直接引用任何 `LLMProvider` 实现或 `ProviderRegistry`；所有 Agent 操作均通过 `AgentRunner` 接口完成

**预期结果：** `App.tsx` 完全通过 `AgentRunner` 驱动消息收发，消息流式渲染与 Spec 2 定义的事件序列对齐，占位 mock 逻辑全部移除；`bunx tsc --noEmit` 通过；TUI 中可通过快捷键触发 abort。

---

## 执行顺序

```
T1 → T2 / T4（可并行）→ T3 → T5
```

- **T1**（扩展 AgentEvent）是 T3 和 T5 的前置依赖，必须最先完成；T1 基于 Spec 1 的 `src/agent/events.ts` 追加，需 Spec 1 T7 已完成
- **T2**（ConversationHistory 占位实现）和 **T4**（LLMProvider AbortSignal 适配）互相独立，均依赖 Spec 1 T1（`types.ts`），可在 T1 完成后并行进行
- **T3**（AgentRunner）依赖 T1（`AgentEvent` 类型）、T2（`ConversationHistory`）、T4（`stream()` 带 signal 的接口），需等 T1/T2/T4 全部完成
- **T5**（App.tsx 接入）依赖 T1（事件类型）和 T3（`AgentRunner` 实现），需等 T3 完成

---

## 完成记录

| 任务 | 状态 | 验证结果 |
|------|------|----------|
| T1 — 扩展 AgentEvent 类型（Spec 2 新增部分）| pending | — |
| T2 — 实现 ConversationHistory（占位实现）| pending | — |
| T3 — 实现 AgentRunner 接口与三态状态机 | pending | — |
| T4 — 更新 LLMProvider.stream() 签名，各 provider 适配 AbortSignal | pending | — |
| T5 — 更新 App.tsx，接入 AgentRunner 并替换占位逻辑 | pending | — |
