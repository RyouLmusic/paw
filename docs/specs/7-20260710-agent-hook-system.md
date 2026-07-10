# Spec 7：Agent Hook 系统

| 字段 | 值 |
|------|-----|
| 状态 | approved |
| 日期 | 2026-07-10 |
| 修订日期 | 2026-07-10（review 修复）|
| 风险级别 | 中 |

> **风险判断理由：** Hook 系统新增多个 `AgentEvent` 类型（`hook_started` / `hook_completed` / `hook_blocked`），并在 Agent 生命周期关键路径（工具调用前后、消息收发前后）插入异步外部进程调用，可能影响 Agent 主流程的稳定性和响应延迟，但不修改渲染框架和 Agent-UI 通信协议本身，故定级为**中**。

---

## 背景 / 目标 / 范围

### 背景

paw 的用户（包括高级用户和团队管理员）需要在 Agent 交互的特定时机自动执行自定义逻辑：例如在工具调用前审计命令、在 assistant 回复完成后写入日志、在会话结束后触发清理脚本。这类需求通过内置功能无法穷举，必须暴露一个可编程扩展点。

参考系统：Claude Code 的 hooks 机制，通过 `settings.json` 配置、在生命周期节点自动执行 shell 命令，并通过退出码控制后续动作是否继续。

### 目标

1. 定义 9 个标准 Hook 触发点，覆盖 Agent 生命周期的关键节点（含 Spec 9 新增的子 Agent 触发点）
2. 支持 shell 命令（`command` 类型）Hook，可配置超时、工作目录、环境变量
3. `before_*` 类 Hook 通过退出码阻止后续动作
4. Hook 执行结果通过 `AgentEvent` 反馈给 UI，保持 Agent-UI 解耦
5. 提供安全限制（超时上限、循环检测、Hook 内不允许再触发 Hook）

### 包含

- `settings.json` 中 `hooks` 配置 schema 定义
- 9 个 Hook 触发点的语义规范（含 Spec 9 新增的 `before_spawn_subagent` / `after_spawn_subagent`）
- `HookExecutor` 组件：执行 shell 命令、捕获 stdout/stderr、处理超时
- `AgentEvent` 扩展：`hook_started` / `hook_completed` / `hook_blocked`
- Hook 执行器与 Agent 编排逻辑的集成接口规范
- 安全限制策略

### 不包含

- JS 回调类型的 Hook（当前版本仅支持 `command`，JS 回调留作后续扩展）
- Hook 的 TUI 可视化编辑器（settings.json 由用户手动编辑）
- Hook 执行结果写入持久日志文件（UI 事件流即为当次会话的记录）
- 网络调用类 Hook（仅允许本地进程，不直接支持 HTTP 回调）

---

## 技术方案

### 1. settings.json 配置结构

Hook 配置作为顶层字段 `hooks` 追加到现有 `settings.json`：

```json
{
  "activeProvider": "anthropic-default",
  "providers": [ "..." ],
  "hooks": {
    "before_user_message": [
      {
        "id": "log-user-input",
        "command": "~/.paw/hooks/log.sh",
        "args": ["--event", "before_user_message"],
        "cwd": "~",
        "env": {
          "PAW_HOOK_LOG": "/tmp/paw-hooks.log"
        },
        "timeout": 5000,
        "enabled": true
      }
    ],
    "after_assistant_message": [
      {
        "id": "post-reply-notify",
        "command": "~/.paw/hooks/notify.sh",
        "timeout": 3000,
        "enabled": true
      }
    ],
    "before_tool_call": [
      {
        "id": "audit-tool-call",
        "command": "~/.paw/hooks/audit.sh",
        "timeout": 10000,
        "enabled": true
      }
    ],
    "after_tool_call": [],
    "on_session_start": [
      {
        "id": "session-init",
        "command": "~/.paw/hooks/session-init.sh",
        "timeout": 5000,
        "enabled": true
      }
    ],
    "on_session_end": [
      {
        "id": "session-cleanup",
        "command": "~/.paw/hooks/cleanup.sh",
        "timeout": 10000,
        "enabled": true
      }
    ],
    "on_provider_change": [
      {
        "id": "provider-log",
        "command": "~/.paw/hooks/provider-log.sh",
        "timeout": 3000,
        "enabled": true
      }
    ]
  }
}
```

