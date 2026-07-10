# Spec 5：工具系统（Tool Use / Function Calling）

| 字段 | 值 |
|------|-----|
| 状态 | approved |
| 修订日期 | 2026-07-10（review 修复）|
| 日期 | 2026-07-10 |
| 风险级别 | 高 |

> **风险说明：** 工具系统同时触及三个高风险维度：① 修改 `LLMProvider` 核心接口（Spec 1 已稳定），现有五类实现须同步适配；② 引入 shell 执行、文件读写等具备实际副作用的能力，安全边界设计一旦有误难以回滚；③ 扩展 `AgentEvent` 协议，所有监听方（UI 层、测试）均需同步更新。

---

## 背景 / 目标 / 范围

### 背景

Spec 1 建立了多 Provider 的 streaming 文本接口。AI Agent 要从"对话机器人"演进为"能执行任务的 Agent"，必须具备工具调用能力——让 LLM 在对话过程中请求执行外部操作（读文件、跑命令、搜索等），拿到结果后继续推理。

OpenAI 和 Anthropic 的工具调用协议存在结构差异（`tool_calls` vs `tool_use`），必须在 provider 层统一屏蔽，上层编排逻辑不感知任何 provider 细节。

### 目标

1. 定义与主流 LLM provider 兼容的工具定义格式（Tool Definition）
2. 建立工具注册机制，支持内置工具与用户自定义工具
3. 扩展 `LLMProvider` 接口，支持携带工具定义并解析工具调用响应
4. 实现工具执行层（接收参数 → 执行 → 回注结果 → 继续对话）
5. 建立安全确认机制，对破坏性操作要求用户明确授权
6. 扩展 `AgentEvent`，让 UI 层可感知工具调用的生命周期

### 包含

- `ToolDefinition` 格式规范（统一格式，兼容 OpenAI / Anthropic）
- `ToolRegistry`：内置工具注册 + 用户自定义工具加载
- `LLMProvider.stream()` 接口扩展，携带工具定义并输出 `tool_call` 类型 chunk
- provider 层协议适配（OpenAI `tool_calls` ↔ Anthropic `tool_use` ↔ 统一格式）
- `ToolExecutor`：工具执行调度器
- 工具调用回路：`tool_result` 回注 messages，继续发起下一轮请求
- `AgentEvent` 新增：`tool_call_start` / `tool_call_result` / `tool_error` / `tool_confirm_required` / `max_tool_turns_reached`
- 内置工具：`read_file` / `write_file` / `shell_exec` / `web_search`（预留接口）
- 安全策略配置与用户确认流程

### 不包含

- MCP（Model Context Protocol）接入（独立需求）
- 工具调用结果的持久化存储
- 工具调用的重试逻辑

---

## 技术方案

### 1. Tool Definition 格式

统一格式设计为"最大公约数"，覆盖 OpenAI function calling 和 Anthropic tool use 所需字段：

```ts
// src/agent/tool/types.ts

/** JSON Schema 子集，描述工具的入参结构 */
export interface ToolInputSchema {
  type: "object"
  properties: Record<string, {
    type: string          // "string" | "number" | "boolean" | "array" | "object"
    description?: string
    enum?: string[]
    items?: { type: string }  // 仅 array 类型使用
  }>
  required?: string[]
}

/** 统一工具定义，provider 无关 */
export interface ToolDefinition {
  name: string            // 全局唯一，字母数字下划线，如 "read_file"
  description: string     // 向 LLM 描述工具用途，直接影响调用质量
  inputSchema: ToolInputSchema
  /** 安全级别，影响是否需要用户确认 */
  safetyLevel: "safe" | "confirm" | "dangerous"
}

/** 工具执行函数签名 */
export type ToolHandler = (
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolResult>

/** 注册单元 = 定义 + 处理函数 */
export interface RegisteredTool {
  definition: ToolDefinition
  handler: ToolHandler
}

/** 执行上下文，由 ToolExecutor 注入 */
export interface ToolContext {
  workingDir: string      // 当前工作目录
  signal?: AbortSignal    // 支持取消
}

/** 工具执行结果 */
export type ToolResult =
  | { ok: true;  output: string }   // 成功，output 为字符串（LLM 可读）
  | { ok: false; error: string }    // 失败
```

**格式兼容说明：**

