# Spec 4：TUI 整体布局与交互设计

| 字段 | 值 |
|------|-----|
| 状态 | approved |
| 日期 | 2026-07-10 |
| 修订日期 | 2026-07-10（review 修复）|
| 风险级别 | 中 |

**风险级别说明：** 本 Spec 涉及修改 App.tsx 入口布局与焦点管理逻辑，属于"中"风险。不更换渲染框架，不修改 Agent-UI 通信协议基础架构，无外部服务鉴权，因此不升至"高"。

---

## 背景 / 目标 / 范围

### 背景

当前 `src/App.tsx` 仅有左侧 24 列固定宽度边栏和右侧消息列表占位。缺少：
- 消息输入框
- 消息区滚动（自动 + 手动）
- 流式 token 渲染
- Markdown / 代码块展示
- provider 切换浮层（Overlay）
- 全局快捷键体系
- 焦点管理机制

Spec 1（多 Provider 配置）已定义 `provider_changed` 事件及左侧边栏底部 provider 显示需求，本 Spec 是其 UI 侧的具体落地。

### 目标

1. 定义完整的 TUI 布局分区及尺寸规则
2. 设计清晰的焦点管理机制（各区域如何获得/释放焦点）
3. 建立全局快捷键体系（键位 + 可配置说明）
4. 定义消息渲染规则（Markdown / 代码块 / 流式逐字渲染）
5. 设计输入框组件（多行 + 历史记录）
6. 设计可复用 Overlay 组件（首个用例：provider 切换）
7. 定义消息区自动滚动与手动滚动策略

### 包含

- 完整布局 ASCII 示意图及各区域 `width` / `height` / `flex` 规则
- 焦点状态机（`FocusArea` 枚举 + 转换规则）
- 全局快捷键表（包含是否可配置说明）
- 消息渲染组件树及 Markdown 降级策略
- `InputBox` 组件设计（props / state / 历史记录上限）
- `Overlay` 通用组件设计（`ProviderPicker` 作为首个实现）
- 消息区滚动策略（`autoScroll` flag + 锚定逻辑）
- 新增 `AgentEvent` 类型说明

### 不包含

- 具体实现代码（TypeScript 源文件）
- Agent 编排逻辑（LLM 请求/响应处理，见 Spec 1）
- 配置持久化（快捷键自定义的存储，后续独立 Spec）
- 多会话/Tab 管理
- 鼠标交互支持

---

## 技术方案

### 1. 整体布局

终端窗口按如下分区划分：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ┌────────────┐ ┌──────────────────────────────────────────────────────┐  │
│ │  Sidebar   │ │                   MessageArea                        │  │
│ │            │ │                                                      │  │
│ │  PAW       │ │  [assistant] 你好，有什么可以帮助你的？              │  │
│ │            │ │                                                      │  │
│ │  快捷键：  │ │  [user] 帮我写一个快速排序                           │  │
│ │  p 切换    │ │                                                      │  │
│ │  provider  │ │  [assistant] 好的，以下是快速排序的实现：            │  │
│ │            │ │  ┌──────────────────────────────────────────────┐   │  │
│ │            │ │  │ function quickSort(arr) {                    │   │  │
│ │            │ │  │   ...                                        │   │  │
│ │            │ │  │ }                                            │   │  │
│ │            │ │  └──────────────────────────────────────────────┘   │  │
│ │            │ ├──────────────────────────────────────────────────────┤  │
│ │            │ │         SubagentProgressArea（可选，最多 6 行）      │  │
│ │            │ │  ⟳ subagent-1: 分析需求...                          │  │
│ │            │ │  ✓ subagent-2: 生成代码（完成）                     │  │
│ │  ────────  │ ├──────────────────────────────────────────────────────┤  │
│ │  Claude    │ │                   InputArea                          │  │
│ │  sonnet-5  │ │  > █                                                 │  │
│ └────────────┘ └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

**尺寸规则：**

| 区域 | 宽度 | 高度 | 说明 |
|------|------|------|------|
| `Sidebar` | `width: 24`，`flexShrink: 0` | `height: 100%` | 固定列宽，不可拉伸 |
| 右侧容器 | `flexGrow: 1` | `height: 100%` | 占满剩余宽度 |
| `MessageArea` | `width: 100%` | `flexGrow: 1` | 占满剩余高度 |
| `SubagentProgressArea` | `width: 100%` | `maxHeight: 6` | **可选区域**；无活跃 Subagent 时不渲染；活跃时最多占 6 行，以简洁状态行展示各 Subagent 进度；所有 Subagent 完成后保留 2 秒摘要再消失 |
| `InputArea` | `width: 100%` | `minHeight: 3`，`maxHeight: 10` | 随内容自动扩展，最多 8 行可见 |

