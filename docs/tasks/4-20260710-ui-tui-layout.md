# Task: TUI 整体布局与交互设计

| 字段 | 值 |
|------|-----|
| 关联 Spec | docs/specs/4-20260710-ui-tui-layout.md |
| 状态 | pending |

---

## 任务清单

### T1 — 重构 App.tsx 顶层布局与焦点状态机

**文件：** `src/App.tsx`

重构 `App.tsx` 作为整个 TUI 的顶层容器，完成以下工作：

- 建立四区域布局结构：外层使用 `flexDirection: "row"`，左侧为 `Sidebar`（固定宽 24 列，`flexShrink: 0`），右侧为垂直 `flexDirection: "column"` 容器，右侧内部从上到下依次是 `MessageArea`（`flexGrow: 1`）、`SubagentProgressArea`（`maxHeight: 6`，无活跃 Subagent 时不渲染）、`InputArea`（`minHeight: 3`，`maxHeight: 10`）
- 所有区域均使用 `borderStyle: "rounded"`
- 定义 `FocusArea` 类型：`"input" | "messages" | "overlay"`
- 维护 `focusedArea: FocusArea` 顶层状态，初始值为 `"input"`；边框颜色随焦点状态变化（焦点区域使用 `accent` 色，非焦点区域使用 `panel` 灰色，overlay 激活时底层所有区域均变为 `panel` dim 灰色）
- 实现焦点转换规则：
  - `input` 区：`Tab` → 转移至 `messages`；`p` → 打开 `overlay`；`s` → 打开 session overlay；`Shift+P` → 打开 Persona overlay；`Esc` / `Ctrl+C` → 上下文感知处理（见 T9）
  - `messages` 区：`Esc` / `Tab` → 返回 `input`；`p` / `s` / `Shift+P` → 打开对应 overlay
  - `overlay` 区：`Esc` / `Enter` → 关闭 overlay，焦点返回触发前区域
- `focusedArea === "overlay"` 时，`App` 拦截所有键盘事件，不透传至底层区域
- 维护 `overlayType: "provider" | "session" | "persona" | null` 状态，控制打开哪个 overlay

**预期结果：** `bun run dev` 启动后四区域正常渲染，`Tab` 键可在 `InputArea` 和 `MessageArea` 之间切换焦点，边框颜色随焦点正确变化。

---

### T2 — 实现 Sidebar 组件

**文件：** `src/components/Sidebar.tsx`

实现左侧边栏组件，展示应用信息和快捷键提示：

- 顶部展示应用名称 `PAW`
- 中部展示快捷键说明：`p` 切换 provider、`s` 管理 session、`Shift+P` 切换 Persona、`Tab` 切换焦点
- 底部展示当前 provider 和 model 信息（消费 `provider_changed` 事件后由父组件传入 props），以及当前 session 标题和 persona 名称（如有）
- 实现截断规则（可用内容宽度约 22 字符，超出部分用 `…` 代替）：
  - `provider.label`：最多 18 字符
  - `model`：最多 20 字符
  - `persona.name`：最多 18 字符
  - `session.title`：最多 20 字符
- 接受以下 props：`providerLabel: string`、`model: string`、`sessionTitle?: string`、`personaName?: string`

**预期结果：** 底部 provider 信息在切换 provider 后正确更新；超长文本均被截断显示，不导致布局溢出。

---

### T3 — 实现 MessageArea 及子组件

**文件：** `src/components/MessageArea.tsx`、`src/components/MessageItem.tsx`、`src/components/MessageHeader.tsx`、`src/components/MessageBody.tsx`、`src/components/CodeBlock.tsx`、`src/components/StreamCursor.tsx`

**MessageArea.tsx：**

- 维护滚动状态：`scrollOffset: number`（0 = 顶部）、`autoScroll: boolean`（初始 `true`）、`totalLines: number`、`visibleLines: number`
- `autoScroll === true` 时，每次消息列表更新后自动将 `scrollOffset` 设为 `max(0, totalLines - visibleLines)`，锚定底部
- 用户手动向上滚动（`↑` / `PgUp`）时，置 `autoScroll = false`
- `scrollOffset` 到达底部时，自动恢复 `autoScroll = true`
- `autoScroll === false` 时，右下角显示 `↓ 新消息` 提示（`fg: accent`）
- 滚动步长：`↑` / `↓` 为 1 行；`PgUp` / `PgDn` 为 `visibleLines - 1` 行

