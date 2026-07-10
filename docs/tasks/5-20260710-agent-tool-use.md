# Task: 工具系统（Tool Use / Function Calling）

| 字段 | 值 |
|------|-----|
| 关联 Spec | docs/specs/5-20260710-agent-tool-use.md |
| 状态 | pending |

---

## 任务清单

### T1 — 定义工具系统核心类型

**文件：** `src/agent/tool/types.ts`

- 定义 `ToolInputSchema` 接口：描述工具入参的 JSON Schema 子集，字段包括 `type`（固定为 `"object"`）、`properties`（各参数描述）、`required`（可选的必填参数列表）
- 定义 `ToolDefinition` 接口：统一工具定义格式，字段包括 `name`（全局唯一）、`description`（向 LLM 描述用途）、`inputSchema`、`safetyLevel`（`"safe" | "confirm" | "dangerous"`）
- 定义 `ToolHandler` 类型别名：工具执行函数签名，接收 `input` 和 `context` 参数，返回 `Promise<ToolResult>`
- 定义 `ToolContext` 接口：执行上下文，包含 `workingDir` 和可选的 `signal: AbortSignal`
- 定义 `ToolResult` 联合类型：成功分支 `{ ok: true; output: string }` 与失败分支 `{ ok: false; error: string }`
- 定义 `RegisteredTool` 接口：注册单元，包含 `definition: ToolDefinition` 和 `handler: ToolHandler`
- 定义 `ToolCallRecord` 接口：用于追加到 messages history，包含 `toolCallId`、`toolName`、`toolInput`

**预期结果：** 所有工具相关类型集中在此文件，`bunx tsc --noEmit` 通过；其他模块可从此文件导入，无循环依赖。

---

### T2 — 实现工具注册中心

**文件：** `src/agent/tool/registry.ts`

- 实现 `ToolRegistry` 类，内部以 `Map<string, RegisteredTool>` 存储已注册工具
- 实现 `register(tool: RegisteredTool): void`：name 冲突时抛出带明确说明的错误，不覆盖已有工具
- 实现 `registerMany(tools: RegisteredTool[]): void`：批量注册，内部调用 `register`，冲突时提前失败
- 实现 `getDefinitions(): ToolDefinition[]`：返回所有已注册工具的 definition 列表（供传给 LLM）
- 实现 `get(name: string): RegisteredTool | undefined`：按名称查找工具（供 `ToolExecutor` 调用）
- 实现用户自定义工具加载逻辑：读取 `settings.json` 中的 `tools.customToolsPath` 配置，用 `import()` 动态加载目录下每个 `.ts` 文件
  - **路径限制**：`customToolsPath` 必须以 `~` 开头（指向用户主目录），指向项目本地路径（`./`、`../`）时拒绝加载并报错
  - **首次确认**：首次加载某自定义工具文件时，展示文件路径与工具 `name`/`description`，等待用户明确确认
  - **信任记录**：用户确认后将 `路径 + 文件 SHA-256 hash` 写入 `~/.paw/trusted-tools.json`
  - **变更重新确认**：后续启动时校验 hash，文件内容变更时重新触发确认流程
- 实现 `disabledBuiltins` 过滤逻辑：从 `settings.json` 读取此列表，跳过对应内置工具的注册

**预期结果：** `ToolRegistry` 可正确注册/查询/冲突检测；自定义工具加载遵守路径限制和 hash 校验；`bunx tsc --noEmit` 通过。

---

### T3 — 扩展 LLMProvider 接口与 ChatMessage 类型

**文件：** `src/agent/provider/types.ts`

- 将现有 `StreamChunk` 联合类型改为 discriminated union，拆分为三个独立接口：
  - `TextDeltaChunk`：`{ type: "text_delta"; delta: string; done: false }`
  - `ToolCallChunk`：`{ type: "tool_call"; done: false; toolCallId: string; toolName: string; toolInput: Record<string, unknown> }`（新增）
  - `DoneChunk`：`{ type: "done"; done: true; stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" }`
  - `StreamChunk = TextDeltaChunk | ToolCallChunk | DoneChunk`
- 新增 `StreamOptions` 接口：`{ tools?: ToolDefinition[] }`，不传或空数组时不启用工具
- 更新 `LLMProvider.stream()` 签名，新增可选参数 `options?: StreamOptions`；保持向后兼容，不传时行为与 Spec 1 完全一致
- 扩展 `ChatMessage` 联合类型，新增两个分支：
  - `{ role: "assistant"; toolCalls: ToolCallRecord[] }`：LLM 发起工具调用的消息
  - `{ role: "tool"; toolCallId: string; toolName: string; content: string }`：工具执行结果回注消息