| 字段 | OpenAI 映射 | Anthropic 映射 |
|------|-------------|----------------|
| `name` | `function.name` | `name` |
| `description` | `function.description` | `description` |
| `inputSchema` | `function.parameters`（JSON Schema） | `input_schema`（JSON Schema） |

两者的 JSON Schema 结构完全相同，差异仅在外层包装，provider 适配层负责转换。

---

### 2. Tool 注册机制

```
src/agent/tool/
├── types.ts              # 上述类型定义
├── registry.ts           # ToolRegistry
├── executor.ts           # ToolExecutor（调度 + 安全确认）
├── builtin/
│   ├── read_file.ts      # 内置：读文件
│   ├── write_file.ts     # 内置：写文件
│   ├── shell_exec.ts     # 内置：执行 shell 命令
│   └── web_search.ts     # 内置：网页搜索（预留接口）
└── index.ts              # 导出 + 自动注册内置工具
```

```ts
// src/agent/tool/registry.ts

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()

  /** 注册单个工具（name 冲突时抛错） */
  register(tool: RegisteredTool): void

  /** 批量注册（用于加载用户自定义工具） */
  registerMany(tools: RegisteredTool[]): void

  /** 获取工具定义列表（传给 LLM） */
  getDefinitions(): ToolDefinition[]

  /** 获取执行函数（由 ToolExecutor 调用） */
  get(name: string): RegisteredTool | undefined
}
```

**用户自定义工具加载：**

`~/.paw/settings.json` 新增 `tools` 字段，支持从本地文件加载自定义工具模块：

```json
{
  "tools": {
    "customToolsPath": "~/.paw/tools/",
    "disabledBuiltins": ["web_search"]
  }
}
```

`~/.paw/tools/` 目录下每个 `.ts` 文件须默认导出一个 `RegisteredTool`，由 `ToolRegistry` 在启动时用 `import()` 动态加载。

**自定义工具安全加载机制：**

1. **首次加载确认**：首次加载某自定义工具文件时，展示其路径和 `ToolDefinition.name / description`，要求用户明确确认后再执行
2. **信任记录**：用户确认后将 `路径 + 文件内容 hash（SHA-256）` 记录到 `~/.paw/trusted-tools.json`
3. **变更重新确认**：后续启动时校验 hash，发现文件内容变化时重新要求确认
4. **路径限制**：`customToolsPath` 仅允许指向用户主目录下的路径（以 `~` 开头），**禁止**指向项目本地目录（如 `./tools/`、`../`），防止恶意仓库通过 `.paw/settings.json` 植入自动执行代码

---

### 3. LLMProvider 接口扩展

在 Spec 1 的 `StreamChunk` 和 `LLMProvider` 基础上扩展，**保持向后兼容**（不携带工具时行为与 Spec 1 完全一致）：

```ts
// src/agent/provider/types.ts（扩展 Spec 1）

/** 文本增量 chunk（Spec 1 已有） */
export interface TextDeltaChunk {
  type: "text_delta"
  delta: string
  done: false
}

/** 流结束 chunk（Spec 1 已有，拆分 done 字段为独立类型） */
export interface DoneChunk {
  type: "done"
  done: true
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
}

/** 工具调用 chunk：LLM 请求调用某个工具（新增） */
export interface ToolCallChunk {
  type: "tool_call"
  done: false
  toolCallId: string      // provider 生成的唯一 id，回注时使用
  toolName: string
  toolInput: Record<string, unknown>  // 已解析的 JSON 参数
}

export type StreamChunk = TextDeltaChunk | ToolCallChunk | DoneChunk

/** stream() 选项（新增 tools 参数） */
export interface StreamOptions {
  tools?: ToolDefinition[]  // 不传或空数组 = 不启用工具
}

export interface LLMProvider {
  readonly id: string
  readonly label: string
  readonly model: string
  stream(
    messages: ChatMessage[],
    options?: StreamOptions,   // 新增可选参数，兼容 Spec 1 调用
  ): AsyncIterable<StreamChunk>
}
```

**ChatMessage 类型扩展（支持 tool_result 回注）：**

```ts
export type ChatMessage =
  | { role: "user";      content: string }
  | { role: "assistant"; content: string }
  /** LLM 发起工具调用的消息（写入 messages history） */
  | { role: "assistant"; toolCalls: ToolCallRecord[] }
  /** 工具执行结果回注 */
  | { role: "tool";      toolCallId: string; toolName: string; content: string }

export interface ToolCallRecord {
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
}
```

