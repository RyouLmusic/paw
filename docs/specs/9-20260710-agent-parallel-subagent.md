# Spec 9：并行 Subagent 系统

| 字段 | 值 |
|------|-----|
| 状态 | approved |
| 日期 | 2026-07-10 |
| 修订日期 | 2026-07-10（review 修复）|
| 风险级别 | 高 |

> **风险说明**：本 Spec 引入多 Agent 并发执行模型，扩展了 Agent-UI 通信协议（新增 5 种 AgentEvent 类型），并深度耦合 Hook 系统（Spec 7）、Memory 系统（Spec 8）和工具调用系统（Spec 5）。任何接口变更都可能引发跨系统级联影响，属于架构级改动。

---

## 背景 / 目标 / 范围

### 背景

paw 的 `AgentRunner`（Spec 2）当前仅支持单 Agent 串行执行：Orchestrator 发出请求 → 获得回复 → 继续下一步。对于可以并行化的复杂任务（如：同时搜索多个来源、并行分析多个文件、多路 API 调用），串行模型会造成不必要的等待。

类比 Claude Code 的 Agent tool 机制：主 Agent 可以派发子任务给多个 Subagent 并行执行，汇总结果后继续推进。paw 需要相同的能力。

### 目标

1. 定义 Orchestrator / Subagent 角色模型与职责边界
2. 通过 tool call 机制（Spec 5）派发 Subagent，保持 Agent 编排逻辑与协议的一致性
3. 支持可配置的最大并发数与队列背压机制
4. 定义 Subagent 完整生命周期（创建 → 运行 → 结果返回 / 超时 / 取消）
5. 扩展 `AgentEvent` 类型，支持 TUI 实时展示并行进度
6. 明确 Subagent 与 Hook 系统、Memory 系统的交互边界

### 包含

- Orchestrator / Subagent 角色定义与职责边界
- `spawn_subagent` 工具定义（作为 Spec 5 工具系统的一个内置工具）
- `SubagentManager`：并发控制、队列管理、生命周期管理
- `SubagentRunner`：对 `AgentRunner` 的包装，提供隔离上下文
- `AgentEvent` 扩展：`subagent_start` / `subagent_done` / `subagent_error` / `subagent_progress` / `subagent_cancelled`（均采用嵌套 payload 格式）
- Subagent 隔离级别配置：context 隔离、provider 继承或独立
- 结果汇总机制：多 Subagent 输出如何注入 Orchestrator 的 tool_result
- TUI 进度树展示（Subagent 并行状态行）
- 与 Hook 系统的关系（Spec 7）
- 与 Memory 系统的关系（Spec 8）

### 不包含

- 跨进程 / 跨机器分布式调度（所有 Subagent 在同一 Bun 进程内）
- Subagent 嵌套（**完全禁止**：Subagent 内部调用 `spawn_subagent` 直接报错返回，参照 Claude Code 设计）
- Subagent 间直接通信（只通过 Orchestrator 汇总结果）
- 持久化 Subagent 状态（Subagent 生命周期随任务结束）

---

## 技术方案

### 1. 角色定义

| 角色 | 定义 |
|------|------|
| **Orchestrator** | 主 Agent，由用户会话直接驱动。拥有完整对话历史，可通过 `spawn_subagent` tool call 派发子任务。负责等待所有 Subagent 完成后汇总结果并继续推进。 |
| **Subagent** | 由 Orchestrator 派发的子 Agent。拥有独立的消息上下文，不感知 Orchestrator 的对话历史。执行完成后将结果返回给 Orchestrator，自身即销毁。 |

职责边界原则：
- Orchestrator 不直接执行子任务，只负责分解任务、派发、等待、汇总
- Subagent 不感知自己是 Subagent，从其视角看就是一个独立的 AgentRunner
- 两者之间只通过 `spawn_subagent` tool call 输入和 `tool_result` 输出通信

### 2. 派发方式：通过 Tool Call

Subagent 的派发通过 Spec 5 工具调用系统实现，Orchestrator 调用内置工具 `spawn_subagent`。

选择理由：
- 与现有 tool call 流程完全一致，Orchestrator 不需要感知"这是一个特殊调用"
- LLM 自然地通过 tool call 参数描述子任务，结构清晰
- tool_result 注入机制已有，结果汇总无需额外通道