**配置字段说明：**

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `id` | `string` | 是 | — | Hook 唯一标识，用于日志追踪和 UI 事件 payload |
| `command` | `string` | 是 | — | 可执行文件路径或 shell 内置命令；支持 `~` 展开 |
| `args` | `string[]` | 否 | `[]` | 追加到命令后的参数列表 |
| `cwd` | `string` | 否 | 项目根目录 | 命令工作目录；支持 `~` 展开 |
| `env` | `Record<string, string>` | 否 | `{}` | 注入到子进程的额外环境变量，与当前进程环境合并 |
| `timeout` | `number` | 否 | `5000` | 超时毫秒数，上限为 `30000`；超出强制终止 |
| `enabled` | `boolean` | 否 | `true` | 为 `false` 时跳过执行，不产生任何事件 |

**全局约束（`settings.json` 顶层可选字段）：**

```json
{
  "hookSettings": {
    "maxTimeoutMs": 30000,
    "parallelExecution": false
  }
}
```

- `maxTimeoutMs`：单个 Hook 超时上限，默认 30000ms，用户无法在单条 Hook 配置中超过此值
- `parallelExecution`：同一触发点的多个 Hook 是否并行执行，默认 `false`（串行）

---

### 2. Hook 触发点语义

#### 触发点一览

| 触发点 | 分类 | 可阻止后续动作 | 注入环境变量 |
|--------|------|:--------------:|-------------|
| `before_user_message` | 消息生命周期 | 是 | `PAW_USER_MESSAGE` |
| `after_assistant_message` | 消息生命周期 | 否 | `PAW_ASSISTANT_MESSAGE` |
| `before_tool_call` | 工具生命周期 | 是 | `PAW_TOOL_NAME`, `PAW_TOOL_INPUT` |
| `after_tool_call` | 工具生命周期 | 否 | `PAW_TOOL_NAME`, `PAW_TOOL_OUTPUT`, `PAW_TOOL_EXIT_CODE` |
| `on_session_start` | 会话生命周期 | 否 | `PAW_SESSION_ID` |
| `on_session_end` | 会话生命周期 | 否 | `PAW_SESSION_ID`, `PAW_SESSION_DURATION_MS` |
| `on_provider_change` | Provider 生命周期 | 否 | `PAW_OLD_PROVIDER_ID`, `PAW_NEW_PROVIDER_ID`, `PAW_NEW_MODEL` |
| `before_spawn_subagent` | 子 Agent 生命周期 | 是 | `PAW_SUBAGENT_TASK`, `PAW_SUBAGENT_INDEX`, `PAW_SUBAGENT_TOTAL`, `PAW_INSIDE_HOOK=1` |
| `after_spawn_subagent` | 子 Agent 生命周期 | 否 | `PAW_SUBAGENT_TASK`, `PAW_SUBAGENT_INDEX`, `PAW_SUBAGENT_TOTAL`, `PAW_INSIDE_HOOK=1` |

**注入环境变量补充规则：**
- 所有触发点均注入：`PAW_HOOK_ID`（当前 Hook 的 `id`）、`PAW_HOOK_EVENT`（触发点名称）、`PAW_SESSION_ID`
- `PAW_TOOL_INPUT` 为 JSON 字符串（工具入参）
- `PAW_TOOL_OUTPUT` 为工具调用的 stdout 内容（截断至 4096 字节）
- `PAW_SUBAGENT_TASK`：子 Agent 的任务描述字符串（截断至 8192 字节）
- `PAW_SUBAGENT_INDEX`：当前子 Agent 在批次中的序号（从 0 开始）
- `PAW_SUBAGENT_TOTAL`：当前批次中子 Agent 的总数
- 长字符串字段均截断至 8192 字节，超出部分不传入环境变量（防止 ARG_MAX 超限）

#### 阻止机制

仅 `before_user_message`、`before_tool_call` 和 `before_spawn_subagent` 支持阻止。所有 `before_*` 触发点统一通过 shell **退出码 2** 表示主动阻断，不存在"返回 `{ cancel: true }` 对象"的机制。规则如下：

| 退出码 | 语义 | 说明 |
|--------|------|------|
| `0` | 继续 | 后续动作正常执行 |
| `2` | **主动阻断** | HookExecutor 触发 `hook_blocked` 事件，Agent 编排器不继续执行该动作 |
| `1` 或其他非零值 | Hook 自身执行失败 | 记录错误但**不阻止**后续动作（宽松策略，避免 Hook bug 导致 Agent 完全不可用） |
| 超时 | 视同退出码 `1` | 不阻止后续动作 |

