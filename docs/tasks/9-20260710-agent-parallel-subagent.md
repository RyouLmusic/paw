# Task: 并行 Subagent 系统

| 字段 | 值 |
|------|-----|
| 关联 Spec | docs/specs/9-20260710-agent-parallel-subagent.md |
| 状态 | pending |

---

## 任务清单

### T1 — 定义 Subagent 类型文件
**文件：** `src/agent/subagent/types.ts`

新建此文件，定义 Subagent 系统所有公共类型：
- `SubagentContext` 接口：描述单个 Subagent 的执行上下文，包含 `id`（唯一标识）、`label`（来自 `SpawnSubagentInput.label`）、`messages`（独立消息历史，类型为 `ChatMessage[]`）、`provider`（`LLMProvider` 实例）、`timeoutMs`、`memoryAccess`（`{ read: boolean; write: boolean }`）
- `SubagentResult` 接口：描述单个 Subagent 的执行结果，包含 `id`、`success`、可选 `result`（Subagent 最终 assistant 回复文本）、可选 `error`（失败原因，如 `"subagent_nesting_not_allowed"`、`"subagent_queue_full"`、`"batch_timeout"` 等）、`durationMs`
- `SpawnSubagentInput` 接口：描述工具调用的输入参数，包含 `task`（子任务描述）、可选 `label`、可选 `providerId`、可选 `timeoutMs`（默认 60000）、可选 `memoryAccess`（默认 `{ read: true, write: false }`）、可选 `batchTimeoutMs`
- `SpawnSubagentOutput` 接口：描述工具调用的返回值，包含 `result`、`success`、可选 `error`、`durationMs`

**预期结果：** 文件通过 `bunx tsc --noEmit`，所有接口可被项目其他模块导入，无运行时代码。

---

### T2 — 实现 SubagentRunner
**文件：** `src/agent/subagent/SubagentRunner.ts`

新建此文件，实现单个 Subagent 的执行器，是对 `AgentRunner` 的薄包装：

- **消息历史隔离**：使用 `ephemeral: true` 模式的 `SessionManager`（Spec 3 定义）初始化 Subagent 的消息历史，初始消息为 `[{ role: "user", content: task }]`；Subagent 执行期间产生的所有消息仅存在于内存中，不写入用户活跃 session 的 JSONL 文件；Subagent 结束后消息历史随之销毁
- **Provider 选择**：默认继承传入的 `provider` 实例（Orchestrator 当前 provider）；若 `SpawnSubagentInput.providerId` 指定了不同 provider，从 `ProviderRegistry` 按 id 获取独立实例
- **Memory 访问**：持有 `ScopedMemoryStore` 包装器（来自 Spec 8），自动填充 `namespace: "subagent:{id}"`；`memoryAccess.write: false` 时写操作直接抛出错误
- **AbortSignal 支持**：构造时接受 `AbortSignal`，在内部 AgentRunner 消息循环的每个 yield 点检查信号，触发后立即 break 循环，确保取消立即生效
- **嵌套检测**：在 `SubagentRunner` 执行期间，若内部 AgentRunner 又收到 `spawn_subagent` 工具调用，直接返回 `{ success: false, error: "subagent_nesting_not_allowed" }` 作为 tool_result，不递归创建 SubagentRunner，不崩溃
- **事件拦截**：Subagent 内部产生的 `AgentEvent` 不直接流向全局 UI 事件总线，由 `SubagentManager` 拦截后转换为 `subagent_progress` 事件再转发
- **返回值**：执行完成（`stream_done`）或取消/超时后，返回 `SubagentResult`

**预期结果：** Subagent 消息不写入用户 session JSONL；嵌套调用立即返回错误不递归；AbortSignal 触发后能立即停止。

---

### T3 — 实现 SubagentManager
**文件：** `src/agent/subagent/SubagentManager.ts`

新建此文件，实现 Subagent 并发控制、队列管理和生命周期管理：