**`spawn_subagent` 工具定义（伪代码）：**

```ts
// src/agent/tools/spawn-subagent.ts

interface SpawnSubagentInput {
  // 子任务描述，注入为 Subagent 的第一条 user message
  task: string
  // 可选：子任务标识，用于 TUI 展示和日志
  label?: string
  // 可选：覆盖使用的 provider id（默认继承 Orchestrator 的 provider）
  providerId?: string
  // 可选：Subagent 超时时间（毫秒），默认 60_000
  timeoutMs?: number
  // 可选：允许 Subagent 读取 memory（默认 true），是否允许写入 memory（默认 false）
  memoryAccess?: {
    read: boolean
    write: boolean
  }
  // 可选：批次整体超时时间（毫秒），默认 = maxConcurrency * perAgentTimeoutMs
  // 批次超时时调用 cancelAll()，未完成的 Subagent 以 { success: false, error: "batch_timeout" } 结束
  batchTimeoutMs?: number
}

interface SpawnSubagentOutput {
  // Subagent 最终输出的文本（最后一条 assistant message）
  result: string
  // Subagent 执行是否成功
  success: boolean
  // 失败时的错误原因
  error?: string
  // Subagent 运行耗时（毫秒）
  durationMs: number
}
```

Orchestrator 可在同一次 LLM 回复中一次性发出多个 `spawn_subagent` tool call，系统将并行执行这些 Subagent。

### 3. 核心组件设计

#### 3.1 SubagentRunner

`SubagentRunner` 是对 `AgentRunner` 的薄包装，负责为单个 Subagent 提供隔离的执行环境。

```ts
// src/agent/subagent/SubagentRunner.ts

interface SubagentContext {
  // 唯一标识，用于事件关联
  id: string
  // 来自 SpawnSubagentInput 的标签
  label: string
  // 独立的消息历史（从 task 注入开始，不含 Orchestrator 上下文）
  messages: ChatMessage[]
  // 使用的 provider（继承或独立）
  provider: LLMProvider
  // 超时配置
  timeoutMs: number
  // memory 访问权限
  memoryAccess: { read: boolean; write: boolean }
}

interface SubagentResult {
  id: string
  success: boolean
  result?: string
  error?: string
  durationMs: number
}
```

SubagentRunner 的执行流程：
1. 用 `task` 初始化独立消息历史（`[{ role: "user", content: task }]`）
2. 启动 AgentRunner 循环（最多执行到 `stream_done`）
3. 在 `timeoutMs` 内未完成则触发取消
4. 返回 `SubagentResult`

SubagentRunner 产生的 AgentEvent 会被 SubagentManager 拦截，不会直接流向 UI 事件总线，而是转换为 `subagent_progress` 事件后再转发。

#### 3.2 SubagentManager

`SubagentManager` 负责并发控制、队列管理和生命周期管理。

```ts
// src/agent/subagent/SubagentManager.ts

interface SubagentManagerConfig {
  // 最大并发 Subagent 数量，默认 4
  maxConcurrency: number
  // 队列最大等待数量，超出则背压（拒绝新派发），默认 16
  maxQueueSize: number
}

interface SubagentManager {
  // 派发一批 Subagent（来自同一次 Orchestrator tool call 批次）
  // signal：来自 AgentRunner.abort() 的取消信号，触发时同步取消全部 Subagent
  spawnBatch(inputs: SpawnSubagentInput[], signal?: AbortSignal, batchTimeoutMs?: number): Promise<SubagentResult[]>

  // 取消所有正在运行的 Subagent（用于会话终止）
  cancelAll(signal?: AbortSignal): void

  // 当前运行中的 Subagent 数量
  readonly runningCount: number

  // 当前队列中等待的 Subagent 数量
  readonly queuedCount: number
}
```

#### 3.3 abort() 传播到 SubagentManager

`AgentRunner.abort()` 在 Orchestrator 处于 `await SubagentManager.spawnBatch(...)` 阶段时，必须同时取消所有正在运行的 Subagent。

传播机制：
- `AgentOrchestrator` 在启动 `spawnBatch()` 前，将 `SubagentManager` 实例引用注册到 `AgentRunner`
- `spawnBatch()` 接受 `AbortSignal` 参数，用于外部取消
- `AgentRunner.abort()` 调用时，若存在活跃的 `SubagentManager` 实例，同步调用 `subagentManager.cancelAll(signal)`
- 各 `SubagentRunner` 响应 `AbortSignal` 时必须显式 break 内部消息循环，确保取消立即生效