外层容器使用 `flexDirection: "row"`，右侧内容使用 `flexDirection: "column"`。所有区域均带 `borderStyle: "rounded"`，边框颜色随焦点状态变化（见第 2 节）。

---

### 2. 焦点管理

#### 2.1 FocusArea 枚举

```ts
// 逻辑定义（不含实现代码）
type FocusArea = "input" | "messages" | "overlay"
```

应用同一时刻只有一个 `FocusArea` 持有焦点。`App` 顶层维护 `focusedArea: FocusArea` 状态。

#### 2.2 边框颜色规则

| 状态 | 边框颜色 |
|------|------|
| 当前焦点区域 | `accent`（cyan） |
| 非焦点区域 | `panel`（gray） |
| Overlay 激活时，底层所有区域 | `panel`（dim，灰色） |

#### 2.3 焦点转换规则

```
初始状态：focusedArea = "input"

输入区 (input)
  ├─ Esc            → streaming 进行中：调用 AgentRunner.abort()；否则：清空输入缓冲，不转移焦点
  ├─ Ctrl+C         → streaming 进行中：调用 AgentRunner.abort()；否则：强制退出（exitOnCtrlC）
  ├─ Tab            → 转移至 messages 区（进入滚动浏览模式）
  └─ p              → 打开 overlay，焦点转移至 overlay

消息区 (messages)
  ├─ Esc / Tab      → 转移回 input
  ├─ ↑ / ↓ / PgUp / PgDn → 滚动消息区
  └─ p              → 打开 overlay，焦点转移至 overlay

Overlay (overlay)
  ├─ Esc            → 关闭 overlay，焦点返回触发前的区域
  ├─ Enter          → 确认选择，关闭 overlay，焦点返回触发前区域
  └─ ↑ / ↓          → 在列表项间移动
```

当 `focusedArea === "overlay"` 时，`App` 拦截所有键盘事件，不透传至底层区域。

---

### 3. 全局快捷键体系

| 快捷键 | 作用 | 生效区域 | 可配置 |
|--------|------|----------|--------|
| `Esc` | **上下文感知**：streaming 进行中 → 调用 `AgentRunner.abort()`；无 overlay 且非 streaming → 清空输入缓冲（input 区）或返回 input（messages 区）；有 overlay → 关闭 overlay | 全局 | 否 |
| `Ctrl+C` | **上下文感知**：streaming 进行中 → 调用 `AgentRunner.abort()`；否则 → 强制退出（由 `exitOnCtrlC: true` 处理） | 全局 | 否 |
| `p` | 打开 provider 选择 overlay（`ProviderPickerOverlay`） | input / messages | 是（后续 Spec） |
| `s` | 打开 session 管理浮层（`SessionPickerOverlay`），支持方向键选择、`Enter` 切换、`d` 删除、`n` 新建 | input / messages | 是（后续 Spec） |
| `Shift+P` | 打开 Persona 选择浮层，复用通用 `Overlay` 容器（与 Spec 6 快捷键保持同步，避免与 `p` 冲突） | input / messages | 是（后续 Spec） |
| `Tab` | 在 input ↔ messages 间切换焦点（**不打开任何浮层**） | input / messages | 否 |
| `Enter` | 提交输入（input 区）/ 确认 overlay 选项（overlay） | input / overlay | 否 |
| `↑` | 输入历史上一条（input 区）/ 滚动消息（messages 区）/ 列表上移（overlay） | 上下文相关 | 否 |
| `↓` | 输入历史下一条（input 区）/ 滚动消息（messages 区）/ 列表下移（overlay） | 上下文相关 | 否 |
| `PgUp` | 消息区向上翻页 | messages | 否 |
| `PgDn` | 消息区向下翻页 | messages | 否 |
| `Ctrl+L` | 清空当前对话消息列表 | input | 是（后续 Spec） |
| `Shift+Enter` | 输入框换行（多行输入） | input | 否 |

> **Esc 行为依上下文：streaming 进行中 → abort；否则 → 清空输入（input 区）/ 返回 input（messages 区）**