- **并发控制**：采用 Promise.all + 信号量（Semaphore）模式，最大并发数为 `maxConcurrency`（默认 4）；超出并发限制的任务进入内部 Promise 队列等待
- **背压策略**：当 `runningCount + queuedCount >= maxQueueSize`（默认 16）时，`spawnBatch` 对超出部分立即返回失败的 `SubagentResult`（`error: "subagent_queue_full"`），不崩溃，Orchestrator 可据此降级处理
- **`spawnBatch(inputs, signal?, batchTimeoutMs?)`**：接收同一批次的所有 `SpawnSubagentInput`，并行启动所有 Subagent（受信号量约束），使用 `Promise.all` 等待全部完成（含单个 Subagent 超时 + 批次整体超时）；外部 `AbortSignal` 触发时同步取消全部运行中和队列中的 Subagent；批次超时（`batchTimeoutMs`）到达时调用 `cancelAll()`，未完成的 Subagent 以 `{ success: false, error: "batch_timeout" }` 结束，`Promise.all` 正常 resolve，会话不死锁
- **`cancelAll(signal?)`**：取消所有运行中和队列中的 Subagent，向各 `SubagentRunner` 发送取消信号（通过 `AbortController`），发射对应的 `subagent_cancelled` 事件
- **单 Subagent 超时**：使用 `Promise.race([subagentPromise, timeoutPromise])` 实现；超时触发时向 `SubagentRunner` 发送取消信号，发射 `subagent_cancelled`（`reason: "timeout"`）
- **只读属性**：暴露 `runningCount`（当前运行中数量）和 `queuedCount`（队列等待数量）
- **事件转发**：拦截 `SubagentRunner` 内部事件，将 `stream_chunk` 转换为 `subagent_progress` 事件后转发至全局事件总线

**预期结果：** 并发超限时任务进入队列而非直接失败；队列满时立即返回 `subagent_queue_full` 错误；批次超时时会话可继续而非死锁；`cancelAll()` 能正确传播取消信号。

---

### T4 — 实现 spawn_subagent 工具
**文件：** `src/agent/tools/spawn-subagent.ts`

新建此文件，将 `spawn_subagent` 注册为 Spec 5 工具系统的内置工具：

- **工具定义**：参照 Spec 5 的工具注册规范，定义工具名称（`spawn_subagent`）、描述（说明其用于派发并行子任务）、输入 schema（对应 `SpawnSubagentInput` 字段，含 `task`（必填）、`label`、`providerId`、`timeoutMs`、`memoryAccess`、`batchTimeoutMs` 等可选字段）
- **工具处理逻辑**：工具被调用时，将解析后的 `SpawnSubagentInput` 传递给 `SubagentManager.spawnBatch()`；工具本身不直接执行 Subagent，只负责参数传递和结果包装
- **返回格式**：将 `SubagentResult` 序列化为 `SpawnSubagentOutput` JSON 字符串，作为 tool_result 注入 Orchestrator 的消息历史
- **内置注册**：通过 Spec 5 工具注册机制将此工具加入内置工具列表，Orchestrator 启动时自动可用，无需用户手动配置

**预期结果：** LLM 可通过 tool call 调用 `spawn_subagent`；工具 schema 描述清晰，LLM 能正确填写参数；结果以 JSON 形式返回给 Orchestrator。

---

### T5 — 扩展 AgentEvent 类型
**文件：** `src/agent/events.ts`

在现有 `AgentEvent` 联合类型中新增 5 个 Subagent 相关事件类型，采用嵌套 `payload` 格式（与已有事件风格保持一致）：
- `subagent_start`：payload 含 `subagentId`、`task`（子任务描述）、`index`（批次内序号，从 0 开始）、`total`（批次总数）
- `subagent_done`：payload 含 `subagentId`、`result`（最终输出文本）、`durationMs`
- `subagent_error`：payload 含 `subagentId`、`message`（错误描述）
- `subagent_progress`：payload 含 `subagentId`、`status`（简要进度文本，来自内部 `stream_chunk` 的映射）
- `subagent_cancelled`：payload 含 `subagentId`、`reason`（`"abort" | "timeout"`）

需同时检查文件中已有的 exhaustive switch 或类型断言，确保新类型加入后不破坏现有编译。

**预期结果：** 5 个新事件类型通过 `bunx tsc --noEmit`；现有事件处理代码不受影响。

---