#### 3.4 并发模型：Promise.all + 信号量

选择 **Promise.all + 信号量（Semaphore）** 模式，而非 Bun Worker。

选择理由：
- Subagent 的工作主要是 I/O 密集型（LLM API 调用），不是 CPU 密集型
- Bun Worker 的开销（序列化、进程通信）对纯 I/O 任务不划算
- Promise.all 在 Bun 的事件循环中天然并发，零额外开销
- 信号量控制 `maxConcurrency`，超出限制的任务进入 Promise 队列等待

派发流程（文字描述）：

```
Orchestrator 发出多个 spawn_subagent tool call
       ↓
SubagentManager.spawnBatch([input1, input2, input3], signal, batchTimeoutMs)
       ↓
信号量检查：当前运行数 < maxConcurrency ?
  ├── 是 → 立即创建 SubagentRunner 并启动
  └── 否 → 进入内部 Promise 队列等待（背压）
       ↓
所有 Subagent 并行执行，各自发射 subagent_* 事件
       ↓
Promise.all 等待全部完成（含单 Agent 超时取消 + 批次超时取消）
       ↓
汇总 SubagentResult[]，注入 Orchestrator 的 tool_result
       ↓
Orchestrator 继续下一轮 LLM 请求
```

背压策略：当 `runningCount + queuedCount >= maxQueueSize` 时，`spawnBatch` 立即返回失败的 `SubagentResult`（`error: "subagent_queue_full"`），Orchestrator 可据此提示用户或降级处理。

### 4. AgentEvent 扩展

> **注**：全量权威定义见 `src/agent/events.ts`，此处仅列本 Spec 新增类型。所有事件统一采用嵌套 `payload` 格式（与 Spec 2 保持一致）。

在现有 `AgentEvent` 类型基础上新增以下 5 种类型：

```ts
// src/agent/events.ts（本 Spec 新增类型，采用嵌套 payload 格式）

{ type: "subagent_start";     payload: { subagentId: string; task: string; index: number; total: number } }
{ type: "subagent_done";      payload: { subagentId: string; result: string; durationMs: number } }
{ type: "subagent_error";     payload: { subagentId: string; message: string } }
{ type: "subagent_progress";  payload: { subagentId: string; status: string } }
{ type: "subagent_cancelled"; payload: { subagentId: string; reason: "abort" | "timeout" } }
```

| type                  | 触发时机                                          |
|-----------------------|---------------------------------------------------|
| `subagent_start`      | SubagentRunner 开始执行                           |
| `subagent_done`       | Subagent 成功完成                                 |
| `subagent_error`      | Subagent 失败或 LLM 错误                          |
| `subagent_progress`   | Subagent 产生 stream_chunk 时转发（简要进度）     |
| `subagent_cancelled`  | Subagent 因超时或外部 abort 取消                  |

注意：`subagent_progress` 是对 Subagent 内部 `stream_chunk` 的映射转发，UI 可选择是否展示（默认展示简要进度，不展示完整 token 流）。

### 5. Subagent 隔离级别

#### 5.1 Context 隔离（强制）

每个 Subagent 拥有完全独立的消息历史，不继承 Orchestrator 的对话上下文。

- Subagent 的初始消息为：`[{ role: "user", content: task }]`
- Subagent 执行期间产生的所有 messages 只存在于其自身的 `SubagentContext` 中
- Subagent 结束后，其消息历史随之销毁（不写回 Orchestrator）

**隔离实现**：`SubagentRunner` 使用 `ephemeral: true` 的 `SessionManager`（Spec 3 定义）。在 `ephemeral` 模式下，`SessionManager.appendMessage()` 只更新内存、不写磁盘，Subagent 的消息历史不会写入用户活跃 session 的 JSONL 文件。`SubagentRunner` 不复用也不持有任何持久化 `SessionManager` 实例。

理由：context 隔离确保 Subagent 聚焦于子任务，避免大上下文导致的 token 浪费和推理干扰；`ephemeral` 模式防止 Subagent 的中间推理消息污染用户对话历史，重启后不会产生孤立消息。

