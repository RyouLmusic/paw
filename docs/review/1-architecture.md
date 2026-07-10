# 架构一致性审查报告

## 问题列表

### [A-01] AgentEvent 联合类型在 Spec 5 中被重定义，且结构与 Spec 2 不兼容

- **涉及 Spec**：Spec 2、Spec 5
- **问题描述**：Spec 2 采用 discriminated union 接口形式定义 `AgentEvent`，每个事件类型均为独立接口，payload 统一嵌套在 `payload` 字段中（例如 `StreamChunkEvent { type: "stream_chunk"; payload: { delta: string } }`）。但 Spec 5 的 `AgentEvent` 联合类型直接将 payload 字段平铺到顶层（例如 `{ type: "stream_chunk"; delta: string }`），两者对同一事件类型的结构完全不同。任何消费方按其中一种格式处理，在另一种格式下会产生类型错误或运行时崩溃。
- **建议**：全局统一 `AgentEvent` 结构。建议采用 Spec 2 的嵌套 `payload` 形式，它更具扩展性，能防止顶层字段命名冲突。在 `src/agent/events.ts` 中以 Spec 2 格式为准，Spec 5 的联合类型需对齐修改。

---

### [A-02] StreamChunk 类型的 `done` 字段被 Spec 5 破坏性改变

- **涉及 Spec**：Spec 1、Spec 2、Spec 5
- **问题描述**：Spec 1 定义 `StreamChunk = { delta: string; done: boolean }`，Spec 2 的核心循环逻辑基于 `done === false` 累积增量文本、`done === true` 触发 `stream_done` 事件。Spec 5 将 `StreamChunk` 拆分为三个独立的 discriminated union 类型（`TextDeltaChunk / ToolCallChunk / DoneChunk`），其中 `DoneChunk` 新增了 `stopReason` 字段，原来的 `done: boolean` 标志不再独立存在。Spec 2 的 `AgentRunner` 代码需要完整重写才能适配新的判断逻辑，但 Spec 5 仅说明"保持向后兼容，不传工具时行为不变"，没有说明 Spec 2 的循环代码需要同步更新。
- **建议**：Spec 5 应明确标注对 Spec 2 `AgentRunner` 核心循环的改动要求，尤其是 `DoneChunk` 中 `stopReason === "tool_use"` 分支的处理逻辑须显式纳入 Spec 2 或作为独立的迁移说明。

---

### [A-03] `AgentEvent` 联合类型跨 Spec 分散定义，缺乏统一的权威版本

- **涉及 Spec**：Spec 1、Spec 2、Spec 3、Spec 4、Spec 5、Spec 6、Spec 7、Spec 8、Spec 9
- **问题描述**：9 个 Spec 共向 `src/agent/events.ts` 贡献了至少 27 个 `AgentEvent` 类型（Spec1: 4 个，Spec2: 3 个，Spec3: 4 个，Spec4: 1 个，Spec5: 4 个，Spec6: 2 个，Spec7: 3 个，Spec8: 3 个，Spec9: 4 个），但没有任何一个 Spec 给出完整的联合类型声明。每个 Spec 仅关注自己新增的部分，各自定义局部 `AgentEvent` 联合类型（Spec 2 和 Spec 5 各自给出了完整联合类型，但两者结构互相冲突，且均未包含后续 Spec 的类型）。这在实现阶段将面临"以哪个版本为准"的歧义。
- **建议**：将 `src/agent/events.ts` 的权威定义交由一份专门文档或专人维护，明确每个 AgentEvent 类型的归属 Spec、结构版本，并要求后续 Spec 仅追加类型、不重定义已有类型。

---

### [A-04] Spec 4 新增的 `input_submitted` 事件方向违反 Agent-UI 解耦原则