**预期结果：** 所有使用 `StreamChunk` 的地方均可通过 `type` 字段做 discriminated union 类型收窄；现有仅使用 `TextDeltaChunk` 的调用无 breaking change；`bunx tsc --noEmit` 通过。

---

### T4 — 各 Provider 实现工具协议适配

**文件：**
- `src/agent/provider/impl/openai.ts`
- `src/agent/provider/impl/anthropic.ts`
- `src/agent/provider/impl/azure.ts`
- `src/agent/provider/impl/ollama.ts`

**openai.ts：**
- 新增私有方法 `formatTools(tools: ToolDefinition[])`：将统一格式转换为 OpenAI API 格式（`tools: [{ type: "function", function: { name, description, parameters } }]`），并设置 `tool_choice: "auto"`
- 新增私有方法 `formatMessages(messages: ChatMessage[])`：将 `role: "tool"` 和 `role: "assistant" + toolCalls` 消息转换为 OpenAI messages 格式
- 扩展流式响应解析逻辑：检测 `delta.tool_calls` 字段，对多个 tool call 分别做 JSON 字符串流式拼接，拼接完成后解析为 `ToolCallChunk` yield 出去
- 检测 `finish_reason: "tool_calls"` 时，`DoneChunk.stopReason` 设为 `"tool_use"`
- 支持 `parallelToolCalls` 配置：从 `settings.json` 读取，若为 `false` 则在请求体中设置 `parallel_tool_calls: false`

**anthropic.ts：**
- 新增私有方法 `formatTools(tools: ToolDefinition[])`：转换为 Anthropic 格式（`tools: [{ name, description, input_schema }]`），设置 `tool_choice: { type: "auto" }`
- 新增私有方法 `formatMessages(messages: ChatMessage[])`：将 tool 结果和 assistant toolCalls 消息转换为 Anthropic messages 格式
- 扩展 SSE 解析：检测 `content_block_start` 事件中 `type: "tool_use"`，收集 `input` 字段（JSON 字符串流式拼接），完成后 yield `ToolCallChunk`
- 检测 `stop_reason: "tool_use"` 时，`DoneChunk.stopReason` 设为 `"tool_use"`

**azure.ts / ollama.ts：**
- 确认这两个 provider 的工具调用逻辑通过复用 openai.ts 中的格式化和解析私有方法实现，避免重复代码（可通过继承或提取共享函数实现）

**预期结果：** 传入工具定义时，OpenAI 和 Anthropic provider 均可正确 yield `ToolCallChunk`；不传工具定义时行为与 Spec 1 完全一致；`bunx tsc --noEmit` 通过。

---

### T5 — 实现工具执行调度器

**文件：** `src/agent/tool/executor.ts`

- 实现 `ToolExecutor` 类，构造函数接收 `registry: ToolRegistry` 和 `emitter: (event: AgentEvent) => void`（事件回调，由 `AgentRunner` 注入）
- 内部维护 `pendingConfirms: Map<string, (approved: boolean) => void>`，key 为 `toolCallId`
- 实现 `execute(toolCallId, toolName, toolInput, context): Promise<ToolResult>`：
  - 查找 `registry.get(toolName)`，不存在时返回 `{ ok: false, error: "工具未注册: ..." }`
  - `safetyLevel === "safe"`：直接调用 handler
  - `safetyLevel === "confirm"` 或 `"dangerous"`：通过 `emitter` emit `tool_confirm_required` 事件，创建 Promise 等待 `resolveConfirm()` 回传决策；`approved=false` 时返回 `{ ok: false, error: "用户已拒绝执行此工具" }`；`approved=true` 时执行 handler
  - handler 抛出异常时，捕获并返回 `{ ok: false, error: ... }`
- 实现 `resolveConfirm(toolCallId: string, approved: boolean): void`：从 `pendingConfirms` 取出对应 resolver 并调用，完成后从 Map 中删除
- 实现 `abortAllPendingConfirms(): void`：遍历 `pendingConfirms`，对每个 resolver 以 `approved=false` 调用，然后清空 Map

**预期结果：** 安全级别路由逻辑正确；`abort()` 时所有待决 confirm 自动结算，不发生死锁；`bunx tsc --noEmit` 通过。

---

### T6 — 实现内置工具

