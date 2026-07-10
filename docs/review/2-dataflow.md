# 数据流与状态管理审查报告

> 审查日期：2026-07-10  
> 审查范围：Spec 1–9（数据流、状态管理、竞态条件视角）

---

## 问题列表

### [D-01] `switchProvider()` 在 streaming 进行中被调用，无终止旧流逻辑

- **涉及 Spec**：Spec 1、Spec 2
- **问题描述**：`AgentRunner.send()` 有明确的互斥处理（若有进行中的 stream，先调用 abort()），但 `AgentRunner.switchProvider(providerId: string): Promise<void>` 没有类似处理。当 streaming 正在进行时调用 `switchProvider()`：① `ProviderRegistry` 立即切换活跃 provider；② UI 收到 `provider_changed` 事件，状态栏显示新 provider；③ 但当前 stream 仍用**旧 provider 实例**（引用已在 closure 内捕获）继续输出；④ `stream_done` 携带旧 provider 的回复并写入 `ConversationHistory`；⑤ 下一次 `send()` 才用新 provider。结果是 UI 显示"已切换到 GPT-4"，但当前助手回复实际来自 Anthropic，并被存入历史，语义混乱。
- **建议**：`switchProvider()` 内部应先检查 `currentAbortController`，若存在则先 abort 当前流、等待 `agent_abort` 事件 emit 后再切换 provider 并 emit `provider_changed`。或者定义明确语义：切换仅对下次请求生效，并在 UI 上注明"下条消息起生效"。

---

### [D-02] `send()` 中"先 abort 再启动"的顺序无保障，内部状态机未定义

- **涉及 Spec**：Spec 2
- **问题描述**：Spec 2 Section 6 的伪代码注释写道"等待 agent_abort 事件 emit 后再继续（通过内部状态机保证顺序）"，但 `send()` 签名为 `void`（非 `async`），且规格中从未定义该"内部状态机"的实现方式。`abort()` 触发 `AbortController.abort()` 后，`AgentAbortEvent` 的 emit 发生在异步 catch 块中（捕获到 `AbortError` 时），属于异步操作。若 `send()` 在 abort 后同步继续执行：① 新的 `messageId` 已生成并 emit `UserInputEvent`；② 旧流的 `AgentAbortEvent` 可能在新流的 `ThinkingEvent` 之后才到达 UI；③ 旧流的 `partialText` 在 UI 中仍处于 streaming 状态时就收到了新消息的 `UserInputEvent`，消息顺序错乱。
- **建议**：将 `send()` 改为 `async`，在 abort 后显式 await 一个"当前流已终止"的信号（如内部 Promise）再启动新流。或定义清晰的 `IDLE / STREAMING / ABORTING` 状态机，在 `ABORTING` 状态时将新的 `send()` 入队，待 `IDLE` 后再处理。

---

### [D-03] `SessionManager.flushMeta()` 读-改-写非原子，异步并发下丢失消息

- **涉及 Spec**：Spec 3
- **问题描述**：Spec 3 Section 5 描述 `flushMeta()` 的实现方式为"读取整个文件内容，替换第一行后整体写回"。同一时刻有两处合法的异步并发调用路径：① 用户发送消息（`appendMessage(user_msg)`）和 LLM 回复完成（`appendMessage(assistant_msg)`）均触发 `flushMeta()`；② Spec 8 的自动 memory 提取在 `stream_done` 后也可能触发 SessionManager 写操作。Bun 的异步 I/O 允许多个 `await Bun.file(...).write(...)` 交错执行。Race 场景示例：
  1. `appendMessage(user_msg)` append 行后，await flushMeta 读文件 → 文件内容为 [meta_v1, msg1]
  2. `appendMessage(assistant_msg)` append 行后，await flushMeta 读文件 → 文件内容为 [meta_v1, msg1, msg2]
  3. 步骤 1 的 flushMeta 写回 [meta_v2, msg1]（只有两行，msg2 丢失）
  4. 步骤 2 的 flushMeta 写回 [meta_v2, msg1, msg2]（覆盖步骤3，msg2 恢复）
  
  若步骤顺序稍有不同，最终文件可能永久丢失某条消息。