**MessageItem.tsx：** 接受 `message: ChatMessage`、`isLast: boolean`，组合 `MessageHeader` + `MessageBody`

**MessageHeader.tsx：** 展示 `role` 标签（如 `[assistant]`、`[user]`、`[system]`）和格式化时间戳

**MessageBody.tsx：** 接受 `text: string`（已完成时）或 `streamingText?: string`（流式进行时）、`isStreaming: boolean`；实现 Markdown 降级渲染：
- `# 标题` → 全大写 + 前缀 `▌` + 下方空行
- `` `行内代码` `` → 前后加空格，`fg: accent`
- ` ```代码块``` ` → 使用 `CodeBlock` 组件
- `- 列表项` → 前缀替换为 `•`
- `> 引用` → 前缀加 `│`，`fg: panel`
- 使用 `marked` 将 Markdown token 化，映射到对应的 `<text>` 或 `<box>` 原语
- 流式进行时在文本末尾渲染 `StreamCursor`

**CodeBlock.tsx：** 接受 `code: string`、`lang?: string`；使用 `borderStyle: "single"`，`fg: accent`；顶部展示语言标签（若有）

**StreamCursor.tsx：** 接受 `visible: boolean`；内部通过 `setInterval`（250ms）切换光标 `█` 的可见性，实现闪烁效果；`visible = false` 时不渲染

**预期结果：** 消息列表正确渲染各消息角色；代码块有独立边框；流式进行时光标闪烁，`stream_done` 后光标消失；手动滚动后 `↓ 新消息` 提示出现，滚动至底部后消失。

---

### T4 — 实现 InputArea 组件

**文件：** `src/components/InputArea.tsx`

实现多行文本输入框组件：

- 维护以下 state：`value: string`（当前输入内容）、`cursorRow: number`、`cursorCol: number`、`historyIndex: number | null`（`null` 表示未浏览历史）
- 维护独立的 `inputHistory: string[]`，最多保留最近 100 条已提交的非空输入
- 支持 `Shift+Enter` 换行（多行输入）
- `Enter` 提交：若 `value.trim()` 不为空，则追加到 `inputHistory`（超出 100 条移除最旧条目），调用 `AgentRunner.send(text)`（直接方法调用，不经过 AgentEvent），同时在消息列表乐观追加 `role: "user"` 消息，清空 `value`，重置 `historyIndex = null`
- `↑` 键：当前输入为空时触发历史导航（`historyIndex` 减一，填入对应历史内容）；当前输入不为空时优先移动光标行
- `↓` 键：同上，`historyIndex` 加一；到达底部时恢复提交前暂存内容，`historyIndex` 重置为 `null`
- 输入区高度随内容行数自动扩展，最多 `maxHeight: 10`（含边框），超过后内容可内部滚动
- 接受 `onSubmit: (text: string) => void`、`isStreaming: boolean` 等 props

**预期结果：** `Shift+Enter` 可正常换行；`Enter` 提交后消息出现在消息列表；`↑` / `↓` 在空输入框时可正常浏览历史；历史上限 100 条正确维护。

---

### T5 — 实现通用 Overlay 容器及 ProviderPicker

**文件：** `src/components/overlay/Overlay.tsx`、`src/components/overlay/ProviderPicker.tsx`

**Overlay.tsx（通用浮层容器）：**

- 渲染于所有底层区域之上，视觉上水平 + 垂直居中
- 接受 props：`visible: boolean`、`title: string`、`width?: number`（默认 40）、`maxHeight?: number`（默认 20）、`onClose: () => void`、`children: ReactNode`
- 自身处理 `Esc` 键调用 `onClose`，不在容器内耦合具体业务逻辑
- `visible === false` 时不渲染（返回 `null`）

**ProviderPicker.tsx：**

- 是 `Overlay` 的第一个具体实现
- 接受 props：`providers: ProviderConfig[]`、`activeProviderId: string`、`onSelect: (id: string) => void`、`onClose: () => void`
- 维护 `selectedIndex: number` state（初始高亮当前活跃 provider 所在位置）
- `↑` / `↓` 移动 `selectedIndex`，循环（到顶按 `↑` 跳到底部，反之亦然）
- `Enter` 调用 `onSelect(providers[selectedIndex].id)`，外层负责关闭 overlay 并发送 `provider_changed` AgentEvent
- `Esc` 调用 `onClose`，不发送事件
- 每项展示 `provider.label` 和 `model`，当前高亮项前缀 `▶`，其余项前缀空格对齐