**文件：**
- `src/agent/tool/builtin/read_file.ts`
- `src/agent/tool/builtin/write_file.ts`
- `src/agent/tool/builtin/shell_exec.ts`
- `src/agent/tool/builtin/web_search.ts`
- `src/agent/tool/index.ts`

**read_file.ts（safetyLevel: "safe"）：**
- `ToolDefinition`：`name: "read_file"`，入参 `path`（必填）、`encoding`（可选）、`maxBytes`（可选，默认 128 KB）
- handler 逻辑：
  - 调用 `path.resolve(context.workingDir, input.path)` 规范化路径
  - 验证结果以 `context.workingDir` 为前缀，否则返回错误（防路径穿越）
  - 检测路径是否指向 `~/.paw/settings.json`，是则直接返回错误
  - 使用 `Bun.file` 读取文件，超过 `maxBytes` 时截断并在结尾附注说明

**write_file.ts（safetyLevel: "confirm"）：**
- `ToolDefinition`：`name: "write_file"`，入参 `path`（必填）、`content`（必填）、`encoding`（可选）
- handler 逻辑：
  - 调用 `path.resolve(context.workingDir, input.path)` 规范化路径
  - 验证结果以 `context.workingDir` 为前缀，否则返回错误
  - 强制拦截敏感路径：`~/.paw/`、`~/.ssh/`、`~/.aws/`、`~/.bashrc`、`~/.zshrc`；此拦截不可被 `autoApprove` 覆盖
  - 确认弹窗（由 `ToolExecutor` 触发）中展示 `path.resolve()` 后的绝对路径
  - 使用 `Bun.write` 写入文件，父目录不存在时自动创建

**shell_exec.ts（safetyLevel: "dangerous"）：**
- `ToolDefinition`：`name: "shell_exec"`，入参 `command`（必填）、`cwd`（可选）、`timeoutMs`（可选，默认 30000）
- handler 逻辑：使用 `Bun.$` 执行命令，超时返回错误，成功返回 stdout 字符串

**web_search.ts（safetyLevel: "safe"）：**
- `ToolDefinition`：`name: "web_search"`，入参 `query`（必填）、`maxResults`（可选）
- handler 逻辑：当前版本直接返回 `{ ok: false, error: "web_search 尚未配置，请在 settings.json 中设置 searchProvider" }`，不崩溃

**index.ts：**
- 导出所有内置工具的 `RegisteredTool` 实例
- 提供 `registerBuiltins(registry: ToolRegistry, disabledBuiltins: string[]): void` 函数，供启动时批量注册内置工具

**预期结果：** 四个内置工具均可通过 `ToolRegistry` 注册和调用；路径校验和敏感路径拦截逻辑均有效；`bunx tsc --noEmit` 通过。

---

### T7 — 实现 AgentOrchestrator

**文件：** `src/agent/orchestrator.ts`

- 实现 `AgentOrchestrator` 类，构造函数接收：
  - `provider: LLMProvider`
  - `executor: ToolExecutor`
  - `registry: ToolRegistry`
  - `onEvent: (event: AgentEvent) => void`（回调函数，不直接持有事件发射器）
  - `settings: { parallelToolCalls: boolean; maxToolTurns?: number }`（默认 `maxToolTurns: 10`）
- 实现核心方法 `run(messages: ChatMessage[], signal?: AbortSignal): Promise<void>`，包含完整工具调用回路：
  1. 调用 `provider.stream(messages, { tools: registry.getDefinitions() })`
  2. 遍历 `StreamChunk`：
     - `TextDeltaChunk`：通过 `onEvent` 回调通知 `AgentRunner`，由其 emit `stream_chunk`；累积 `assistantText`
     - `ToolCallChunk`：追加到 `pendingToolCalls[]`
     - `DoneChunk (stopReason="tool_use")`：
       - 将 `assistantToolCalls` 追加到 messages（`role: "assistant", toolCalls: [...]`）
       - 根据 `parallelToolCalls` 配置，顺序或并行执行所有 pending tool call：
         - 每次执行前通过 `onEvent` 通知 emit `tool_call_start`
         - 执行结果追加到 messages（`role: "tool"`）
         - 通过 `onEvent` 通知 emit `tool_call_result` 或 `tool_error`
       - 检查当前工具调用轮次是否超过 `maxToolTurns`；超过时通过 `onEvent` 通知 emit `max_tool_turns_reached`，终止回路
       - 未超出时递归调用 `run(messages, signal)` 继续对话
     - `DoneChunk (stopReason="end_turn")`：通过 `onEvent` 通知 emit `stream_done`，返回
