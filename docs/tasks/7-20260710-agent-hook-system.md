# Task: Agent Hook 系统

| 字段 | 值 |
|------|-----|
| 关联 Spec | docs/specs/7-20260710-agent-hook-system.md |
| 状态 | pending |

---

## 任务清单

### T1 — 定义 Hook 类型文件
**文件：** `src/agent/hooks/types.ts`

新建此文件，定义 Hook 系统所有公共类型：
- `HookConfig` 接口：描述 `settings.json` 中单条 Hook 配置，包含 `id`、`command`、`args`、`cwd`、`env`、`timeout`、`enabled` 字段
- `HookEvent` 联合类型：枚举全部 9 个触发点（`before_user_message`、`after_assistant_message`、`before_tool_call`、`after_tool_call`、`on_session_start`、`on_session_end`、`on_provider_change`、`before_spawn_subagent`、`after_spawn_subagent`），其中子 Agent 两个触发点标注来自 Spec 9
- `HookContext` 接口：传入 `HookExecutor.run()` 的上下文，包含 `event`、`sessionId`、`payload`（键值对，对应各触发点注入变量）
- `HookResult` 接口：`run()` 返回值，包含 `hookId`、`event`、`exitCode`（null 表示超时）、`stdout`、`stderr`、`durationMs`、`timedOut`、`blocked`（`exitCode === 2` 时为 true）
- `HookExecutor` 接口：声明 `run(event, context): Promise<HookResult[]>` 方法签名，支持串行或并行执行同一触发点的多个 Hook

**预期结果：** 文件通过 `bunx tsc --noEmit` 类型检查，所有接口可被项目其他模块导入使用，无运行时代码。

---

### T2 — 实现 HookExecutor
**文件：** `src/agent/hooks/executor.ts`

新建此文件，实现 `HookExecutor` 接口：

- **进程启动**：使用 `Bun.spawn()` 启动子进程，将 `command` 与 `args` 分离传递，不经过 shell 解析，避免 shell 注入
- **路径展开**：`command` 和 `cwd` 字段中的 `~` 替换为 `$HOME`（`process.env.HOME`）
- **环境变量白名单**：子进程仅继承 `PATH`、`HOME`、`LANG`、`SHELL`、`TERM`、`USER` 六个系统变量，加上 paw 专属注入变量（`PAW_HOOK_ID`、`PAW_HOOK_EVENT`、`PAW_SESSION_ID` 及触发点对应变量），再与 `HookConfig.env` 字段合并（`env` 优先级最高）
- **敏感变量过滤**：对所有来源的环境变量，过滤名称包含 `_API_KEY`、`_SECRET`、`_TOKEN` 的条目，不传入子进程
- **stdout 脱敏**：`hook_completed` 事件的 `stdout` 字段在传给 `AgentEvent` 前，扫描并将 `sk-ant-***`、`sk-***` 等已知 API Key 格式替换为 `[REDACTED]`
- **超时机制**：通过 `AbortController` + `AbortSignal` 实现超时，超时后向子进程发送 `SIGTERM`，等待 500ms 无响应则发送 `SIGKILL`；超时视同退出码 null，`timedOut` 为 true，不阻止后续动作
- **command 白名单校验**：`command` 字段必须匹配正则 `^[a-zA-Z0-9._/~-]+$`，不符合则在启动时输出警告并跳过该 Hook，不崩溃
- **args 空字节过滤**：`args` 数组中含 `\0` 空字节的元素在启动时输出警告并跳过该 Hook
- **数量上限**：单个触发点超过 10 个 Hook 时启动时输出警告，仅执行前 10 个
- **循环保护**：执行期间设置进程级标志 `INSIDE_HOOK=1`，防止 Hook 内部再次触发新的 Hook
- **阻止判断**：仅 `before_*` 类触发点检查 `blocked`（`exitCode === 2`），`after_*` 和 `on_*` 类不检查
- **并行/串行**：依据 `hookSettings.parallelExecution` 配置决定执行策略，默认串行
- stdout/stderr 各截断至 4096 字节

**预期结果：** 可通过 `bunx tsc --noEmit`；配置有效 Hook 时 `run()` 返回 `HookResult[]`；配置无效 command 时启动时有警告且不崩溃。

---

### T3 — 扩展 AgentEvent 类型
**文件：** `src/agent/events.ts`