- **建议**：将 session 元数据（`SessionMeta`）拆入独立的 `<id>.meta.json` 文件，与消息 JSONL 分离；消息 JSONL 只做追加，永不读-改-写整个文件。或引入异步互斥锁（如 `p-limit` 或自写 Mutex），保证单个 session 文件的操作串行化。

---

### [D-04] `ContextManager.buildPrompt()` 的 token 预算未包含 memory 注入量，可能超出模型上下文窗口

- **涉及 Spec**：Spec 3、Spec 8
- **问题描述**：Spec 3 的裁剪逻辑触发条件为"messages 总 `tokenEstimate` 超过 `settings.contextWindow * 0.9`"，且优先级规则第1条为"保留全部 system 消息"。Spec 8 的注入流程在 agent 启动时将 memory context block（最大 2000 字符，约 500 token）拼接到 system prompt 末尾。`ContextConfig.systemPrompt` 包含了已注入 memory 的完整 system prompt，但 `buildPrompt()` 计算裁剪阈值时，只对 `role: "user" | "assistant"` 消息进行 token 估算，system 消息的 token 数不参与阈值比较（因为 system 消息始终保留，不裁剪）。

  实际发给 LLM 的 token 数 = system_prompt_tokens + message_tokens_after_trim。  
  而阈值约束只控制 message_tokens_after_trim ≤ contextWindow × 0.9。  
  若 system_prompt（含 memory）为 1000 token，contextWindow 为 4096，则实际发送可达 1000 + 4096×0.9 ≈ 4686 token，超出 contextWindow。对于支持更大窗口的模型（如 128K）此问题不严重，但对窗口较小的 Ollama 本地模型（如 llama3 的 8K 窗口）会导致截断或 API 报错。

- **建议**：`ContextManager.buildPrompt()` 应先计算 system prompt 的 `tokenEstimate`，再以 `contextWindow - system_token_estimate - reply_reserve` 作为 messages 的实际可用预算，而非直接使用 `contextWindow * 0.9`。`ContextConfig` 应增加 `systemPromptTokenEstimate` 字段，由调用方在注入 memory 后传入。

---

### [D-05] `ToolConfirmRequiredEvent` 在事件 payload 中嵌入 `resolve` 回调，违反 Agent-UI 解耦原则并可能死锁

- **涉及 Spec**：Spec 5
- **问题描述**：Spec 5 Section 6 的 `ToolConfirmRequiredEvent` 定义：
  ```ts
  export interface ToolConfirmRequiredEvent {
    type: "tool_confirm_required"
    ...
    resolve: (approved: boolean) => void  // 事件 payload 中的函数引用
  }
  ```
  这在两方面违背 paw 架构原则：
  
  **① 违反解耦原则**：paw 核心原则是"Agent 编排逻辑与 UI 渲染完全解耦，只通过 AgentEvent 通信"。`resolve()` 是 UI 直接调用 ToolExecutor 内部 Promise 的反向通道，不是事件通信，而是函数调用耦合。
  
  **② 死锁风险**：`ToolExecutor.execute()` 内部 await 该 Promise，直到 UI 调用 `resolve()` 才继续。但 Spec 4 的 Overlay 关闭逻辑（Esc 触发 `onClose`）没有明确要求调用 `resolve(false)`；如果用户按 Esc 关闭确认弹窗（而非选择 y/n），`resolve()` 可能永远不被调用，导致 `ToolExecutor` 和整个 Agent 编排循环永久挂起，用户无法继续对话也无法通过 abort 解除（因为 abort 只取消 provider.stream()，不取消等待中的 confirmFn Promise）。