#### 5.2 Provider 继承或独立

默认继承 Orchestrator 当前使用的 `LLMProvider`（共享同一 provider 实例，不共享连接）。

若 `SpawnSubagentInput.providerId` 指定了不同的 provider，则 Subagent 使用独立 provider 实例（从 `ProviderRegistry` 按 id 获取）。

应用场景：Orchestrator 用高智能模型做规划，Subagent 用快速廉价模型做执行。

#### 5.3 Memory 访问（可配置）

默认配置：Subagent 可读 memory，不可写 memory。

```ts
memoryAccess: {
  read: true,   // 默认：可读取 memory（获取已有上下文）
  write: false  // 默认：不可写入（防止 Subagent 污染 memory）
}
```

**隔离实现**：`SubagentRunner` 持有 `ScopedMemoryStore` 包装器（非直接操作底层 `MemoryStore`）。`ScopedMemoryStore` 在所有 `MemoryStore.add()` 调用时自动填充 `namespace: "subagent:{subagentId}"` 字段（Spec 8 已在 `MemoryEntry` 新增此可选字段），使 Subagent 写入的条目与 Orchestrator 的 memory 命名空间隔离。

准入控制规则：
- `memoryAccess.write: false`（默认）时，`ScopedMemoryStore.add()` 直接抛出错误，不调用底层 `MemoryStore`，拒绝操作
- `memoryAccess.write: true` 时，写入请求透传至 `MemoryStore.add()`，并自动注入 `namespace: "subagent:{subagentId}"`

Orchestrator 可在 tool_result 汇总后决定是否将 Subagent 写入的 memory 内容"提升"到全局命名空间，提升操作由 Orchestrator 的下一轮 LLM 推理发起（通过常规 memory 写入工具），而非自动同步。这一设计确保 Memory 写入路径唯一、可控，Orchestrator 始终是全局命名空间的守门人。

### 6. Subagent 生命周期

```
状态转换图：

  [pending] ──(信号量获取)──→ [running] ──(stream_done)──→ [done]
      │                          │
      │                          ├──(timeout 触发)──→ [cancelled]
      │                          │
      │                          └──(stream_error)──→ [error]
      │
      └──(maxQueueSize 超出)──→ [rejected]
```

| 状态 | 描述 |
|------|------|
| `pending` | 等待信号量，进入 Promise 队列 |
| `running` | AgentRunner 循环正在执行 |
| `done` | 成功完成，result 可用 |
| `cancelled` | 超时或外部取消（`cancelAll()`）触发 |
| `error` | LLM 错误或工具执行错误 |
| `rejected` | 因队列满而被拒绝，不进入执行 |

超时取消机制：使用 `Promise.race([subagentPromise, timeoutPromise])` 实现。超时触发时，向 SubagentRunner 发送取消信号（`AbortController`），AgentRunner 在下一个 yield 点检查并停止。

### 7. 结果汇总

Orchestrator 调用 `spawn_subagent` 后，`SubagentManager.spawnBatch` 返回 `Promise<SubagentResult[]>`。

汇总时机：必须等待**所有**该批次 Subagent 完成（Promise.all 语义），才将结果注入 Orchestrator 的 tool_result。

```
// tool_result 注入结构示意（伪代码）

[
  {
    type: "tool_result",
    tool_call_id: "<spawn_subagent call 1 id>",
    content: JSON.stringify({
      result: "subagent 1 的输出文本",
      success: true,
      durationMs: 3200
    })
  },
  {
    type: "tool_result",
    tool_call_id: "<spawn_subagent call 2 id>",
    content: JSON.stringify({
      result: "subagent 2 的输出文本",
      success: true,
      durationMs: 4100
    })
  }
]
```

Orchestrator 接收到所有 tool_result 后，进入下一轮 LLM 请求，此时 LLM 可基于汇总结果继续推进。

### 8. TUI 展示

当存在运行中的 Subagent 时，TUI 展示进度树区域。

**布局**：进度树区域采用 Spec 4 新增的 `SubagentProgressArea`，位于 `MessageArea` 和 `InputArea` 之间，最大高度 6 行。不使用独立的第四分区或浮层 Overlay，避免在小终端窗口中压缩 `MessageArea` 可用空间。