| 触发点 | 阻断时的行为 | 说明 |
|--------|-------------|------|
| `before_user_message` | 消息不发送给 LLM，触发 `hook_blocked` 事件 | 由于 Spec 2 / Spec 3 已将写盘时机后置至 hook 执行之后，本 Spec 的 `hook_blocked` 事件只需通知 UI，**无需 Hook 层自行回滚状态**（已由上层保证） |
| `before_tool_call` | 工具调用被跳过，触发 `hook_blocked` 事件 | 与 `before_user_message` 同理，回滚由上层保证 |
| `before_spawn_subagent` | 该子 Agent 不被派生，触发 `hook_blocked` 事件 | 退出码 2 与其他 `before_*` 触发点一致 |

> **设计决策说明：** 退出码 `2` 专用于"主动阻止"，与 Unix 惯例中 `1` 表示一般错误区分，降低误阻止风险。

---

### 3. HookExecutor 接口规范

```ts
// src/agent/hooks/types.ts

/** settings.json 中单条 hook 配置 */
export interface HookConfig {
  id: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeout?: number          // 单位：ms，上限由 hookSettings.maxTimeoutMs 约束
  enabled?: boolean
}

/** Hook 触发点名称 */
export type HookEvent =
  | "before_user_message"
  | "after_assistant_message"
  | "before_tool_call"
  | "after_tool_call"
  | "on_session_start"
  | "on_session_end"
  | "on_provider_change"
  | "before_spawn_subagent"   // Spec 9 新增：派生子 Agent 前触发，支持退出码 2 阻断
  | "after_spawn_subagent"    // Spec 9 新增：子 Agent 完成后触发，不可阻断

/** 传入 HookExecutor.run() 的上下文，用于注入环境变量 */
export interface HookContext {
  event: HookEvent
  sessionId: string
  payload: Record<string, string>   // 对应触发点的注入变量
}

/** HookExecutor.run() 的返回值 */
export interface HookResult {
  hookId: string
  event: HookEvent
  exitCode: number | null           // null 表示超时强制终止
  stdout: string                    // 截断至 4096 字节
  stderr: string                    // 截断至 4096 字节
  durationMs: number
  timedOut: boolean
  blocked: boolean                  // exitCode === 2
}

/** HookExecutor 接口 */
export interface HookExecutor {
  /**
   * 执行指定触发点下所有 enabled=true 的 Hook
   * 串行或并行取决于 hookSettings.parallelExecution
   * 返回所有 Hook 的执行结果列表
   */
  run(event: HookEvent, context: HookContext): Promise<HookResult[]>
}
```

**HookExecutor 实现要点（非代码，设计约束）：**

- 使用 `Bun.spawn()` 启动子进程，非 `child_process.exec`，避免 shell 注入（命令和参数分离传递）
- `command` 字段经过路径展开（`~` → `$HOME`）后直接作为可执行文件路径，不经过 shell 解析
- **子进程环境变量白名单传递**：不继承父进程完整环境，仅传递以下白名单变量：`PATH`、`HOME`、`LANG`、`SHELL`、`TERM`、`USER`，以及 paw 专属变量（如 `PAW_SESSION_ID`、`PAW_HOOK_ID`、`PAW_HOOK_EVENT` 等注入变量）；再与 `env` 字段合并（`env` 优先级更高）
- **敏感变量过滤**：明确过滤所有名称包含 `_API_KEY`、`_SECRET`、`_TOKEN` 后缀的环境变量，不论其来源（父进程或 `env` 字段）
- **stdout 脱敏**：`hook_completed.payload.stdout` 在传入 `AgentEvent` 前扫描并脱敏已知 API Key 格式（如 `sk-ant-***`、`sk-***` 等），替换为 `[REDACTED]`
- 超时通过 `AbortSignal` + `AbortController` 实现，超时后向子进程发送 `SIGTERM`，500ms 后无响应则 `SIGKILL`
- stdout / stderr 分别捕获，不在 TUI 直接打印，通过 `AgentEvent` 携带给 UI 层决定是否展示

---

### 4. AgentEvent 扩展

> **权威定义说明：** 全量权威定义见 `src/agent/events.ts`，此处仅列本 Spec 新增类型。所有 AgentEvent 统一采用嵌套 `payload` 格式（由 P0-01 规范确立）。

在现有 `AgentEvent` 类型基础上新增 3 个 Hook 相关事件：