- **建议**：改为双向事件通道：`tool_confirm_required` 事件不携带 `resolve` 回调；UI 层通过 `agentRunner.respond(toolCallId, approved: boolean)` 方法（或新增 `tool_confirm_response` 事件 + `AgentRunner.send()` 变体）回传决策，ToolExecutor 维护 `Map<toolCallId, resolver>` 内部映射。同时规定 `abort()` 调用时，所有待决的 confirmFn 应自动以 `approved=false` 结算。

---

### [D-06] `before_user_message` / `before_tool_call` hook 阻断后，ConversationHistory 和 JSONL 未回滚

- **涉及 Spec**：Spec 2、Spec 3、Spec 7
- **问题描述**：Spec 2 的核心循环在 `before_user_message` hook 运行前已执行：
  1. emit `UserInputEvent`（UI 显示用户消息）
  2. 将用户消息 append 到 `ConversationHistory`
  3. Spec 3 的 sync 策略：用户发送消息时"立即 appendMessage（异步写盘）"

  即 hook 触发前，消息已显示于 UI、存入内存历史、写入磁盘 JSONL。当 hook 以退出码 2 阻断时，Spec 7 仅定义 emit `hook_blocked` 事件，但 **Spec 2 和 Spec 3 均未定义任何回滚路径**：
  - UI 中的用户消息泡无法撤销（已渲染）
  - ConversationHistory 中的 user 消息条目仍在（下次 send() 会把这条无对应 reply 的 user 消息发给 LLM）
  - JSONL 中已有该消息行（重启后加载历史会看到一条孤立的无回复用户消息）

  `before_tool_call` 阻断后同样存在问题：Spec 5 的 AgentOrchestrator 已将 `{ role: "assistant", toolCalls: [...] }` 消息追加到 messages history，但对应的 `tool_result` 永远不会追加，导致 messages 数组中出现无 result 的 toolCalls 消息，下次发给 LLM 时格式非法（Anthropic 和 OpenAI 都要求 assistant tool_calls 必须跟 tool_result 消息）。

- **建议**：将 `before_user_message` hook 的执行时机提前至步骤 2（ConversationHistory append）和步骤 3（disk write）之前；如果阻断，只 emit `hook_blocked` 事件，UI 不展示用户消息（或展示灰色"已阻断"状态），ConversationHistory 和 JSONL 均不写入。`before_tool_call` 阻断时，不将 assistant toolCalls 消息写入 messages history，而是将整个工具调用轮次视为"未发生"。

---

### [D-07] `before_spawn_subagent` 未纳入 Spec 7 的 `HookEvent` 类型，阻断机制语义矛盾

- **涉及 Spec**：Spec 7、Spec 9
- **问题描述**：Spec 7 定义了 `HookEvent` 联合类型（7 个触发点），Spec 9 Section 9 新增了 `before_spawn_subagent` 和 `after_spawn_subagent` 两个触发点，但 **Spec 7 的 `HookEvent` 类型从未更新**：
  ```ts
  // Spec 7 当前定义，缺少 Spec 9 新增的两个触发点：
  export type HookEvent =
    | "before_user_message" | "after_assistant_message"
    | "before_tool_call"    | "after_tool_call"
    | "on_session_start"    | "on_session_end"
    | "on_provider_change"
  ```
  
  此外，Spec 9 描述 `before_spawn_subagent` hook "可以返回 `{ cancel: true }` 来阻止 Subagent 派发"，但 Spec 7 的阻断机制是通过 shell 命令退出码 2 实现的（`blocked: exitCode === 2`），shell 命令不能"返回 JavaScript 对象"。Spec 9 的 `{ cancel: true }` 返回值与 Spec 7 的 `exitCode === 2` 协议完全不同，两者无法在同一框架下统一实现。