展示原则：
- 信息密度低：不展示 Subagent 的完整 token 流，只展示状态行
- 实时更新：每个 `subagent_*` 事件触发对应行的状态刷新
- 完成后折叠：全部 Subagent 完成后，进度树保留 **2 秒摘要**后消失（与 Spec 4 定义一致），不立即清除

**进度树布局（示意）：**

```
┌─ 并行任务 (3/3) ─────────────────────────────┐
│  ✓ [搜索文档]     完成 (3.2s)                 │
│  ✓ [分析代码]     完成 (4.1s)                 │
│  ⟳ [查询 API]     运行中... "正在解析响应"     │
└──────────────────────────────────────────────┘
```

状态图标：
- `⟳`（或动画旋转符）：running
- `✓`：done
- `✗`：error / cancelled
- `⏸`：pending（等待信号量）

TUI 组件接收 `subagent_*` AgentEvent，维护本地 `Map<id, SubagentDisplayState>`，按事件类型更新对应条目。UI 与 Agent 逻辑完全解耦，TUI 不调用任何 SubagentManager 方法。

### 9. 与 Hook 系统（Spec 7）的关系

Subagent 触发 Hook，但 Hook 上下文会标注来源。

| Hook 触发点 | 是否触发 | 备注 |
|------------|---------|------|
| `before_tool_call` | 是 | Subagent 内的工具调用触发 |
| `after_tool_call` | 是 | Subagent 内的工具调用触发 |
| `before_spawn_subagent` | 是（新增） | Orchestrator 即将派发 Subagent 时触发 |
| `after_spawn_subagent` | 是（新增） | 所有 Subagent 完成后触发 |
| `on_message` | 否 | Subagent 的内部消息不触发 Orchestrator 级别的 on_message hook |

Hook 上下文中增加 `subagentId?: string` 字段，Hook 实现可据此区分来源，选择性过滤或差异化处理。

**阻断机制**：`before_spawn_subagent` hook 通过 shell **退出码 2** 阻断 Subagent 派发，与其他 `before_*` 触发点一致，由 Spec 7 统一实现。不使用"返回 JavaScript 对象"的方式（shell 命令无法返回 JS 对象）。

`before_spawn_subagent` hook 注入的环境变量：

| 变量名 | 说明 |
|--------|------|
| `PAW_SUBAGENT_TASK` | 当前 Subagent 的 task 字符串 |
| `PAW_SUBAGENT_INDEX` | 当前 Subagent 在本批次中的下标（0-based） |
| `PAW_SUBAGENT_TOTAL` | 本批次 Subagent 总数 |
| `PAW_INSIDE_HOOK` | 固定为 `1`，标识当前在 Hook 上下文中执行 |

`after_spawn_subagent` hook 注入的环境变量：

| 变量名 | 说明 |
|--------|------|
| `PAW_SUBAGENT_TASK` | 派发的任务描述（与触发时一致） |
| `PAW_SUBAGENT_INDEX` | 当前 Subagent 在本批次中的下标（0-based） |
| `PAW_SUBAGENT_TOTAL` | 本批次 Subagent 总数 |
| `PAW_INSIDE_HOOK` | 固定为 `1`，防止 Hook 脚本内部递归触发 Hook |

### 10. 与 Memory 系统（Spec 8）的关系

如第 5.3 节所述，Subagent 默认可读、不可写 memory。

写入隔离规则（基于 Spec 8 新增的 `namespace` 字段）：
- `SubagentRunner` 持有 `ScopedMemoryStore` 包装器，自动在 `MemoryStore.add()` 调用时填充 `namespace: "subagent:{subagentId}"` 字段
- Orchestrator 可在 tool_result 汇总后决定是否将 Subagent 写入的 memory 内容"提升"到全局命名空间
- 提升操作由 Orchestrator 的下一轮 LLM 推理发起（通过常规 memory 写入工具），而非自动同步
- `memoryAccess.write: false` 时，`ScopedMemoryStore.add()` 直接抛出错误，不调用底层 `MemoryStore`

这一设计确保 Memory 写入路径唯一、可控，Orchestrator 始终是 memory 全局命名空间的守门人。

### 11. 配置项

在 `~/.paw/settings.json` 中新增 `subagent` 配置块：