```ts
// src/agent/events.ts 本 Spec 新增类型（嵌套 payload 格式）

{ type: "hook_started";   payload: { hookName: string; trigger: HookEvent; subagentId?: string } }
{ type: "hook_completed"; payload: { hookName: string; exitCode: number | null; stdout: string; durationMs: number } }
{ type: "hook_blocked";   payload: { hookName: string; trigger: HookEvent; blockedAction: string } }
```

**字段说明：**

| 事件类型 | 字段 | 说明 |
|----------|------|------|
| `hook_started` | `hookName` | Hook 的 `id` 字段值 |
| `hook_started` | `trigger` | 触发该 Hook 的 `HookEvent` 名称 |
| `hook_started` | `subagentId?` | 仅在 `before_spawn_subagent` / `after_spawn_subagent` 触发时存在 |
| `hook_completed` | `hookName` | Hook 的 `id` 字段值 |
| `hook_completed` | `exitCode` | null 表示超时强制终止 |
| `hook_completed` | `stdout` | 截断至 4096 字节，已完成 API Key 格式脱敏（见 HookExecutor 实现要点） |
| `hook_completed` | `durationMs` | 实际执行耗时（含超时等待）|
| `hook_blocked` | `hookName` | 触发阻断的 Hook 的 `id` 字段值 |
| `hook_blocked` | `trigger` | 触发点名称（如 `"before_tool_call"`） |
| `hook_blocked` | `blockedAction` | 被阻止的动作描述（如工具名称或消息摘要） |

**UI 处理规范：**

- `hook_started`：在状态栏或 activity 区域显示"⏳ Running hook: `{hookName}`"
- `hook_completed` 且 `exitCode === null`（超时）：显示警告"⚠️ Hook `{hookName}` timed out"
- `hook_completed` 且 `exitCode !== 0 && exitCode !== null`：显示警告，附带 stdout 摘要
- `hook_blocked`：**必须**在对话区域插入系统级提示"[Hook 拦截] 操作被 `{hookName}` 阻止"，不可作为可选项

---

### 5. Agent 编排集成流程

以 `before_tool_call` 为例，完整执行流程如下（文字描述）：

```
Agent 编排器决定调用工具
  │
  ▼
构造 HookContext { event: "before_tool_call", payload: { PAW_TOOL_NAME, PAW_TOOL_INPUT, ... } }
  │
  ▼
HookExecutor.run("before_tool_call", context)
  │
  ├─ 依次执行每个 enabled Hook
  │    ├─ 发送 AgentEvent: hook_started
  │    ├─ Bun.spawn(command, args, { env, cwd, signal: abortSignal })
  │    ├─ 等待 exitCode（或超时触发 SIGTERM/SIGKILL）
  │    └─ 发送 AgentEvent: hook_completed
  │
  ▼
检查所有 HookResult
  │
  ├─ 存在 blocked=true（exitCode===2）?
  │    ├─ 是 → 发送 AgentEvent: hook_blocked → Agent 跳过工具调用 → 流程结束
  │    └─ 否 → 继续
  │
  ▼
Agent 执行工具调用（正常流程继续）
```

其余触发点流程类似，`after_*` 和 `on_*` 类触发点不检查 `blocked` 状态，HookExecutor 返回后 Agent 编排器直接继续。

---

### 6. 安全限制策略

| 限制项 | 规则 | 原因 |
|--------|------|------|
| 超时上限 | 单个 Hook 最大 `30000ms`，`hookSettings.maxTimeoutMs` 可降低但不可超过此值 | 防止挂起阻塞 Agent 主流程 |
| 禁止 Hook 内触发 Hook | HookExecutor 执行期间设置上下文标志 `INSIDE_HOOK=1`；新的 AgentEvent 产生时检查此标志，若为 `1` 则跳过 Hook 触发 | 防止无限循环 |
| 同一触发点 Hook 数量上限 | 单个触发点最多 `10` 个 Hook | 防止配置膨胀导致每次交互延迟不可控 |
| command 路径白名单 | `command` 字段仅允许匹配 `^[a-zA-Z0-9._/~-]+$`，不符合则拒绝加载并在启动时输出警告；注：使用 `Bun.spawn()` 非 shell 执行已降低 shell 注入风险，白名单作为深度防御保留 | 防止通过 settings.json 执行任意 shell pipeline |
| args 参数空字节过滤 | `args` 数组每个元素拒绝含 `\0`（空字节）的值，包含时拒绝加载并输出警告 | 防止参数注入绕过路径校验 |
| 环境变量大小限制 | 单个注入环境变量值截断至 8192 字节 | 防止触碰系统 ARG_MAX 限制 |
| stdout/stderr 截断 | 各截断至 4096 字节 | 防止大输出填满 AgentEvent 通道 |
| 子进程环境变量过滤 | 白名单传递（仅 `PATH`、`HOME`、`LANG`、`SHELL`、`TERM`、`USER` 及 paw 专属变量）；过滤所有含 `_API_KEY`、`_SECRET`、`_TOKEN` 后缀的变量 | 防止 Hook 脚本读取并泄漏 API Key |