- **涉及 Spec**：Spec 2、Spec 4
- **问题描述**：Spec 2 明确规定 `AgentEvent` 是单向事件总线，仅从 Agent 层流向 UI 层，UI 层对 AgentRunner 的唯一写入操作是调用 `send()` / `abort()` / `switchProvider()` 方法。但 Spec 4 定义了 `input_submitted` 事件，其触发方为 UI（InputArea 按 Enter），而非 Agent 层，属于 UI → Agent 方向的事件。这与整个架构的事件单向流动原则相悖，且与 `AgentRunner.send()` 方法的职责高度重叠（Spec 4 第 5.4 节已描述 Enter 触发 `send()` 调用）。
- **建议**：删除 `input_submitted` 作为 `AgentEvent` 的方案。UI 层发起输入应统一通过调用 `AgentRunner.send(text)` 实现，`AgentRunner` 收到后 emit `user_input` 事件（Spec 2 已有），UI 监听此事件追加用户消息到渲染列表。若确实需要在 UI 内部传递"已提交"状态，应作为 React 内部状态管理，而非 AgentEvent 协议的一部分。

---

### [A-05] Spec 3 的 `ConversationHistory` 与 Spec 2 的 `ConversationHistory` 命名和职责冲突

- **涉及 Spec**：Spec 2、Spec 3
- **问题描述**：Spec 2 在 `src/agent/history.ts` 定义了 `ConversationHistory` 接口，包含 `append()` / `toMessages()` / `clear()` / `entries` 等方法，由 `AgentRunner` 持有。Spec 3 在 `src/agent/context/` 目录另行定义了 `Session`（含 `messages: MessageRecord[]`）和 `SessionManager`，同样管理对话历史，并通过 `ContextManager.buildPrompt()` 构造发送给 LLM 的 `ChatMessage[]`。两套机制功能高度重叠，均以对话消息为中心，但使用了不同的数据类型（`HistoryEntry` vs `MessageRecord`，两者结构相似但字段不同，如 `MessageRecord` 多了 `id`、`createdAt`、`tokenEstimate`）。Spec 3 没有说明它将取代还是包装 Spec 2 的 `ConversationHistory`，且 Spec 2 回滚策略中说明"移除 `src/agent/history.ts`"，意味着 Spec 3 实现后 Spec 2 的 `ConversationHistory` 应退场，但此依赖关系在两个 Spec 中均未显式说明。
- **建议**：明确 Spec 3 的 `SessionManager` + `ContextManager` 是对 Spec 2 `ConversationHistory` 的替代（而非并存）。应在 Spec 3 中说明：实现 Spec 3 后，`src/agent/history.ts` 中的 `ConversationHistory` 被废弃，`AgentRunner` 改持 `SessionManager` 引用并通过 `ContextManager.buildPrompt()` 构建每次请求的消息切片。

---

### [A-06] Spec 3 的 `ContextManager` 直接依赖 `AgentEvent` 发送能力，但未定义注入接口

- **涉及 Spec**：Spec 2、Spec 3
- **问题描述**：Spec 3 第 2 节规定"当 `trimmedCount > 0` 时，`ContextManager` 向事件总线发出 `context_trimmed` 事件"，但 `ContextManager` 的接口定义（`buildPrompt(session, config): TrimResult`）是纯函数签名，没有事件发送能力。按 Spec 2 的架构，事件总线的控制权在 `AgentRunner`，`ContextManager` 作为 Agent 层的工具组件不应直接持有事件发送器引用。相比之下，Spec 5 的 `ToolExecutor` 构造函数中显式注入了 `emitter: (event: AgentEvent) => void`，形成了明确的依赖注入模式。Spec 3 的 `ContextManager` 未遵循同样的模式。
- **建议**：将 `ContextManager` 改为返回 `TrimResult`（含 `trimmedCount`），由调用方（`AgentRunner` 或 `AgentOrchestrator`）在 `trimmedCount > 0` 时主动 emit `context_trimmed` 事件，保持 `ContextManager` 为无副作用的纯计算组件。这与 Spec 5 `ToolExecutor` 的依赖注入模式保持一致。

---

### [A-07] Spec 6 的 `PersonaRegistry.switchTo()` 直接调用 `ProviderRegistry`，违反模块边界