---

### 4. Provider 层协议差异屏蔽

各 provider 在请求构造和响应解析上存在以下差异，**全部在 `src/agent/provider/impl/` 内处理**，上层不感知：

#### 4.1 请求构造差异

| 方面 | OpenAI / Azure / openai-compat | Anthropic |
|------|-------------------------------|-----------|
| 工具定义字段 | `tools: [{ type: "function", function: { name, description, parameters } }]` | `tools: [{ name, description, input_schema }]` |
| 工具调用模式 | `tool_choice: "auto"` | `tool_choice: { type: "auto" }` |
| 并行调用控制 | `parallel_tool_calls: false`（可选） | 不支持此字段 |

#### 4.2 响应解析差异（SSE 流）

| 方面 | OpenAI（streaming） | Anthropic（streaming） |
|------|---------------------|------------------------|
| 调用信号 | `delta.tool_calls[].function.name` / `arguments`（流式拼接） | `content_block_start` 事件，`type: "tool_use"` |
| 参数格式 | `arguments` 为 JSON 字符串，需流式拼接后再 `JSON.parse` | `input` 为 JSON 字符串，同样需拼接后解析 |
| 结束信号 | `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| 调用 id | `tool_calls[].id`（如 `call_abc123`） | `id`（如 `toolu_01abc`） |

**Ollama** 在支持工具调用的模型上（如 `llama3.1`）使用与 OpenAI 相同的结构，复用 openai.ts 适配器。

#### 4.3 适配器实现模式

每个 provider 实现须包含以下私有方法（不暴露给外部）：

```ts
// 以 anthropic.ts 为例（伪代码，仅描述设计）
class AnthropicProvider implements LLMProvider {
  // 将统一 ToolDefinition[] 转为 Anthropic API 格式
  private formatTools(tools: ToolDefinition[]): AnthropicToolParam[]

  // 将统一 ChatMessage[] 中的 tool_result 转为 Anthropic messages 格式
  private formatMessages(messages: ChatMessage[]): AnthropicMessageParam[]

  // 解析 SSE 事件流，yield 统一 StreamChunk
  private async *parseStream(response: Response): AsyncIterable<StreamChunk>
}
```

---

### 5. Tool 执行层

```ts
// src/agent/tool/executor.ts

export class ToolExecutor {
  /**
   * 内部维护待决 confirm 的 resolver 映射
   * key: toolCallId，value: 用户决策 Promise 的 resolve 函数
   * abort() 时所有待决 confirm 自动以 approved=false 结算
   */
  private pendingConfirms = new Map<string, (approved: boolean) => void>()

  constructor(
    private registry: ToolRegistry,
    private emitter: (event: AgentEvent) => void,  // 通过注入回调通知 AgentOrchestrator，由 AgentRunner 统一发射 AgentEvent
  ) {}