```json
{
  "subagent": {
    "maxConcurrency": 4,
    "maxQueueSize": 16,
    "defaultTimeoutMs": 60000,
    "defaultBatchTimeoutMs": 0,
    "defaultMemoryAccess": {
      "read": true,
      "write": false
    }
  }
}
```

> 注：`defaultBatchTimeoutMs` 为 0 表示使用动态默认值（`maxConcurrency * defaultTimeoutMs`）。

---

## 验收标准

- [ ] Orchestrator 可在单次回复中发出多个 `spawn_subagent` tool call，系统并行执行
- [ ] `maxConcurrency` 限制生效：超出并发数的 Subagent 进入队列等待
- [ ] `maxQueueSize` 限制生效：队列满时返回 `subagent_queue_full` 错误，不崩溃
- [ ] Subagent 超时后正确触发取消，发射 `subagent_cancelled` 事件（`reason: "timeout"`），返回 `cancelled` 状态
- [ ] Subagent 的消息历史不写入用户活跃 session JSONL（`ephemeral: true` 验证）
- [ ] Subagent 指定独立 `providerId` 时，使用对应 provider 执行
- [ ] `subagent_start` / `subagent_done` / `subagent_error` / `subagent_progress` / `subagent_cancelled` 事件均采用嵌套 `payload` 格式且正确发射
- [ ] TUI 进度树展示在 `SubagentProgressArea`（MessageArea 和 InputArea 之间，最大 6 行），所有完成后保留 2 秒摘要再消失
- [ ] Subagent 内的工具调用正确触发 Hook（`subagentId` 字段存在）
- [ ] `before_spawn_subagent` hook 以退出码 2 阻断时，Subagent 不被派发
- [ ] `before_spawn_subagent` hook 收到 `PAW_SUBAGENT_TASK`、`PAW_SUBAGENT_INDEX`、`PAW_SUBAGENT_TOTAL`、`PAW_INSIDE_HOOK` 环境变量
- [ ] Subagent 读 memory 正常；写 memory 时自动填充 `namespace: "subagent:{id}"`
- [ ] `memoryAccess.write: false` 时，`ScopedMemoryStore.add()` 抛出错误，不调用底层 MemoryStore，不崩溃
- [ ] Subagent 内调用 `spawn_subagent` 立即返回 `{ success: false, error: "subagent_nesting_not_allowed" }`，不递归，不崩溃
- [ ] `cancelAll()` 正确取消所有运行中和队列中的 Subagent，发射 `subagent_cancelled`（`reason: "abort"`）
- [ ] `AgentRunner.abort()` 时 `subagentManager.cancelAll(signal)` 被同步调用，Subagent 不在后台继续运行
- [ ] `batchTimeoutMs` 超时时调用 `cancelAll()`，未完成的 Subagent 以 `{ success: false, error: "batch_timeout" }` 结束，会话可继续而非死锁
- [ ] `bunx tsc --noEmit` 通过

---

## 验证方式

1. 构造一个 Orchestrator prompt，令其派发 3 个并行 Subagent（不同 task），验证 TUI 进度树展示与最终结果汇总
2. 将 `maxConcurrency` 设为 1，验证 3 个 Subagent 串行执行（队列等待行为）
3. 将 `defaultTimeoutMs` 设为 100ms，验证 Subagent 超时取消流程
4. 在 Hook 中打印 `subagentId`，验证 Subagent 内工具调用触发 hook 且上下文正确
5. `bunx tsc --noEmit` 类型检查通过

---

## 回滚策略

本 Spec 新增组件均位于 `src/agent/subagent/` 目录下，对现有系统的改动仅限：

- `src/agent/events.ts`：新增 5 种 AgentEvent 类型（向后兼容，现有 switch 不处理新类型即忽略）
- `src/agent/tools/`：新增 `spawn-subagent.ts` 工具（不修改现有工具）
- `~/.paw/settings.json` schema：新增 `subagent` 配置块（可选字段，缺失时使用默认值）

回滚步骤：
1. 删除 `src/agent/subagent/` 目录
2. 删除 `src/agent/tools/spawn-subagent.ts`
3. 从 `src/agent/events.ts` 移除 5 种新 AgentEvent 类型
4. TUI 进度树组件移除（主聊天区域恢复原状）

回滚后现有 Orchestrator 串行执行逻辑完全不受影响。
