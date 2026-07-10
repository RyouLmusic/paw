# 用户体验与交互审查报告

## 问题列表

### [U-01] 中止 Streaming 的快捷键缺失

- **涉及 Spec**：Spec 2、Spec 4
- **问题描述**：Spec 2 的 `AgentRunner` 接口定义了 `abort()` 方法，用于中止正在进行的 streaming，并明确要求在 streaming 过程中用户可以调用此方法。然而 Spec 4 的全局快捷键表（第 3 节）中完全没有定义任何触发 `abort()` 的快捷键。`input` 区的 `Esc` 键明确定义为"清空输入缓冲"，`messages` 区的 `Esc` 定义为"转移回 input"，均与中止 streaming 无关。用户在 AI 回复过程中，没有任何已定义的快捷键可以中止输出。
- **建议**：在 Spec 4 全局快捷键表中新增中止 streaming 的快捷键（如 `Ctrl+X` 或 `Esc`——当 streaming 进行中时优先触发 abort，否则执行原有行为），并在 Spec 2 的验收标准中补充对应的 TUI 触发路径验证项。

---

### [U-02] Persona 切换快捷键游离于全局快捷键体系之外

- **涉及 Spec**：Spec 4、Spec 6
- **问题描述**：Spec 6 第 8 节描述 Persona 切换快捷键为"`Shift+S` 或待定"，状态不确定。而 Spec 4 第 3 节的全局快捷键表中完全未收录 Persona 切换快捷键。Spec 4 的 Sidebar 组件（第 9 节）也没有体现 Persona 快捷键提示。这导致用户无法从 TUI 中发现 Persona 切换入口，Sidebar 的快捷键提示区与实际可用快捷键集合不一致。此外，`Shift+S` 并未经过与其他快捷键的冲突验证。
- **建议**：Spec 6 确定 Persona 切换快捷键后，必须同步更新 Spec 4 第 3 节快捷键表（加入该条目）、第 9 节 `Sidebar.tsx` 组件设计（加入快捷键提示行），并说明 Persona 浮层如何复用 Spec 4 第 6 节的通用 `Overlay` 容器。

---

### [U-03] Session 切换无 TUI 入口

- **涉及 Spec**：Spec 3、Spec 4
- **问题描述**：Spec 3 定义了完整的多 session CRUD（`SessionManager.switchSession()`、`createSession()`、`deleteSession()`），并对应定义了 `session_switched` / `session_created` / `session_deleted` 三个 `AgentEvent` 类型。然而 Spec 4 明确写明"不包含多会话/Tab 管理"，全局快捷键表中无任何 session 切换快捷键，Overlay 浮层设计中也没有 session 选择的实现方案。用户没有任何 TUI 操作路径可以切换已有 session，多 session 能力实际上对用户不可见。
- **建议**：补充一个"会话管理"浮层（参照 Spec 4 的 `Overlay` 通用组件设计），定义 session 切换快捷键并加入 Spec 4 快捷键表。或在 Spec 4 中明确说明 session 操作通过 `/switch` 等斜杠命令入口实现，而非快捷键，并与 Spec 3 的入口设计保持一致。

---

### [U-04] 工具确认弹窗快捷键与 Overlay 规范不一致

- **涉及 Spec**：Spec 4、Spec 5
- **问题描述**：Spec 5 第 8.2 节明确要求工具确认流程由用户"按 `y/n` 响应"确认弹窗。Spec 4 第 6 节的通用 `Overlay` 组件规范定义确认使用 `Enter` 键、取消使用 `Esc` 键，全局快捷键表中从未出现 `y/n` 作为快捷键。两个 Spec 在同一个"确认弹窗"场景下定义了不同的按键交互，会导致用户困惑：`p` 打开的 Provider 浮层用 `Enter` 确认，但工具确认弹窗却要按 `y/n`。
- **建议**：统一确认弹窗的快捷键方案：要么将工具确认弹窗也改为 `Enter`/`Esc`（与 Spec 4 Overlay 规范一致），要么在 Spec 4 中为"危险操作确认"类 Overlay 定义单独的快捷键规范（`y/n`），并在快捷键表中标注"仅确认类弹窗"。