- **建议**：将 `before_spawn_subagent` 和 `after_spawn_subagent` 补充到 Spec 7 的 `HookEvent` 类型定义；阻断语义统一使用 exitCode 2（与现有 `before_tool_call` 阻断机制一致），删除 Spec 9 中不一致的 `{ cancel: true }` 描述。

---

### [D-08] `SubagentRunner` 会通过 `SessionManager.appendMessage()` 将 Subagent 消息写入活跃 session JSONL，违背隔离设计

- **涉及 Spec**：Spec 3、Spec 9
- **问题描述**：Spec 9 明确要求 Subagent 拥有独立消息历史，"Subagent 结束后，其消息历史随之销毁（不写回 Orchestrator）"。但 Spec 3 的 sync 策略规定"用户发送消息 → 立即 appendMessage" / "LLM 回复完成 → 立即 appendMessage"，这些调用在 AgentRunner 的核心循环内执行。`SubagentRunner` 是对 `AgentRunner` 的"薄包装"——如果它复用底层 AgentRunner 实现，则 Subagent 的每条 user 消息和 assistant 回复都会通过 `SessionManager.appendMessage()` 写入**当前活跃 session 的 JSONL 文件**。

  结果：① Subagent 的中间推理消息出现在用户的对话历史中，语义污染；② 应用重启后，Subagent 的孤立消息被加载到历史，但没有对应的上下文，造成混乱；③ 违背了 Spec 9 "消息历史随之销毁" 的设计意图。

- **建议**：`SubagentRunner` 应使用独立的纯内存 `ConversationHistory` 实现（不调用 `SessionManager`），或为 `SessionManager` 增加 `dry-run` / `ephemeral` 模式，在该模式下 `appendMessage()` 只更新内存、不写磁盘。需在 Spec 3 中明确 SessionManager 的调用入口与隔离边界。

---

### [D-09] `AgentRunner.abort()` 在 Subagent 运行期间无法传播，用户取消操作失效

- **涉及 Spec**：Spec 2、Spec 9
- **问题描述**：Spec 2 的 `abort()` 机制通过 `currentAbortController.abort()` 取消 `provider.stream()` 的 fetch 请求。但当 Orchestrator 正处于 `await SubagentManager.spawnBatch(...)` 阶段时（非 streaming，而是等待并发子任务完成），`currentAbortController` 控制的是已结束的那个 provider.stream()，对 `spawnBatch()` 的 Promise 没有取消效果。

  用户调用 `abort()` 时，若 Orchestrator 正在等待 3 个 Subagent 完成（默认超时 60s），`abort()` 不会中断等待，Agent 循环将继续运行最多 60 秒，用户看起来"取消成功"（收到 `agent_abort`）但 Subagent 仍在后台消耗 API quota。

  Spec 9 的 `SubagentManager.cancelAll()` 接口存在，但 **Spec 2 中 `AgentRunner.abort()` 没有调用 `cancelAll()` 的设计路径**，两者之间的连接完全缺失。

- **建议**：AgentOrchestrator 在启动 `spawnBatch()` 前，将 `SubagentManager` 引用注册到 `AgentRunner`；`abort()` 调用时，同时触发 `subagentManager.cancelAll()`，并将 `spawnBatch()` 的 Promise 包装为可取消的（通过 `AbortSignal` 传入 `SubagentManager.spawnBatch()`）。

---

### [D-10] Subagent memory 写入隔离的"前缀"机制与 `MemoryEntry.id` 字段格式冲突