- `AgentOrchestrator` 不直接暴露给 UI 层，不持有事件发射器，所有事件通知均通过 `onEvent` 回调完成

**预期结果：** 工具调用回路正确运转，最大轮次限制有效；`parallelToolCalls` 配置生效；`bunx tsc --noEmit` 通过。

---

### T8 — 扩展 AgentEvent，新增 5 个工具相关事件类型

**文件：** `src/agent/events.ts`

- 新增 `ToolCallStartEvent` 接口：`type: "tool_call_start"`，payload 包含 `toolCallId`、`toolName`、`input`
- 新增 `ToolCallResultEvent` 接口：`type: "tool_call_result"`，payload 包含 `toolCallId`、`result`、`durationMs`
- 新增 `ToolErrorEvent` 接口：`type: "tool_error"`，payload 包含 `toolCallId`、`kind`、`message`
- 新增 `ToolConfirmRequiredEvent` 接口：`type: "tool_confirm_required"`，payload 包含 `toolCallId`、`toolName`、`input`、`safetyLevel: "confirm" | "dangerous"`（payload 中不含 resolve 回调，避免 UI 层直接操控 Agent 内部 Promise）
- 新增 `MaxToolTurnsReachedEvent` 接口：`type: "max_tool_turns_reached"`，payload 包含 `turns: number`
- 将以上 5 个新接口追加到 `AgentEvent` 联合类型
- 同步将 `stream_error` 事件中的 `kind` 类型扩展：在 `LLMErrorKind` 联合类型中新增 `"max_tool_turns"` 值（在 `src/agent/provider/errors.ts` 中更新，或在此文件内联处理）

**预期结果：** 5 个新事件类型加入 `AgentEvent`；现有监听方对未知 type 可安全忽略（联合类型 exhaustive check 不强制）；`bunx tsc --noEmit` 通过。

---

### T9 — 更新 AgentRunner，接入 AgentOrchestrator

**文件：** `src/agent/runner.ts`

- 在 `AgentRunner` 中创建并持有 `AgentOrchestrator` 实例，构造时注入 `provider`、`executor`、`registry` 和 `onEvent` 回调（`onEvent` 回调内部调用 `AgentRunner` 的事件发射逻辑）
- 同时创建并持有 `ToolExecutor` 实例，注入 `registry` 和事件回调
- 更新 `send()` 方法：将消息传递给 `AgentOrchestrator.run()` 执行，而非直接调用 provider
- 新增 `confirmToolCall(toolCallId: string, approved: boolean): void` 公开方法：内部调用 `executor.resolveConfirm(toolCallId, approved)`，这是 UI 层传递用户确认决策的唯一合法通道
- 更新 `abort()` 方法：终止当前 stream 的同时，调用 `executor.abortAllPendingConfirms()` 确保所有待决 confirm 自动以 `approved=false` 结算
- 保持 `AgentRunner` 作为唯一对 UI 暴露的 Agent 接口，`AgentOrchestrator` 不对外暴露

**预期结果：** UI 层可通过 `AgentRunner.confirmToolCall()` 传回决策；`abort()` 时不死锁；`send()` 正确触发工具调用回路；`bunx tsc --noEmit` 通过。

---

## 执行顺序

```
T1
├─→ T2（依赖 T1）
└─→ T3（依赖 T1）
    ├─→ T4（依赖 T3）
    └─→ T5（依赖 T1）
        └─→ T6（依赖 T1）
        └─→ T7（依赖 T3、T5）
            └─→ T8
                └─→ T9
```

可并行执行的阶段：
- **第一批（并行）**：T2 和 T3（均仅依赖 T1）
- **第二批（并行）**：T4（依赖 T3）和 T5（依赖 T1，可与 T4 并行）
- **第三批（并行）**：T6（依赖 T1，handler 实现独立）和 T7（依赖 T3、T5）
- **顺序**：T8 → T9

---

## 完成记录

| 任务 | 状态 | 验证结果 |
|------|------|----------|
| T1 — 定义核心类型 | pending | — |
| T2 — 实现 ToolRegistry | pending | — |
| T3 — 扩展 LLMProvider 接口 | pending | — |
| T4 — Provider 工具协议适配 | pending | — |
| T5 — 实现 ToolExecutor | pending | — |
| T6 — 实现内置工具 | pending | — |
| T7 — 实现 AgentOrchestrator | pending | — |
| T8 — 扩展 AgentEvent | pending | — |
| T9 — 更新 AgentRunner | pending | — |