- **涉及 Spec**：Spec 1、Spec 6
- **问题描述**：Spec 6 第 7 节 `PersonaRegistry` 接口注释中明确说明 `switchTo(id)` 会"若绑定了 `providerId`，同步通知 ProviderRegistry"。这意味着 `PersonaRegistry` 持有 `ProviderRegistry` 的直接引用，形成了 persona 模块 → provider 模块的依赖。按照 Spec 2 定义的分层，provider 层是基础层，persona 层是 config 层，两者应通过 `AgentEvent`（`persona_changed` 携带 `providerId?`）或 `AgentRunner`/`AgentOrchestrator` 中间层联动，而非 persona 模块直接操作 provider 模块。
- **建议**：`PersonaRegistry.switchTo()` 应只 emit `persona_changed` 事件（已在 Spec 6 中定义，payload 含 `providerId?`），由 `AgentRunner` / `AgentOrchestrator` 监听到此事件后调用 `switchProvider()` 完成联动。这样 persona 模块无需感知 provider 模块的存在。

---

### [A-08] Spec 7 新增的 Hook 触发点 `before_spawn_subagent` / `after_spawn_subagent` 在 Spec 7 中不存在

- **涉及 Spec**：Spec 7、Spec 9
- **问题描述**：Spec 9 第 9 节提到 Hook 系统需要两个新触发点：`before_spawn_subagent` 和 `after_spawn_subagent`，并且 `before_spawn_subagent` 支持返回 `{ cancel: true }` 来阻止 Subagent 派发。但 Spec 7 的 `HookEvent` 联合类型仅定义了 7 个触发点，不含这两个。此外，Spec 7 的阻止机制是基于退出码（`exitCode === 2`），而 Spec 9 描述的阻止方式是返回对象 `{ cancel: true }`，两者不兼容。
- **建议**：Spec 7 需追加 `before_spawn_subagent` 和 `after_spawn_subagent` 到 `HookEvent` 联合类型，同时统一阻止机制：`before_spawn_subagent` 的阻止也应通过退出码 `2` 实现（与其他 `before_*` 触发点一致），而非返回对象，避免引入第二套阻止协议。

---

### [A-09] Spec 8 的 Memory 模块位于 `src/memory/`，与 Agent 模块隔离，但初始化顺序依赖 Spec 6（Persona）未明确

- **涉及 Spec**：Spec 6、Spec 8
- **问题描述**：Spec 8 第 7 节说明启动时将 memory context block "拼接到 Spec 6 中 `settings.json systemPrompt` 之后"。这意味着 Memory 注入逻辑（`inject.ts`）依赖 Spec 6 的 `PersonaRegistry.resolveSystemPrompt()` 先完成执行，才能在其结果末尾拼接 memory 块。但这一顺序依赖在两个 Spec 中均未通过接口或启动流程图明确表达：Spec 8 只说"拼接到之后"，没有说明由谁来驱动这个拼接、在什么时机调用。`AgentRunner` 还是 `AgentOrchestrator` 负责将两者串联？调用链是 `resolveSystemPrompt()` → `inject(memories)` → 组成最终 system prompt？
- **建议**：应在 `AgentOrchestrator` 或 `AgentRunner` 的初始化流程中明确定义 system prompt 的最终组装步骤：① 调用 `PersonaRegistry.resolveSystemPrompt()` 获取基础 prompt；② 调用 `MemoryStore.load()` 获取 memory 条目；③ 调用 `inject.buildBlock(entries)` 生成 memory 块；④ 拼接为最终 system prompt。这一流程应在某个单独的 Spec 或架构决策文档中明确，而非分散在两个 Spec 中各自表述一半。

---

### [A-10] Spec 9 的 Memory 写入隔离机制（key 前缀）与 Spec 8 的 `MemoryStore` 接口不兼容