- **涉及 Spec**：Spec 8、Spec 9
- **问题描述**：Spec 9 Section 5.3 声明"Subagent 写入的 key 强制加前缀 `subagent:{subagentId}:`"，但 Spec 8 的 `MemoryEntry` 数据结构中并不存在名为 `key` 的字段——只有 `id`（格式为 `mem_` + nanoid）、`content`、`type`、`scope` 等字段。"key" 这一概念未在 Spec 8 中定义，导致：

  ① 不清楚前缀应加在哪个字段（`id`？自定义 `key` 字段？）；  
  ② `id` 字段若加前缀则与 `mem_<nanoid>` 格式约定冲突，影响 `MemoryStore.delete(id)` 等按 id 操作的接口；  
  ③ 隔离执行点未定义：`MemoryStore.add()` 的调用者是谁负责加前缀（SubagentRunner？MemoryStore 本身？），Spec 中无说明；  
  ④ `memoryAccess.write: false` 时"写 memory 操作被拒绝"的拦截点同样未定义。

- **建议**：在 Spec 8 的 `MemoryEntry` 中明确增加可选字段 `namespace?: string`，用于标识来源（`subagent:{id}` 或 `orchestrator`）；`MemoryStore.add()` 增加可选 `namespace` 参数，由调用层注入；SubagentRunner 持有带 `namespace` 约束和 `write` 权限标志的 `ScopedMemoryStore` 包装器，统一执行准入控制。

---

### [D-11] Persona 运行时切换与 Provider 运行时切换的持久化语义均未明确定义

- **涉及 Spec**：Spec 1、Spec 6
- **问题描述**：  
  - Spec 1 的 `settings.json` 含 `activeProvider` 字段，Spec 2 的 `AgentRunner.switchProvider()` 切换 provider，但两个 Spec 均未说明切换后是否写回 `settings.json`。  
  - Spec 6 的 `PersonaRegistry.switchTo(id: string): void` 是同步方法（`void`），无法异步写文件，也未说明是否持久化 `activePersona`。

  若切换不持久化，应用重启后恢复 `settings.json` 中的初始值，用户的切换操作丢失，属于"静默状态重置"。若需要持久化，当前设计中 `switchTo()` 为 `void`（同步）不支持写文件，且多个组件可能同时写 `settings.json`（Spec 1 的 provider、Spec 6 的 persona）存在并发写冲突风险，而 `settings.json` 没有任何写锁机制。

- **建议**：在两个 Spec 中明确声明持久化语义（"切换仅本次会话有效"或"持久化到 settings.json"）。若需持久化，应提取一个统一的 `SettingsWriter` 组件，所有 settings.json 写操作串行化通过该组件执行，避免并发覆盖。`PersonaRegistry.switchTo()` 改为 `async switchTo(id: string): Promise<void>` 以支持异步写盘。

---

## 总结

| 编号 | 严重程度 | 涉及 Spec | 分类 |
|------|----------|-----------|------|
| D-01 | 中 | Spec 1、2 | 竞态条件 |
| D-02 | 高 | Spec 2 | 竞态条件 / 状态机缺失 |
| D-03 | 高 | Spec 3 | 持久化竞争 |
| D-04 | 中 | Spec 3、8 | context 预算计算对齐 |
| D-05 | 高 | Spec 5 | Agent-UI 耦合 / 死锁风险 |
| D-06 | 高 | Spec 2、3、7 | Hook 阻断后状态回滚缺失 |
| D-07 | 中 | Spec 7、9 | 类型定义不一致 |
| D-08 | 高 | Spec 3、9 | 状态隔离被穿透 |
| D-09 | 中 | Spec 2、9 | 竞态条件 / abort 传播缺失 |
| D-10 | 中 | Spec 8、9 | 状态隔离接口设计冲突 |
| D-11 | 低 | Spec 1、6 | 持久化语义未定义 |

**最高优先级修复**（阻断实现）：D-05（ToolConfirmRequiredEvent 死锁）、D-06（hook 阻断状态回滚）、D-08（Subagent 消息泄漏到 session JSONL）、D-03（SessionManager 文件写竞争）。

**次优先级**（影响正确性）：D-02（send 顺序无保障）、D-09（abort 传播缺失）。

**设计澄清类**（不阻断实现但需尽早对齐）：D-01、D-04、D-07、D-10、D-11。