---

### [U-05] `ToolConfirmRequiredEvent.resolve` 回调违反 Agent-UI 通信原则

- **涉及 Spec**：Spec 2、Spec 5
- **问题描述**：Spec 5 第 6 节在 `ToolConfirmRequiredEvent` 的 payload 中嵌入了 `resolve: (approved: boolean) => void` 函数。这是一个双向通信机制，UI 层通过调用此函数将决策结果回传给 Agent 层。然而 Spec 2 第 8 节的设计约束明确规定："UI 层对 `AgentRunner` 的唯一写入操作为 `send()`、`abort()`、`switchProvider()`"，不允许 UI 直接绕过此接口与 Agent 内部交互。`resolve` 回调构成了第四种隐式写入通道，违反了解耦原则，且在事件序列化、持久化、单元测试等场景下函数类型的 payload 无法正常处理。
- **建议**：将确认结果的回传改为走已定义的 Agent 接口，例如在 `AgentRunner` 上扩展 `confirmToolCall(toolCallId: string, approved: boolean): void` 方法，从而遵守 Spec 2 的接口约束。`ToolConfirmRequiredEvent` 中只传递 `toolCallId`，不嵌入函数。

---

### [U-06] Hook 执行状态无明确 TUI 渲染路径，`hook_blocked` 可能静默

- **涉及 Spec**：Spec 4、Spec 7
- **问题描述**：Spec 7 第 4 节定义了三个 `AgentEvent`：`hook_started`、`hook_completed`、`hook_blocked`。Spec 7 给出了"UI 处理建议"，但明确标注为"非强制约束，留给 UI 实现层自行决定"。Spec 4 的消息渲染规则（第 4 节）和 `AgentEvent` 消费规则（第 8 节）中完全没有对 `hook_*` 类事件的处理说明，这些事件极有可能在 UI 层的 `switch` 语句中被忽略（走到 default 分支或直接无 default）。其中 `hook_blocked` 对应用户动作被拦截的强感知场景（如 shell_exec 被 hook 阻止），若静默不展示，用户不知道为何工具调用没有被执行。
- **建议**：Spec 4 第 8 节需补充 `hook_started`、`hook_completed`（失败/超时情况）、`hook_blocked` 三类事件的渲染路径。`hook_blocked` 至少应在消息列表中插入系统级提示条目（`role: "system"`），与 `stream_error` 类似的可见方式展示，不能作为可选项。

---

### [U-07] Memory 写入失败无对应 `AgentEvent`，`/remember` 确认提示可能误导用户

- **涉及 Spec**：Spec 8
- **问题描述**：Spec 8 第 6.1 节写明 `/remember` 命令执行后"立即写入 JSONL，触发 `memory_added` 事件"，TUI 显示确认提示"已记住：xxx"。但 `MemoryStore.add()` 是异步操作（第 4 节接口定义），在磁盘空间不足、文件权限错误、`maxTotalSizeKB` 超限触发清理失败等情况下可能抛出异常或返回错误。Spec 8 没有定义 memory 写入失败时的任何 `AgentEvent`（现有三个事件均为成功路径），也没有说明 `add()` 失败时 TUI 应显示什么。用户看到"已记住"但实际上没写成功，错误静默丢失。
- **建议**：新增 `memory_error` 事件类型（payload 含 `operation: "add" | "update" | "delete"`、`id?: string`、`reason: string`），在 `/remember` 失败时触发，TUI 应显示红色错误提示替代"已记住"确认消息。同时在 Spec 8 验收标准中增加写入失败场景的测试项。

---

### [U-08] `context_trimmed` 事件无 TUI 渲染路径，用户对历史截断无感知

- **涉及 Spec**：Spec 3、Spec 4
- **问题描述**：Spec 3 第 4 节定义了 `context_trimmed` 事件（payload: `{ sessionId, trimmedCount, sentCount }`），在 `trimmedCount > 0` 时发出，通知本次请求裁剪了若干历史消息。Spec 4 第 8 节列出了所有被消费的 `AgentEvent`，其中没有 `context_trimmed`。`stream_error` 被渲染为红色错误消息，`provider_changed` 更新状态栏，但 `context_trimmed` 完全没有对应渲染路径，不展示给用户。用户对话中若历史被裁剪，AI 会"遗忘"之前内容，但用户看不到任何提示，会将 AI 的遗忘误解为模型能力问题。
- **建议**：Spec 4 第 8 节补充 `context_trimmed` 事件的消费方式，建议在消息区插入一条浅灰色系统提示（如"[历史已裁剪，保留最近 N 轮]"），明确告知用户上下文已截断。