**可配置说明：** 标记"是"的快捷键预留 `settings.json` 的 `keybindings` 字段配置，但本 Spec 阶段实现为硬编码默认值，配置化能力在独立 Spec 中实现。

---

### 4. 消息渲染

#### 4.1 消息数据结构

```ts
// 消息类型定义（逻辑层）
type MessageRole = "user" | "assistant" | "system" | "error"

type ChatMessage = {
  id: string
  role: MessageRole
  text: string          // 完整文本（流式完成后的最终内容）
  streamingText?: string  // 流式进行中的增量文本缓冲，完成后清空
  isStreaming: boolean
  createdAt: number     // Date.now() 时间戳
}
```

#### 4.2 消息渲染组件树

```
MessageArea
└── ScrollableBox（包装滚动逻辑）
    └── 列表循环渲染
        └── MessageItem (per message)
            ├── MessageHeader   [role 标签 + 时间戳]
            └── MessageBody
                ├── PlainText   [普通段落]
                ├── CodeBlock   [代码块，带语言标签]
                └── StreamCursor [流式进行时显示的光标 █]
```

**组件 props 概览：**

| 组件 | 关键 props |
|------|------------|
| `MessageItem` | `message: ChatMessage`，`isLast: boolean` |
| `MessageHeader` | `role: MessageRole`，`timestamp: number` |
| `MessageBody` | `text: string`，`isStreaming: boolean` |
| `CodeBlock` | `code: string`，`lang?: string` |
| `StreamCursor` | `visible: boolean`（250ms 闪烁） |

#### 4.3 Markdown 渲染策略

@opentui/react 渲染到终端，不支持 HTML/CSS 富文本。Markdown 采用**降级渲染**方案：

| Markdown 元素 | 终端渲染方式 |
|---------------|-------------|
| `# 标题` | 全大写文本 + 下方空行，前缀 `▌` |
| `**粗体**` | 保留 `**` 标记（终端无粗体样式支持时降级为文本） |
| `` `行内代码` `` | 前后各加空格，fg 颜色 `accent` |
| ` ```代码块``` ` | `CodeBlock` 组件，`borderStyle: "single"`，fg 颜色 `accent` |
| `- 列表项` | 前缀替换为 `•` |
| `> 引用` | 前缀加 `│`，fg 颜色 `panel` |
| 普通段落 | 原样渲染，自动换行（由 `@opentui/react` 的 `<text>` 处理 `wrap` 属性） |

解析时使用 `marked`（已在 `node_modules` 中）将 Markdown token 化，再按上表映射到对应 `<text>` 或 `<box>` 原语，不直接输出 HTML。

#### 4.4 流式 token 渲染

- 收到 `stream_chunk` 事件时，将 `delta` 追加至对应消息的 `streamingText` 字段
- 消息组件读取 `streamingText`（流式进行中）或 `text`（已完成）进行渲染
- 流式进行中，`StreamCursor` 组件在文本末尾闪烁（`setInterval` 250ms 切换可见性）
- 收到 `stream_done` 时，将 `streamingText` 合并写入 `text`，`isStreaming` 置 `false`，光标消失
- 每次 `stream_chunk` 触发 React state 更新，`MessageArea` 局部重渲染

---

### 5. InputArea 组件设计

#### 5.1 功能需求

- 支持多行文本输入（`Shift+Enter` 换行）
- 支持 `Enter` 提交（不换行）
- 方向键 `↑` / `↓` 在输入历史间导航（输入框为空时触发）
- 按住 `↑` / `↓` 且当前输入不为空时，移动光标行（优先光标移动）
- 输入区高度随内容行数自动扩展，上限 `maxHeight: 10`（含边框共 10 行）

#### 5.2 state 定义（逻辑层）

| 字段 | 类型 | 说明 |
|------|------|------|
| `value` | `string` | 当前输入内容 |
| `cursorRow` | `number` | 光标所在行（0 起） |
| `cursorCol` | `number` | 光标所在列（0 起） |
| `historyIndex` | `number \| null` | 当前浏览的历史记录索引，`null` 表示未浏览历史 |

#### 5.3 历史记录规则

- 维护独立的 `inputHistory: string[]` 数组，存储所有已提交的非空输入
- 上限：最多保留最近 100 条历史
- `↑` 键：`historyIndex` 减一（向更旧的历史移动），将历史内容填入 `value`
- `↓` 键：`historyIndex` 加一，到达底部（最新历史之后）时恢复 `value` 为提交前暂存内容
- 提交后 `historyIndex` 重置为 `null`