---

## 验收标准

- [ ] `settings.json` 中 `hooks` 字段缺失或为空时，Agent 正常运行，不产生任何 Hook 相关事件
- [ ] `enabled: false` 的 Hook 不执行、不产生任何 AgentEvent
- [ ] `before_tool_call` Hook 以退出码 `2` 退出时，工具调用被跳过，UI 收到 `hook_blocked` 事件
- [ ] `before_tool_call` Hook 以退出码 `1` 退出时，工具调用**正常继续**，UI 收到 `hook_completed`（exitCode=1）
- [ ] `before_user_message` Hook 以退出码 `2` 退出时，消息不发送给 LLM，UI 收到 `hook_blocked` 事件
- [ ] `before_spawn_subagent` Hook 以退出码 `2` 退出时，对应子 Agent 不被派生，UI 收到 `hook_blocked` 事件
- [ ] Hook 超时（超过 `timeout` 配置值）时，子进程被终止，UI 收到 `hook_completed`（exitCode=null），后续动作不阻止
- [ ] Hook 执行期间，Agent 不会因 Hook 内部再次触发新的 Hook（无限循环保护生效）
- [ ] `command` 字段不匹配白名单 `^[a-zA-Z0-9._/~-]+$` 时，启动时输出警告并跳过该 Hook
- [ ] `args` 元素包含 `\0` 空字节时，启动时输出警告并跳过该 Hook
- [ ] 所有注入环境变量均正确传入子进程（可通过 `env` 命令验证）
- [ ] 子进程不继承父进程含 `_API_KEY`、`_SECRET`、`_TOKEN` 后缀的环境变量
- [ ] `hook_completed.payload.stdout` 中的已知 API Key 格式被替换为 `[REDACTED]`
- [ ] 单个触发点超过 10 个 Hook 时，启动时输出警告，仅执行前 10 个
- [ ] `hook_started` / `hook_completed` / `hook_blocked` 三个 AgentEvent 类型通过 TypeScript 类型检查
- [ ] UI **必须**在收到 `hook_blocked` 事件后展示"[Hook 拦截] 操作被 {hookName} 阻止"的系统提示
- [ ] `bunx tsc --noEmit` 通过

---

## 验证方式

1. **基础执行验证：** 配置 `on_session_start` Hook 执行 `echo "hook ok"`，启动 paw，确认 UI 收到 `hook_started` 和 `hook_completed` 事件，stdout 为 `"hook ok\n"`。

2. **阻止验证：** 配置 `before_tool_call` Hook 执行 `exit 2`，触发工具调用，确认工具未执行，UI 显示 `hook_blocked` 事件。

3. **超时验证：** 配置 `timeout: 1000` 的 Hook 执行 `sleep 10`，确认 1s 后 Hook 被终止，`hook_completed.payload.exitCode === null`，工具调用正常继续。

4. **环境变量验证：** 配置 `before_tool_call` Hook 执行 `printenv | grep PAW_`，确认 `PAW_TOOL_NAME` 等变量被正确注入，通过 `hook_completed.stdout` 验证。

5. **类型检查：** `bunx tsc --noEmit` 通过。

---

## 回滚策略

Hook 系统完全通过依赖注入方式集成到 Agent 编排器：Agent 编排器在调用 `HookExecutor.run()` 前检查 Hook 列表是否为空；若 `settings.json` 中无 `hooks` 字段，`HookExecutor` 直接返回空数组，不影响任何现有流程。

回滚步骤：
1. 移除 `src/agent/hooks/` 目录
2. 移除 `AgentEvent` 中 `hook_started` / `hook_completed` / `hook_blocked` 三个类型
3. 移除 Agent 编排器中对 `HookExecutor.run()` 的调用点

无需修改 UI 层（UI 对未知 AgentEvent 类型做忽略处理）；无需修改 provider 层；不影响现有 `settings.json` 中的 `providers` 配置（`hooks` 字段缺失时配置仍有效）。