---

### [U-09] Subagent 进度树在 Spec 4 布局中无预留空间，空间估算存在冲突

- **涉及 Spec**：Spec 4、Spec 9
- **问题描述**：Spec 9 第 8 节描述进度树显示在"主聊天区域下方（或侧边栏）"，但这两处位置在 Spec 4 第 1 节均没有预留空间。Spec 4 布局为：MessageArea（`flexGrow: 1`）+ InputArea（`minHeight: 3, maxHeight: 10`），二者之间没有第三个区域。若进度树插入 MessageArea 与 InputArea 之间，则需要修改 Spec 4 的布局定义（这是一个 Spec 间的破坏性变更，但两个 Spec 未协调）。空间估算：进度树示意图（Spec 9 第 8 节）包含标题行 + N 条状态行 + 边框，3 个 Subagent 时至少占 6 行，叠加 InputArea 的 3-10 行，在 80 行以下的终端窗口中 MessageArea 的可用行数所剩无几。进度树展示完成后"折叠为一行摘要"后是否应彻底移除？未说明。
- **建议**：Spec 9 需要与 Spec 4 协调布局方案，明确进度树所在的布局区域（新增第四分区，或浮层 Overlay，或内联在 MessageArea 内），并在 Spec 4 中更新布局定义。同时说明进度树折叠后的消失时机（立即清除还是保留摘要行直到下次交互）。

---

### [U-10] Streaming 进行中切换 Session 的行为未定义，可能造成消息写入乱入

- **涉及 Spec**：Spec 2、Spec 3
- **问题描述**：Spec 2 第 4 节明确：在 stream 进行中再次调用 `send()`，会先 `abort()` 旧 stream 再处理新输入。但 Spec 3 的 `SessionManager.switchSession()` 是独立方法，不经过 `send()` 路径，两个 Spec 均未定义 streaming 进行中切换 session 时的行为。潜在问题：`switchSession()` 激活新 session 后，旧 stream 仍在运行，`stream_done` 触发时 `SessionManager.appendMessage()` 会将 assistant 消息追加到何处——是旧 session 还是新 session？若追加到新 session，该消息与新 session 上下文无关，造成"消息乱入"。
- **建议**：Spec 3 的 `switchSession()` 方法需补充前置语义：若当前有 streaming 进行中，应先调用 `AgentRunner.abort()` 再执行切换，或返回错误要求先停止当前 streaming。需在 Spec 2 或 Spec 3 的验收标准中增加此边界场景的测试项。

---

### [U-11] Spec 1 中 `Tab` 键定义与 Spec 4 相矛盾

- **涉及 Spec**：Spec 1、Spec 4
- **问题描述**：Spec 1 第 6 节写明 TUI 切换 provider 的快捷键为"如 `Tab` 或 `p`"。然而 Spec 4 第 3 节全局快捷键表明确规定 `Tab` 的唯一作用是在 `input` 区与 `messages` 区之间切换焦点（标注"不可配置"），该表中 `p` 才是打开 provider overlay 的快捷键。Spec 1 中提到的 `Tab` 打开 provider 浮层与 Spec 4 的 `Tab` 焦点切换定义直接冲突，Spec 4 是后续更完整的 UI 设计，`Tab` 实际上不应也不能打开 provider 浮层。
- **建议**：修改 Spec 1 第 6 节，将快捷键描述从"如 `Tab` 或 `p`"改为明确的 "`p`"，与 Spec 4 保持一致，消除歧义。

---

### [U-12] 首次启动无统一引导流程，多 Spec 配置缺失错误并发堆叠