#### 5.4 提交行为

1. `Enter` 按下时，若 `value.trim()` 不为空：
   - 追加到 `inputHistory`（超出 100 条时移除最旧一条）
   - 直接调用 `AgentRunner.send(text)`（不通过 AgentEvent 传递，UI 层直接调用 Agent 层方法）
   - 清空 `value`，重置 `historyIndex`
2. 同时在消息列表追加 `role: "user"` 消息（乐观 UI 更新）

---

### 6. Overlay 组件设计

#### 6.1 通用 Overlay 容器

Overlay 是**浮层**，渲染于所有底层区域之上，视觉上居中对齐（水平 + 垂直）。

**通用 props：**

| prop | 类型 | 说明 |
|------|------|------|
| `visible` | `boolean` | 控制显示/隐藏 |
| `title` | `string` | 顶部标题文字 |
| `width` | `number` | 固定宽度（列数），默认 `40` |
| `maxHeight` | `number` | 最大高度（行数），默认 `20` |
| `onClose` | `() => void` | `Esc` 触发的关闭回调 |
| `children` | `ReactNode` | 内容区域 |

Overlay 容器自身处理 `Esc` 键并调用 `onClose`，内容区域由各子实现自行处理键盘事件。

布局示意：

```
┌──────────────────────────────────────────────────────────────────────────┐
│           ┌──────────────────────────────────────┐                       │
│           │  选择 Provider                        │                       │
│           │  ────────────────────────────────── │                       │
│           │  ▶ Anthropic     claude-sonnet-5     │                       │
│           │    OpenAI        gpt-4o              │                       │
│           │    Ollama        llama3              │                       │
│           │    DeepSeek      deepseek-chat       │                       │
│           │                                      │                       │
│           │  [Enter 确认]  [Esc 取消]            │                       │
│           └──────────────────────────────────────┘                       │
└──────────────────────────────────────────────────────────────────────────┘
```

#### 6.2 ProviderPicker 实现

`ProviderPicker` 是 `Overlay` 的第一个实现，用于 provider 选择。

**props：**

| prop | 类型 | 说明 |
|------|------|------|
| `providers` | `ProviderConfig[]` | 来自 `settings.json` 的 provider 列表 |
| `activeProviderId` | `string` | 当前已激活的 provider id |
| `onSelect` | `(id: string) => void` | 用户确认选择时回调 |
| `onClose` | `() => void` | 取消时回调 |

**state：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `selectedIndex` | `number` | 当前高亮的列表项索引 |

**交互流程：**
1. `↑` / `↓` 移动 `selectedIndex`，循环（到顶继续按 `↑` 跳到底部）
2. `Enter` 调用 `onSelect(providers[selectedIndex].id)`，外层关闭 overlay 并发送 `provider_changed` AgentEvent
3. `Esc` 调用 `onClose`，不发送事件

#### 6.3 复用设计约定

后续需要 overlay 的功能（如模型选择、工具确认对话框、session 管理、Persona 选择、快捷键帮助）均复用 `Overlay` 容器组件，只替换 `children` 内容。不得在 `Overlay` 容器内耦合具体业务逻辑。

**所有确认类弹窗统一交互规范：**
- `Enter`：确认（approved=true）
- `Esc`：取消（approved=false 结算，不发送任何事件）

工具确认弹窗（`ToolConfirmOverlay`）遵循此规范，**不使用 y/n 按键**，与通用 Overlay 规范保持一致。

---

### 7. 消息区滚动

#### 7.1 滚动状态

`MessageArea` 维护以下 state：

| 字段 | 类型 | 说明 |
|------|------|------|
| `scrollOffset` | `number` | 当前滚动偏移行数（0 = 顶部） |
| `autoScroll` | `boolean` | 是否处于自动滚动模式（初始 `true`） |
| `totalLines` | `number` | 消息区内容总行数（渲染后计算） |
| `visibleLines` | `number` | 消息区可见行数（由布局高度决定） |

#### 7.2 自动滚动规则

- `autoScroll === true` 时，每次消息列表更新（新消息 / `stream_chunk`）自动将 `scrollOffset` 设为 `max(0, totalLines - visibleLines)`（始终锚定到底部）
- 用户手动向上滚动（`↑` / `PgUp`）时，将 `autoScroll` 置 `false`，停止自动滚动
- 当用户滚动到底部（`scrollOffset >= totalLines - visibleLines`）时，将 `autoScroll` 自动恢复为 `true`