### T6 — 更新 AgentOrchestrator 集成 Subagent 系统
**文件：** `src/agent/orchestrator.ts`

修改 `AgentOrchestrator`，集成 Subagent 系统：

- **SubagentManager 注入**：在构造函数或初始化阶段接收 `SubagentManager` 实例（依赖注入），不在内部直接实例化
- **工具调用路由**：在工具调用回路中识别 `spawn_subagent` 工具调用，将同一次 LLM 回复中的多个 `spawn_subagent` tool call 汇总为一个批次，传递给 `SubagentManager.spawnBatch()`；等待全部完成后将每个 `SubagentResult` 分别序列化为对应 tool call 的 tool_result，注入消息历史，继续下一轮 LLM 请求
- **abort() 传播**：在 `AgentRunner` 中注册 `SubagentManager` 引用，使 `AgentRunner.abort()` 调用时，若存在活跃的 `SubagentManager` 实例，同步调用 `subagentManager.cancelAll(signal)`，确保 Subagent 不在后台继续运行
- **Hook 系统接入**：在 Orchestrator 决定派发 Subagent 之前触发 `before_spawn_subagent` Hook（复用 T4 中 HookExecutor，来自 Spec 7）；若 Hook 返回 `blocked=true`，该 Subagent 不被派发，emit `hook_blocked` 事件；所有 Subagent 完成后触发 `after_spawn_subagent` Hook；Hook context 的 `payload` 中包含 `PAW_SUBAGENT_TASK`、`PAW_SUBAGENT_INDEX`、`PAW_SUBAGENT_TOTAL`、`PAW_INSIDE_HOOK=1` 环境变量

**预期结果：** Orchestrator 在 LLM 回复含多个 `spawn_subagent` 调用时能并行派发；`abort()` 调用后所有 Subagent 立即停止；Hook 阻断时对应 Subagent 不被创建。

---

### T7 — 更新 SubagentProgressArea 组件
**文件：** `src/components/SubagentProgressArea.tsx`

修改（若文件已存在）或新建 TUI 进度树组件，消费 `subagent_*` 事件：

- **事件消费**：监听 `subagent_start`、`subagent_done`、`subagent_error`、`subagent_progress`、`subagent_cancelled` 事件
- **状态维护**：在组件内部维护 `Map<subagentId, SubagentDisplayState>`，每个状态包含 `label`、当前状态（`pending`/`running`/`done`/`error`/`cancelled`）、最新进度文本（来自 `subagent_progress`）、耗时（来自 `subagent_done`）
- **进度树布局**：位于 `MessageArea` 和 `InputArea` 之间，最大高度 6 行；展示格式参照 Spec：每行一个 Subagent，显示状态图标（`⟳` running / `✓` done / `✗` error 或 cancelled / `⏸` pending）、label 和状态文本；首行显示批次概览"并行任务 (已完成数/总数)"
- **完成后消失**：当批次内全部 Subagent 进入终态（`done`/`error`/`cancelled`）后，保留 2 秒摘要视图后自动消失（清除组件渲染），不立即清除
- **解耦原则**：组件不调用任何 `SubagentManager` 方法，仅消费事件，与 Agent 逻辑完全解耦

**预期结果：** 有运行中 Subagent 时组件出现在正确位置；状态随事件实时更新；全部完成后 2 秒消失；组件不超过 6 行高度。

---

## 执行顺序

```
T1（类型定义）
  ↓
T2（SubagentRunner）   T3（SubagentManager）   T4（spawn_subagent 工具）   ← 可并行，T2/T3 依赖 T1
  ↓──────────────────────────────────────────────↓
T5（AgentEvent 扩展）
  ↓
T6（Orchestrator 集成）
  ↓
T7（SubagentProgressArea UI）
```

注：T2 和 T3 均依赖 T1 的类型定义；T4 依赖 T1 的 `SpawnSubagentInput`/`SpawnSubagentOutput` 类型，因此 T2/T3/T4 可在 T1 完成后并行开发；T6 的 Orchestrator 集成依赖 T2（SubagentRunner）、T3（SubagentManager）、T4（工具注册）和 T5（新事件类型），需在上述全部完成后进行。

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
| T7 | pending | — |