- **涉及 Spec**：Spec 1、Spec 6、Spec 8
- **问题描述**：三个 Spec 各自定义了配置缺失时的错误处理，但互相独立、缺乏协调：
  - Spec 1 第 1 节：settings.json 不存在时"显示友好引导提示"，但没有说明提示以何种形式呈现（TUI 内消息还是启动前的 stderr 输出），也没有定义提示文案。
  - Spec 6 第 3 节：`activePersona` 指向不存在 id 时"给出明确错误信息（非崩溃）"，但展示位置未定义。
  - Spec 8 第 11 节：`memory.enabled: false` 时 `/memory` 浮层显示"Memory 功能已禁用"，但首次启动（JSONL 文件不存在）时没有任何提示，用户不知道 memory 是否正常工作。
  
  用户在首次使用时可能同时触发多条来自不同 Spec 的错误提示，这些提示风格和位置不统一（有的在启动阶段，有的在操作阶段），无法形成一个清晰的"请先做 X 再做 Y"的引导序列。
- **建议**：增加一个统一的首次启动引导流程规范（可作为独立 Spec 或 Spec 1 的附录），定义各类配置缺失时的统一错误展示位置（建议统一到 TUI 启动后的消息区）、提示文案风格，以及多错误并发时的优先级规则（如先引导创建 settings.json，再引导配置 provider，再提示 persona）。

---

### [U-13] Sidebar 24 列宽度下叠加多 Spec 信息后过载，无统一截断规则

- **涉及 Spec**：Spec 1、Spec 4、Spec 6、Spec 3
- **问题描述**：Spec 4 将 Sidebar 固定为 24 列（`width: 24, flexShrink: 0`），且包含快捷键提示区和底部状态区。随着多个 Spec 不断向 Sidebar 追加信息，底部状态区的内容叠加如下：
  - Spec 1：`provider.label`（如 "Ollama (本地)"，10 字符）+ `model`（如 "llama3"）— 两行
  - Spec 6：`persona.name`（如 "代码专家"）— 一行（在 provider 信息下方）
  - Spec 3（隐含）：当前 session 标题（取第一条用户消息前 20 字符）— 一行
  
  24 列边框内实际可用宽度为 22 列。`model` 字段无长度限制，用户若配置 `"model": "claude-opus-4-5-20261001"` 等较长名称，Spec 4 未定义截断或换行规则，可能导致布局溢出或被裁断显示。此外，Spec 4 的 Sidebar 快捷键提示区与底部状态区之间的行数分配未随新增信息项同步更新，整体 Sidebar 信息架构没有统一的版本化设计。
- **建议**：在 Spec 4 中为 `provider.label`、`model`、`persona.name` 分别定义显示宽度上限（如各自最多 20 字符，超出时截断并加 `…`），并明确 Sidebar 各信息区域的行数上限。各后续 Spec 新增 Sidebar 内容时，必须同步更新 Spec 4 的 Sidebar 布局设计。

---

## 总结

本次审查共发现 **13 个 UX 问题**，按严重程度分类：

**必须修复（影响核心交互可用性）：**
- U-01：中止 streaming 快捷键缺失，用户无法停止 AI 输出
- U-04：工具确认快捷键与 Overlay 规范冲突，同一类型弹窗行为不一致
- U-05：`ToolConfirmRequiredEvent.resolve` 违反 Agent-UI 解耦原则，影响架构一致性
- U-10：streaming 中切换 session 行为未定义，可能导致消息写入乱入

**应该修复（功能可发现性和错误可见性）：**
- U-02：Persona 快捷键缺失于全局快捷键表，功能不可发现
- U-03：多 session 能力无 TUI 入口，Spec 3 实现对用户不可见
- U-06：`hook_blocked` 可能静默，用户不知道动作被拦截
- U-07：`/remember` 写入失败后误显示"已记住"，误导用户
- U-08：对话历史截断无提示，用户误解 AI 行为
- U-11：`Tab` 键定义在 Spec 1 与 Spec 4 之间矛盾

**建议改善（设计一致性和扩展性）：**
- U-09：Subagent 进度树与 Spec 4 布局未协调，空间规划存在冲突
- U-12：首次启动引导流程分散在多个 Spec，无统一体验路径
- U-13：Sidebar 信息叠加无截断规则，后续扩展缺乏统一的信息架构