#### 7.3 滚动步长

| 操作 | 步长 |
|------|------|
| `↑` / `↓` | 1 行 |
| `PgUp` / `PgDn` | `visibleLines - 1` 行（保留 1 行上下文） |

#### 7.4 滚动状态指示

当 `autoScroll === false` 时，`MessageArea` 右下角显示 `↓ 新消息` 提示文字（`fg: accent`），提醒用户有新内容到达。点击或按任意方向键到底部时消失。

---

### 8. AgentEvent 消费规则

本 Spec 不新增 UI→Agent 方向的 AgentEvent。用户输入提交通过直接调用 `AgentRunner.send(text)` 实现，不经过 AgentEvent 协议。

> **注意：AgentEvent 仅从 Agent 层流向 UI 层（单向），UI 层对 Agent 层的写入操作仅限 `send()` / `abort()` / `switchProvider()` 等方法调用。**

以下事件由 Spec 1 已定义，本 Spec 消费：

| type | payload | 消费方式 |
|------|---------|----------|
| `stream_chunk` | `{ delta: string }` | 追加至对应消息的 `streamingText` |
| `stream_done` | `{ totalText: string; stopReason: "stop" \| "tool_use" }` | 合并 `streamingText` 至 `text`，`isStreaming: false`；`stopReason === "stop"` 时光标消失并显示完成标记；`stopReason === "tool_use"` 时不显示完成标记，等待工具调用结果 |
| `stream_error` | `{ kind: LLMErrorKind; message: string }` | 追加 `role: "error"` 红色消息至消息列表 |
| `provider_changed` | `{ providerId: string; model: string }` | 更新 Sidebar 底部显示 |

以下事件由 Spec 5 定义（工具调用），本 Spec 消费并渲染：

| type | payload | 渲染方式 |
|------|---------|---------|
| `tool_call_start` | `{ toolCallId: string; toolName: string }` | 在消息区插入浅蓝色系统提示："[工具] 正在执行: {toolName}" |
| `tool_call_result` | `{ toolCallId: string; toolName: string; durationMs: number }` | 将对应的 `tool_call_start` 提示更新为："[工具] {toolName} 完成（{durationMs}ms）" |
| `tool_error` | `{ toolCallId: string; toolName: string; message: string }` | 显示红色系统提示："[工具错误] {toolName}: {message}" |
| `tool_confirm_required` | `{ toolCallId: string; toolName: string; args: unknown }` | 打开 `ToolConfirmOverlay`（`Enter` 确认 / `Esc` 取消，以 `approved=false` 结算），由 UI 调用 `AgentRunner.confirmToolCall(toolCallId, approved)` 回传结果 |
| `max_tool_turns_reached` | `{}` | 显示黄色系统提示："[达到最大工具调用轮次，对话已停止]" |

以下事件由 Spec 3、Spec 7 定义，本 Spec 消费并渲染：

| type | payload | 渲染方式 |
|------|---------|---------|
| `context_trimmed` | `{ trimmedCount: number; sentCount: number }` | 在消息区插入浅灰色系统提示："[历史已裁剪，保留最近 N 轮对话]"，其中 N 取自 `payload.sentCount` |
| `hook_started` | `{ hookName: string; trigger: string }` | 在消息区显示浅色系统提示："[Hook] 正在执行: {hookName}" |
| `hook_completed` | `{ hookName: string; exitCode: number; stdout?: string }` | 仅 `exitCode !== 0` 或超时时：显示黄色系统提示："[Hook] {hookName} 执行失败（exitCode: {exitCode}）" |
| `hook_blocked` | `{ hookName: string; action: string }` | **必须**以红色系统提示条目展示："[Hook 拦截] {action} 被 {hookName} 阻止"，不可作为可选项，与 `stream_error` 同等优先级处理 |

---

### 9. Sidebar 信息展示规范

#### 9.1 截断规则

Sidebar 固定宽度 24 列（实际可用内容宽度约 22 列），各信息项必须按以下规则截断，超出部分以 `…` 代替：

| 信息项 | 最大字符数 | 示例 |
|--------|-----------|------|
| `provider.label` | 18 字符 | `Anthropic Claude` → `Anthropic Claude` |
| `model` | 20 字符 | `claude-sonnet-5-202506…` |
| `persona.name` | 18 字符 | `Senior Engineer…` |
| `session.title` | 20 字符 | `帮我写一个快速排序算法…` |