**预期结果：** `p` 键打开 ProviderPicker，`↑` / `↓` 可移动高亮，`Enter` 切换 provider 后 Sidebar 底部信息更新，`Esc` 取消不触发任何 provider 变更。

---

### T6 — 实现 SessionPicker 和 PersonaPicker

**文件：** `src/components/overlay/SessionPicker.tsx`、`src/components/overlay/PersonaPicker.tsx`

**SessionPicker.tsx：**

- 复用 `Overlay` 容器，展示 session 列表（从 `SessionManager.listSessions()` 获取）
- 支持方向键 `↑` / `↓` 选择 session，当前高亮项前缀 `▶`
- `Enter`：切换至选中 session（调用 `SessionManager.switchSession()`，若有 streaming 先 abort）
- `d` 键：删除当前高亮的 session（移入 trash），不可删除当前活跃 session
- `n` 键：新建 session（调用 `SessionManager.createSession()`），创建后自动切换至新 session
- `Esc`：关闭 overlay，不操作 session
- 接受 props：`sessions: SessionMeta[]`、`activeSessionId: string`、`onSwitch: (id: string) => void`、`onDelete: (id: string) => void`、`onCreate: () => void`、`onClose: () => void`

**PersonaPicker.tsx：**

- 复用 `Overlay` 容器，展示可用 persona 列表
- `↑` / `↓` 移动选择，`Enter` 确认切换，`Esc` 取消
- 接受 props：`personas: PersonaConfig[]`（类型由 Spec 6 定义，此处仅需预留接口）、`activePersonaId?: string`、`onSelect: (id: string) => void`、`onClose: () => void`
- 若 persona 功能尚未完整实现（Spec 6 未完成），组件可渲染占位提示"Persona 功能即将上线"，不影响 overlay 打开/关闭逻辑

**预期结果：** `s` 键打开 SessionPicker，可正常切换/新建/删除 session；`Shift+P` 打开 PersonaPicker；两个 overlay 均可用 `Esc` 关闭；关闭后焦点返回触发前区域。

---

### T7 — 实现 SubagentProgressArea 组件

**文件：** `src/components/SubagentProgressArea.tsx`

实现 Subagent 进度展示区域：

- 无活跃 Subagent 时，组件不渲染（返回 `null`），不占用布局高度
- 有活跃 Subagent 时，渲染高度最多 `maxHeight: 6` 的状态行列表
- 每行以简洁状态行形式展示 Subagent 进度，格式参考：
  - 进行中：`⟳ <subagentName>: <当前状态描述>`
  - 已完成：`✓ <subagentName>: <摘要>（完成）`
  - 失败：`✗ <subagentName>: <错误摘要>`
- 所有 Subagent 完成后，保留 2 秒摘要展示再自动隐藏（通过 `setTimeout` 控制）
- 接受 props：`subagents: SubagentStatus[]`（`SubagentStatus` 包含 `name`、`status`、`description`），由父组件基于 AgentEvent 维护并传入

**预期结果：** 无活跃 Subagent 时布局中不出现该区域，不占高度；有活跃 Subagent 时展示状态行；所有完成后 2 秒消失。

---

### T8 — 在 App.tsx 中补全 AgentEvent 消费规则

**文件：** `src/App.tsx`（在 T1 基础上补充事件消费逻辑）

在 App 顶层添加 AgentEvent 事件监听，将各事件路由到对应的 UI 更新：

**Spec 1 事件（已有，确认接入）：**

- `stream_chunk`：将 `delta` 追加至对应消息的 `streamingText` 字段，触发局部重渲染
- `stream_done`：将 `streamingText` 合并写入 `text`，置 `isStreaming: false`，光标消失；`stopReason === "tool_use"` 时不显示完成标记
- `stream_error`：在消息列表追加 `role: "error"` 红色消息
- `provider_changed`：更新传给 `Sidebar` 的 `providerLabel` 和 `model` state

**Spec 5 工具调用事件：**