- **涉及 Spec**：Spec 8、Spec 9
- **问题描述**：Spec 9 第 5.3 节规定 Subagent 写入 memory 时"key 强制带 `subagent:{subagentId}:` 前缀"。但 Spec 8 的 `MemoryEntry` 结构中没有"key"字段，存储主键是 `id`（格式为 `mem_` + nanoid），条目内容在 `content` 字段中，并没有通过前缀进行命名空间隔离的设计。Spec 9 所述的"key 前缀"与 Spec 8 的 `MemoryStore` 接口完全对不上，这套隔离机制无法在现有 `MemoryEntry` 数据结构上实现。
- **建议**：Spec 9 应改用 Spec 8 已有的 `scope`、`sourceSession` 或新增的 `sourceSubagent` 字段来实现 Subagent memory 的隔离和识别，而非引入与现有数据模型不兼容的"key 前缀"概念。同时 Spec 8 需在 `MemoryEntry` 中增加 `sourceSubagent?: string` 可选字段以支持此需求。

---

### [A-11] Spec 3 的 `contextWindow` 配置与 Spec 2 已有的 `maxHistoryTokens` 语义重复

- **涉及 Spec**：Spec 2、Spec 3
- **问题描述**：Spec 2 第 5 节 `ConversationHistory` 说明"超过 `maxHistoryTokens`（默认 32000）时触发截断"，此参数来源和位置未说明（hardcoded 还是来自 settings.json）。Spec 3 在 `settings.json` 中新增 `contextWindow`（默认 16000）作为裁剪阈值，含义相同但默认值不一致（32000 vs 16000）。如果两者同时存在于代码中，将导致截断策略双重触发或配置语义混乱。
- **建议**：以 Spec 3 的 `contextWindow`（settings.json 配置项）为最终实现，删除 Spec 2 中 `maxHistoryTokens` 的硬编码引用。Spec 2 应注明"上下文截断由 Spec 3 的 `ContextManager` 负责实现，此处为占位描述"。

---

### [A-12] Spec 5 引入 `AgentOrchestrator`，但与 Spec 2 的 `AgentRunner` 职责边界未划定

- **涉及 Spec**：Spec 2、Spec 5
- **问题描述**：Spec 2 定义 `AgentRunner` 为"负责核心 Agent 循环的唯一编排者"，包含 `send()` / `abort()` / `reset()` / `switchProvider()` 等方法，并持有 `ConversationHistory`。Spec 5 在文件结构中新增了 `src/agent/orchestrator.ts`（`AgentOrchestrator`），其负责工具调用回路（接收 `ToolCallChunk` → 执行工具 → 回注 `tool_result` → 递归调用自身）。这造成两个"编排者"并存：`AgentRunner` 负责 send/abort/events 接口，`AgentOrchestrator` 负责工具循环。两者的层级关系（谁包含谁？谁持有另一个的引用？）、事件发送权（`AgentOrchestrator` 直接 emit events 还是通过 `AgentRunner`？）均未在两个 Spec 中明确定义。
- **建议**：应明确架构层次：`AgentRunner` 作为对外接口层（向 UI 暴露 `send/abort/events`），内部委托 `AgentOrchestrator` 执行具体的 LLM + 工具循环。`AgentOrchestrator` 不直接持有 events 发送器，而是通过回调或 AsyncIterable 将事件返回给 `AgentRunner` 统一发射。此关系应在 Spec 2 或 Spec 5 中通过架构图明确表达。

---

## 总结

9 个 Spec 整体架构设计合理，Agent-UI 解耦原则清晰，Provider 分层和配置优先级机制一致。核心问题集中在三个方面：**`AgentEvent` 协议在 Spec 2 和 Spec 5 之间存在结构性不兼容（payload 嵌套 vs 平铺）**；**`AgentRunner` 与 `AgentOrchestrator` 的职责边界及 Spec 2 `ConversationHistory` 与 Spec 3 `SessionManager` 的替代关系均未明确说明**；**Spec 9 的 Memory key 前缀隔离机制与 Spec 8 的 `MemoryEntry` 数据模型存在根本性不兼容**。建议在进入实现前，先统一 `AgentEvent` 结构约定，并补充一份跨 Spec 的初始化流程及模块依赖关系图。