**规范约定：** 后续 Spec 新增 Sidebar 展示内容时，**必须**同步更新本节，说明新增项的最大字符数和截断规则，以防止布局溢出。

#### 9.2 组件目录结构

```
src/
├── App.tsx                        # 顶层布局 + 焦点状态管理
├── main.ts                        # 入口，不变
└── components/
    ├── Sidebar.tsx                # 左侧边栏（快捷键提示 + provider 信息，含截断逻辑）
    ├── MessageArea.tsx            # 消息区（含滚动逻辑）
    │   ├── MessageItem.tsx        # 单条消息
    │   ├── MessageHeader.tsx      # 消息头（role + 时间戳）
    │   ├── MessageBody.tsx        # 消息体（Markdown 降级渲染）
    │   ├── CodeBlock.tsx          # 代码块
    │   └── StreamCursor.tsx       # 流式光标
    ├── SubagentProgressArea.tsx   # Subagent 进度区（可选，无活跃 Subagent 时不渲染）
    ├── InputArea.tsx              # 输入框（多行 + 历史记录）
    └── overlay/
        ├── Overlay.tsx            # 通用浮层容器
        ├── ProviderPicker.tsx     # Provider 选择实现
        ├── SessionPicker.tsx      # Session 管理实现（s 键触发）
        └── PersonaPicker.tsx      # Persona 选择实现（Shift+P 触发）
```

---

## 验收标准

- [ ] 终端宽度 >= 60 列时，左侧边栏宽 24 列、右侧自适应，布局无错位
- [ ] 终端宽度 < 60 列时，应用不崩溃（边栏可被压缩或隐藏，具体策略可后续调整）
- [ ] 初始焦点在 InputArea，InputArea 边框为 `accent` 色
- [ ] `Tab` 键在 InputArea ↔ MessageArea 之间正确切换焦点，边框颜色随之变化
- [ ] `p` 键打开 ProviderPicker overlay，overlay 期间底层区域边框变暗
- [ ] ProviderPicker overlay 内 `↑` / `↓` 正确移动高亮，`Enter` 确认并关闭，`Esc` 取消不发事件
- [ ] 选择 provider 后，Sidebar 底部正确显示新 `provider.label` 和 `model`
- [ ] InputArea 支持 `Shift+Enter` 换行，输入多行文本
- [ ] InputArea 高度随内容自动扩展，超过 8 行后不再扩展（出现内部滚动）
- [ ] `↑` / `↓`（InputArea 为空时）正确在输入历史中导航
- [ ] 历史记录最多保留 100 条，超出时自动移除最旧条目
- [ ] 提交后消息出现在消息列表，`autoScroll` 将视图滚动到底部
- [ ] 手动向上滚动后，`autoScroll` 禁用，右下角出现 `↓ 新消息` 提示
- [ ] 滚动至底部后，`autoScroll` 恢复，提示消失
- [ ] `stream_chunk` 事件触发逐字追加渲染，可观察到文字逐步出现
- [ ] `stream_done` 后流式光标消失，`streamingText` 合并至 `text`
- [ ] `stream_error` 在消息列表追加红色错误消息，不崩溃
- [ ] Markdown 代码块渲染为 `CodeBlock` 组件（有独立边框）
- [ ] `bunx tsc --noEmit` 通过
- [ ] `bun run dev` 启动无报错

---

## 验证方式

1. `bun run dev` 手动验证：
   - 逐一验证快捷键（`p`、`Tab`、`↑↓`、`Shift+Enter`、`Esc`）
   - 构造包含代码块的 mock 消息，确认渲染样式
   - 构造 50+ 条消息，验证滚动和 `autoScroll` 行为
   - 构造 streaming mock（`setInterval` 模拟 `stream_chunk`），验证逐字渲染和光标
2. `bunx tsc --noEmit` 类型检查通过
3. 调整终端窗口大小，验证布局在不同宽高下不崩溃

---

## 回滚策略

- 所有新增组件位于 `src/components/` 目录，`App.tsx` 的变更范围仅限于布局结构和焦点管理
- 回滚时，将 `src/App.tsx` 恢复至本 Spec 实现前版本，删除 `src/components/` 目录即可
- 本 Spec 不新增任何 AgentEvent 类型，回滚 UI 侧不影响已有 `stream_*` / `provider_changed` 等事件定义
- 回滚不影响 Spec 1 的 provider 配置逻辑（`src/agent/provider/` 目录完全独立）