- `tool_call_start`：在消息区插入浅蓝色系统提示条目："[工具] 正在执行: {toolName}"（以 `toolCallId` 作为条目 key，便于后续更新）
- `tool_call_result`：将对应 `toolCallId` 的系统提示更新为："[工具] {toolName} 完成（{durationMs}ms）"
- `tool_error`：插入红色系统提示："[工具错误] {toolName}: {message}"
- `tool_confirm_required`：打开 `ToolConfirmOverlay`（`Enter` 确认，`Esc` 取消；`approved=false` 时调用 `AgentRunner.confirmToolCall(toolCallId, false)`，`approved=true` 时同理）；`ToolConfirmOverlay` 与 `Overlay` 通用容器保持一致的确认/取消规范（Enter 确认，Esc 取消，不使用 y/n 按键）
- `max_tool_turns_reached`：插入黄色系统提示："[达到最大工具调用轮次，对话已停止]"

**Spec 3 / Spec 7 事件：**

- `context_trimmed`：在消息区插入浅灰色系统提示："[历史已裁剪，保留最近 N 轮对话]"，N 取自 `payload.sentCount`
- `hook_started`：插入浅色系统提示："[Hook] 正在执行: {hookName}"
- `hook_completed`：仅 `exitCode !== 0` 或超时时，插入黄色系统提示："[Hook] {hookName} 执行失败（exitCode: {exitCode}）"
- `hook_blocked`：**必须**以红色系统提示展示："[Hook 拦截] {action} 被 {hookName} 阻止"，优先级与 `stream_error` 相同，不可作为可选项

**预期结果：** 各 AgentEvent 均产生对应的 UI 变化；工具调用过程可在消息区观察到状态更新；`hook_blocked` 红色提示必须展示。

---

### T9 — 补全全局快捷键绑定

**文件：** `src/App.tsx`（在 T1/T8 基础上补全快捷键逻辑）

在顶层添加全局键盘事件处理，实现上下文感知的快捷键行为：

**`Esc` 上下文感知：**
- 若当前有 streaming 进行中 → 调用 `AgentRunner.abort()`
- 若有 overlay 打开 → 关闭 overlay，焦点返回触发前区域
- 否则，`focusedArea === "input"` → 清空 `InputArea` 的 `value`；`focusedArea === "messages"` → 转移焦点至 `input`

**`Ctrl+C` 上下文感知：**
- 若当前有 streaming 进行中 → 调用 `AgentRunner.abort()`
- 否则 → 强制退出（`exitOnCtrlC: true` 处理）

**其他快捷键（在对应 `focusedArea` 下生效）：**
- `p`（`input` / `messages` 区）→ 打开 `ProviderPicker` overlay，`focusedArea` 改为 `"overlay"`
- `s`（`input` / `messages` 区）→ 打开 `SessionPicker` overlay，`focusedArea` 改为 `"overlay"`
- `Shift+P`（`input` / `messages` 区）→ 打开 `PersonaPicker` overlay，`focusedArea` 改为 `"overlay"`
- `Tab`（`input` 区）→ 转移焦点至 `messages`；（`messages` 区）→ 转移焦点至 `input`
- `Enter`（`input` 区）→ 触发输入提交（由 `InputArea` 内部处理）；（`overlay` 区）→ 确认选择
- `↑` / `↓`：`input` 区且输入为空时，触发历史导航（由 `InputArea` 处理）；`messages` 区时，滚动消息（由 `MessageArea` 处理）；`overlay` 区时，移动列表选中项
- `PgUp` / `PgDn`（`messages` 区）→ 翻页滚动
- `Ctrl+L`（`input` 区）→ 清空当前消息列表（预留实现，本阶段硬编码，配置化后续完成）

可配置快捷键（`p`、`s`、`Shift+P`、`Ctrl+L`）本阶段均为硬编码默认值，在 `settings.json` 的 `keybindings` 字段预留配置入口但不实现配置化读取。

**预期结果：** 所有快捷键按 Spec 描述的上下文感知逻辑正确生效；streaming 进行中 `Esc` 和 `Ctrl+C` 均可中止流；overlay 打开时底层不响应按键；`bunx tsc --noEmit` 通过。

---

## 执行顺序

```
T1 → T2 / T3 / T4 / T5（可并行）→ T6 / T7（可并行）→ T8 → T9
```

T1 建立布局骨架和焦点状态机，是所有后续组件接入的基础。T2–T5 依赖 T1 的布局结构和 props 接口，可并行实现。T6 依赖 T5 的 `Overlay` 容器，T7 独立实现可与 T6 并行。T8 需要所有组件就位才能接入完整事件消费逻辑。T9 在 T8 基础上补全全局快捷键，收尾整体交互。

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
| T8 | pending | — |
| T9 | pending | — |