在现有 `AgentEvent` 联合类型中新增 3 个 Hook 相关事件类型，采用嵌套 `payload` 格式（与已有事件风格保持一致）：
- `hook_started`：payload 含 `hookName`（Hook 的 `id`）、`trigger`（`HookEvent` 名称）、可选 `subagentId`（仅子 Agent 触发点存在）
- `hook_completed`：payload 含 `hookName`、`exitCode`（null 表示超时）、`stdout`（已脱敏，截断至 4096 字节）、`durationMs`
- `hook_blocked`：payload 含 `hookName`、`trigger`、`blockedAction`（被阻止动作的描述，如工具名称或消息摘要）

需同时更新文件中任何 exhaustive switch 检查或类型断言，确保新类型加入后不破坏现有编译。

**预期结果：** 3 个新事件类型通过 TypeScript 类型检查；现有事件处理代码不受影响。

---

### T4 — 将 HookExecutor 注入 AgentOrchestrator
**文件：** `src/agent/orchestrator.ts`

修改 `AgentOrchestrator`，集成 Hook 系统：
- 在构造函数或初始化阶段接收 `HookExecutor` 实例（依赖注入，不在内部直接实例化）
- 读取 `settings.json` 中的 `hooks` 字段；若字段缺失或为空，直接跳过所有 Hook 触发逻辑，不产生任何 Hook 事件
- 在以下 7 个关键路径插入 Hook 触发点（`before_spawn_subagent`/`after_spawn_subagent` 由 Spec 9 集成，此处暂不实现）：
  - `before_user_message`：用户消息发送给 LLM 之前；若有 Hook 返回 `blocked=true`，不发送消息，emit `hook_blocked`
  - `after_assistant_message`：LLM 回复完成后（`stream_done` 后）；不检查 blocked
  - `before_tool_call`：工具调用执行前；若 blocked，跳过工具调用，emit `hook_blocked`
  - `after_tool_call`：工具调用完成后；不检查 blocked
  - `on_session_start`：会话初始化完成后；不检查 blocked
  - `on_session_end`：会话结束时；不检查 blocked
  - `on_provider_change`：Provider 切换时；不检查 blocked
- 每次触发前 emit `hook_started`，执行完成后 emit `hook_completed`，阻止时额外 emit `hook_blocked`
- 构建 `HookContext` 时按 Spec 中各触发点的注入变量规范填充 `payload`，长字符串截断至 8192 字节
- `enabled: false` 的 Hook 不触发任何事件，直接跳过

**预期结果：** `settings.json` 无 hooks 配置时 Orchestrator 行为与原来完全相同；有 hooks 配置时对应触发点正确执行 Hook 并产生事件；退出码 2 的 `before_*` Hook 正确阻止后续动作。

---

### T5 — 更新 App.tsx 消费 Hook 事件
**文件：** `src/App.tsx`

修改 TUI 主组件，监听并渲染 Hook 相关 AgentEvent：
- `hook_started`：在状态栏或 activity 区域显示"⏳ Running hook: `{hookName}`"，反映当前正在执行的 Hook
- `hook_completed` 且 `exitCode === null`（超时）：显示警告"⚠️ Hook `{hookName}` timed out"
- `hook_completed` 且 `exitCode` 非零非 null：显示警告，附带 stdout 摘要（截断显示）
- `hook_blocked`：**必须**在对话区域插入系统级提示"[Hook 拦截] 操作被 `{hookName}` 阻止"，样式为红色，不可作为可选项，不能省略

渲染规则：
- `hook_started`/`hook_completed` 可在状态栏等非核心区域展示，不强制占用对话区域
- `hook_blocked` 必须插入对话消息流中，视觉上等同于系统错误消息，不可被忽略

**预期结果：** 收到 `hook_blocked` 事件后，TUI 无论处于何种状态都会在对话区域显示红色拦截提示；`hook_started`/`hook_completed` 不干扰正常对话显示。

---

## 执行顺序

```
T1（类型定义）
  ↓
T2（HookExecutor 实现）  T3（AgentEvent 扩展）   ← 可并行
  ↓──────────────────────────↓
T4（Orchestrator 集成）
  ↓
T5（App.tsx UI 接入）
```

---

## 完成记录

| 任务 | 状态 | 验证结果 |
|------|------|----------|
| T1 | pending | — |
| T2 | pending | — |
| T3 | pending | — |
| T4 | pending | — |
| T5 | pending | — |