  /**
   * 执行单次工具调用
   * - safetyLevel="safe": 直接执行
   * - safetyLevel="confirm": emit tool_confirm_required，等待 confirmToolCall() 回传决策
   * - safetyLevel="dangerous": 同 confirm，并在弹窗中附加警告样式
   */
  async execute(
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>

  /**
   * 由 AgentRunner.confirmToolCall() 调用，传入用户决策
   * approved=false 时工具调用被取消，返回拒绝消息
   */
  resolveConfirm(toolCallId: string, approved: boolean): void

  /**
   * abort() 时调用，将所有待决 confirm 以 approved=false 结算
   */
  abortAllPendingConfirms(): void
}
```

**工具调用完整回路（伪流程）：**

```
AgentOrchestrator.run(messages):
  1. 调用 provider.stream(messages, { tools: registry.getDefinitions() })
  2. 遍历 StreamChunk：
     a. TextDeltaChunk  → 通过回调通知 AgentRunner，由 AgentRunner emit stream_chunk，累积 assistantText
     b. ToolCallChunk   → 记录到 pendingToolCalls[]
     c. DoneChunk (stopReason="tool_use"):
        - 将 assistantToolCalls 追加到 messages（role: "assistant", toolCalls: [...]）
        - for each pendingToolCall:
            通知 AgentRunner emit tool_call_start
            result = await executor.execute(...)
            将 tool_result 追加到 messages（role: "tool"）
            通知 AgentRunner emit tool_call_result | tool_error
        - 递归调用 run(messages)（继续对话）
     d. DoneChunk (stopReason="end_turn"):
        - 通知 AgentRunner emit stream_done
        - 返回（对话轮次结束）
```

递归深度由 `AgentOrchestrator` 控制，默认最大工具调用轮次为 10，超出时通知 `AgentRunner` emit `max_tool_turns_reached` 事件（payload: `{ turns: 10 }`）。

### 5.1 AgentOrchestrator 与 AgentRunner 职责划定

**架构层次示意（文字版）：**

```
┌─────────────────────────────────────────────────────┐
│                    UI 层（Spec 4）                    │
│  渲染 AgentEvent、调用 AgentRunner.send/abort/        │
│  confirmToolCall/switchProvider                      │
└───────────────────┬─────────────────────────────────┘
                    │ AgentEvent（单向，Agent → UI）
                    │ send / abort / confirmToolCall（UI → Agent）
┌───────────────────▼─────────────────────────────────┐
│              AgentRunner（Spec 2，对外接口层）         │
│  • 唯一对 UI 暴露的 Agent 接口                        │
│  • 持有 AgentOrchestrator 实例                       │
│  • 统一发射所有 AgentEvent（事件发射器归属此层）        │
│  • 实现 confirmToolCall(toolCallId, approved)        │
│    → 调用 executor.resolveConfirm()                  │
│  • abort() 同时调用 executor.abortAllPendingConfirms()│
└───────────────────┬─────────────────────────────────┘
                    │ 委托执行（内部调用，不对外暴露）
                    │ 通过回调将事件返回给 AgentRunner
┌───────────────────▼─────────────────────────────────┐
│           AgentOrchestrator（本 Spec，内部执行层）     │
│  • 负责 LLM + 工具调用回路（最大 10 轮）               │
│  • 不持有事件发射器，通过构造时注入的回调通知 AgentRunner│
│  • 不直接暴露给 UI 层                                 │
│  • 持有 ToolExecutor 实例                            │
└───────────────────┬─────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌───────────────┐     ┌────────────────┐
│  LLMProvider  │     │  ToolExecutor  │
│  （Spec 1）   │     │  （本 Spec）    │
└───────────────┘     └────────────────┘
```

**关键约束：**
- `AgentOrchestrator` 是内部执行层，负责 LLM + 工具调用回路（最大 10 轮）
- `AgentRunner`（Spec 2）是对外接口层，持有 `AgentOrchestrator` 实例
- `AgentOrchestrator` 通过**构造时注入的回调函数**将事件返回给 `AgentRunner` 统一发射，不直接持有事件发射器
- `AgentOrchestrator` 不直接暴露给 UI 层
- UI 层对 Agent 的唯一写入操作为 `send / abort / confirmToolCall / switchProvider`（均定义在 `AgentRunner`）

---

### 6. AgentEvent 扩展

> **说明：** 全量 `AgentEvent` 权威定义见 `src/agent/events.ts`，此处仅列本 Spec 新增类型。所有 `AgentEvent` 统一采用嵌套 `payload` 格式（与 Spec 2 一致）。

在 Spec 1 的四个事件基础上新增：

```ts
// src/agent/events.ts（本 Spec 新增类型，采用嵌套 payload 格式）

/** LLM 请求调用工具，执行前触发（UI 可显示"正在调用工具..."） */
export interface ToolCallStartEvent {
  type: "tool_call_start"
  payload: {
    toolCallId: string
    toolName: string
    input: unknown
  }
}

/** 工具执行成功，结果已回注 messages */
export interface ToolCallResultEvent {
  type: "tool_call_result"
  payload: {
    toolCallId: string
    result: unknown
    durationMs: number
  }
}

/** 工具执行失败 */
export interface ToolErrorEvent {
  type: "tool_error"
  payload: {
    toolCallId: string
    kind: string
    message: string
  }
}

/**
 * 需要用户确认才能执行的工具（safetyLevel="confirm"/"dangerous"）
 * UI 层渲染确认弹窗，用户决策通过 AgentRunner.confirmToolCall(toolCallId, approved) 传回
 * 注意：payload 中不含 resolve 回调，避免 UI 层直接操控 Agent 内部 Promise
 *
 * 注：Spec 2 AgentEvent 权威附录中 safetyLevel 当前为宽泛的 string，
 * 应收窄为 "confirm" | "dangerous"（请 Spec 2 对应 Agent 更新附录）。
 */
export interface ToolConfirmRequiredEvent {
  type: "tool_confirm_required"
  payload: {
    toolCallId: string
    toolName: string
    input: unknown
    /** 合法值仅为 "confirm"（可逆操作）和 "dangerous"（不可逆/高风险操作） */
    safetyLevel: "confirm" | "dangerous"
  }
}

/** 工具调用轮次达到上限 */
export interface MaxToolTurnsReachedEvent {
  type: "max_tool_turns_reached"
  payload: {
    turns: number
  }
}

export type AgentEvent =
  // Spec 1 原有（嵌套 payload 格式）
  | { type: "stream_chunk";      payload: { delta: string } }
  | { type: "stream_done";       payload: { totalText: string } }
  | { type: "stream_error";      payload: { kind: LLMErrorKind | "max_tool_turns"; message: string } }
  | { type: "provider_changed";  payload: { providerId: string; model: string } }
  // Spec 5 新增
  | ToolCallStartEvent
  | ToolCallResultEvent
  | ToolErrorEvent
  | ToolConfirmRequiredEvent
  | MaxToolTurnsReachedEvent
```

---

### 7. 内置工具规格

| 工具名 | safetyLevel | 功能描述 | 关键入参 |
|--------|-------------|----------|----------|
| `read_file` | `safe` | 读取本地文件内容（相对路径基于 workingDir） | `path: string`，可选 `encoding`，可选 `maxBytes`（默认 128 KB，防止超出 context） |
| `write_file` | `confirm` | 写入或覆盖本地文件（新建目录自动创建） | `path: string`，`content: string`，可选 `encoding` |
| `shell_exec` | `dangerous` | 执行 shell 命令（通过 `Bun.$`），超时 30s | `command: string`，可选 `cwd`，可选 `timeoutMs` |
| `web_search` | `safe` | 网页搜索，返回摘要（预留接口，实现待定） | `query: string`，可选 `maxResults` |

**`web_search` 预留接口说明：** 当前版本 handler 返回 `{ ok: false, error: "web_search 尚未配置，请在 settings.json 中设置 searchProvider" }`，避免 LLM 调用时静默失败。具体实现（如接入 Brave Search API）在后续 Spec 中完成。

**`read_file` 路径边界校验：**

1. 执行前调用 `path.resolve(workingDir, inputPath)` 规范化路径
2. 验证结果必须以 `workingDir` 为前缀，否则返回错误、不执行（防止 `../../../../etc/passwd` 等路径穿越攻击）
3. 禁止读取 `~/.paw/settings.json`（可能含 API Key），检测到时直接返回错误

**`write_file` 路径边界校验与敏感路径拦截：**

1. 执行前调用 `path.resolve(workingDir, inputPath)` 规范化路径
2. 验证结果必须以 `workingDir` 为前缀，否则返回错误、不执行
3. 对以下敏感路径**强制拒绝**，且此拒绝**不可被 `autoApprove` 覆盖**：
   - `~/.paw/`（含 settings.json、API Key）
   - `~/.ssh/`
   - `~/.aws/`
   - `~/.bashrc`、`~/.zshrc`
4. 确认弹窗中展示 `path.resolve()` 后的**绝对路径**（而非 LLM 传入的原始值）

---

### 8. 安全边界设计

#### 8.1 safetyLevel 分级

| 级别 | 行为 | 适用场景 |
|------|------|----------|
| `safe` | 直接执行，不弹确认 | 只读操作，无副作用 |
| `confirm` | 弹确认弹窗，用户点确认后执行 | 写操作、有副作用但可逆 |
| `dangerous` | 弹确认弹窗 + 红色警告样式，用户点确认后执行 | shell 命令、不可逆操作 |

#### 8.2 用户确认流程

1. `ToolExecutor` 检测到 `safetyLevel !== "safe"` 时，**先** emit `tool_confirm_required` 事件（payload 仅含 `toolCallId`、`toolName`、`input`、`safetyLevel`，不含 resolve 回调）
2. UI 层渲染确认弹窗（阻塞对话流），展示 `path.resolve()` 后的**绝对路径**（而非 LLM 传入的原始值），用户按 `Enter` 确认、`Esc` 取消（与 Spec 4 Overlay 规范一致）
3. UI 层调用 `AgentRunner.confirmToolCall(toolCallId, approved)` 传回决策，这是 UI 向 Agent 层传递决策的唯一合法通道
4. `AgentRunner` 将调用转发给 `ToolExecutor.resolveConfirm(toolCallId, approved)`
5. `ToolExecutor` 收到 `approved=false` 时，将结果设为 `{ ok: false, error: "用户已拒绝执行此工具" }`，继续正常回注 messages（LLM 将感知拒绝并给出解释）
6. 用户按 `Esc` 关闭弹窗等同于 `approved=false`，`abort()` 时所有待决 confirm 自动以 `approved=false` 结算

#### 8.3 `settings.json` 扩展（工具安全配置）

```json
{
  "tools": {
    "customToolsPath": "~/.paw/tools/",
    "disabledBuiltins": [],
    "autoApprove": {
      "shell_exec": false,
      "write_file": false
    },
    "parallelToolCalls": false
  }
}
```

`parallelToolCalls`：当 LLM 一次回复中发出多个 tool call 时，是否并行执行这些工具。
- `false`（默认）：顺序逐个执行，简单安全，副作用可预测
- `true`：并行执行所有 tool call，速度更快，适合无副作用的只读工具（如多个 `read_file`）
- 无论此项如何设置，`spawn_subagent` 工具（Spec 9）始终并行派发
```

`autoApprove` 设为 `true` 时，对应工具跳过确认步骤（**不建议**，仅供高级用户）。

---

### 9. 文件结构总览

```
src/agent/
├── provider/
│   ├── types.ts          # StreamChunk / LLMProvider 扩展（Spec 1 已有，本 Spec 扩展）
│   ├── registry.ts       # ProviderRegistry（Spec 1 已有）
│   ├── errors.ts         # LLMErrorKind（Spec 1 已有，新增 "max_tool_turns"）
│   └── impl/
│       ├── openai.ts     # 扩展：工具定义格式化 + tool_calls 解析
│       ├── anthropic.ts  # 扩展：工具定义格式化 + tool_use 解析
│       ├── azure.ts      # 复用 openai.ts 适配逻辑
│       └── ollama.ts     # 复用 openai.ts 适配逻辑
├── tool/                 # 新增目录
│   ├── types.ts          # ToolDefinition / ToolHandler / ToolResult 等
│   ├── registry.ts       # ToolRegistry
│   ├── executor.ts       # ToolExecutor
│   ├── builtin/
│   │   ├── read_file.ts
│   │   ├── write_file.ts
│   │   ├── shell_exec.ts
│   │   └── web_search.ts
│   └── index.ts          # 导出 + 注册内置工具
├── orchestrator.ts       # AgentOrchestrator（新增，含工具调用回路）
└── events.ts             # AgentEvent 扩展（Spec 1 已有，本 Spec 扩展）
```

---

## 验收标准

- [ ] `ToolDefinition` 类型可被 OpenAI 和 Anthropic provider 正确转换为各自协议格式
- [ ] OpenAI provider：传入工具定义时，`stream()` 可 yield `ToolCallChunk`（tool_calls 响应）
- [ ] Anthropic provider：传入工具定义时，`stream()` 可 yield `ToolCallChunk`（tool_use 响应）
- [ ] Ollama provider：支持工具调用的模型（llama3.1 等）可正常使用工具
- [ ] `stream()` 不传 `options.tools` 时，行为与 Spec 1 完全一致（无 breaking change）
- [ ] `ToolRegistry` 注册重名工具时抛出明确错误
- [ ] `ToolRegistry` 可通过 `customToolsPath` 动态加载用户 `.ts` 工具文件（首次加载触发信任确认流程）
- [ ] `customToolsPath` 指向项目本地目录时，启动时报错拒绝加载
- [ ] 自定义工具文件内容变更后，再次启动时重新触发确认
- [ ] `read_file` 工具：成功读取文件；超过 maxBytes 截断并注明；路径非法（穿越 workingDir）时返回错误；读取 `~/.paw/settings.json` 被拦截
- [ ] `write_file` 工具：触发 `tool_confirm_required` 事件；确认弹窗展示 `path.resolve()` 后的绝对路径；用户拒绝后 LLM 收到拒绝消息；路径穿越 workingDir 时返回错误；写入敏感路径（`~/.ssh/`、`~/.paw/`、`~/.bashrc` 等）被强制拒绝，且 autoApprove 无法绕过
- [ ] `shell_exec` 工具：触发 `dangerous` 级别确认；执行成功返回 stdout；超时返回错误
- [ ] `web_search` 工具：返回明确的"尚未配置"错误，不崩溃
- [ ] `AgentOrchestrator` 超过 10 轮工具调用时 emit `max_tool_turns_reached`（payload: `{ turns: 10 }`）
- [ ] UI 层可收到 `tool_call_start` / `tool_call_result` / `tool_error` / `tool_confirm_required` 事件并渲染
- [ ] 工具确认弹窗支持 `Enter` 确认、`Esc` 取消（而非 y/n）
- [ ] `AgentRunner.confirmToolCall(toolCallId, approved)` 可正确将用户决策传回 `ToolExecutor`
- [ ] `abort()` 时所有待决 confirm 自动以 `approved=false` 结算，不发生死锁
- [ ] `settings.json` 中 `autoApprove.shell_exec=true` 时 shell_exec 跳过确认弹窗
- [ ] `autoApprove` 无法绕过对敏感路径的强制拒绝
- [ ] `bunx tsc --noEmit` 通过

---

## 验证方式

1. **单元测试（`bun test`）：**
   - `ToolRegistry` 注册/查询/冲突检测
   - OpenAI / Anthropic 工具格式化函数（输入统一格式，断言输出协议格式）
   - `ToolExecutor` 安全级别路由逻辑（mock `confirmFn`）

2. **集成验证：**
   - 使用真实 OpenAI API（gpt-4o）发起携带工具的 streaming 请求，验证 `ToolCallChunk` 正常 yield
   - 使用真实 Anthropic API（claude-3-5-sonnet）同上
   - 在 TUI 中触发 `read_file` 工具，确认文件内容正确回注并渲染

3. **安全场景验证：**
   - 手动触发 `write_file`，确认弹窗展示绝对路径（而非 LLM 传入的原始相对路径），拒绝后 LLM 输出包含拒绝说明
   - 手动触发 `shell_exec`，确认 `dangerous` 样式渲染
   - 尝试 `read_file` 读取 `~/.paw/settings.json`，确认被拦截
   - 尝试 `read_file` 传入 `../../../../etc/passwd`，确认路径穿越被拦截
   - 设置 `autoApprove.write_file=true` 后尝试写入 `~/.ssh/id_rsa`，确认被强制拦截
   - Esc 关闭确认弹窗，确认工具调用以拒绝状态结算、不死锁
   - 触发 `abort()` 时存在待决 confirm，确认所有 confirm 自动以 `approved=false` 结算

4. **类型检查：**
   - `bunx tsc --noEmit` 通过（包含新增类型文件）

---

## 回滚策略

本 Spec 采用**纯新增策略**，对 Spec 1 已有结构只做扩展不做替换：

- `LLMProvider.stream()` 新增可选参数 `options?: StreamOptions`，不传时行为不变，现有调用无需修改
- `StreamChunk` 从 Spec 1 的 `{ delta, done }` 联合类型扩展，discriminated union 设计保证类型安全
- `AgentEvent` 联合类型追加新成员，现有 UI 监听逻辑对未知 type 可安全忽略

**完整回滚步骤：**

1. 删除 `src/agent/tool/` 整个目录
2. 删除 `src/agent/orchestrator.ts`
3. 还原 `src/agent/provider/types.ts` 中的 `StreamChunk` 为 Spec 1 版本（移除 `ToolCallChunk` 和 `DoneChunk`，恢复 `{ delta, done }` 字段）
4. 还原各 provider 实现文件，移除工具格式化和 `ToolCallChunk` 解析逻辑
5. 还原 `src/agent/events.ts`，移除五个新增事件类型（`ToolCallStartEvent`、`ToolCallResultEvent`、`ToolErrorEvent`、`ToolConfirmRequiredEvent`、`MaxToolTurnsReachedEvent`）

回滚后 TUI 恢复至 Spec 1 状态，多 provider streaming 文本功能不受影响。
