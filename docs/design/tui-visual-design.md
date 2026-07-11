# TUI 视觉设计规范

> 本文件是 paw TUI 样式的权威来源。布局规则、组件树、尺寸、交互逻辑见 [Spec 4](../specs/4-20260710-ui-tui-layout.md)；本文件仅定义颜色取值、字符选用、间距、动画参数，以及这些取值如何映射到 `@opentui/core` / `@opentui/react` 的 API。
>
> **禁止使用 emoji**。所有视觉元素只使用 ASCII 可打印字符、Unicode 制表符、文字标签或 SVG（SVG 仅用于离线文档预览，不用于终端渲染）。

---

## 1. 色彩系统（Catppuccin Mocha）

### 1.1 调色板变量

| 变量名 | 十六进制 | OpenTUI 用法示例 |
|--------|---------|----------------|
| `base` | `#1e1e2e` | `backgroundColor` 全局背景 |
| `surface0` | `#313244` | 代码块背景、次级容器背景 |
| `surface1` | `#45475a` | 非焦点边框 / 分隔线 |
| `overlay0` | `#6c7086` | 禁用文字、占位符、dim 状态 |
| `text` | `#cdd6f4` | 主正文 `fg` |
| `subtext0` | `#a6adc8` | 次要文字：时间戳、hint、model 名 |
| `sky` | `#89dceb` | 强调色（accent）：焦点边框、角色名（PAW）、快捷键 key |
| `green` | `#a6e3a1` | 成功：tool 完成、stream_done |
| `yellow` | `#f9e2af` | 警告：hook 超时、rate_limited、context_trimmed |
| `red` | `#f38ba8` | 错误：auth_failed、hook_blocked、memory_error |
| `peach` | `#fab387` | 危险操作确认（dangerous 级别工具）|
| `mauve` | `#cba6f7` | Subagent 进度（运行中）|
| `flamingo` | `#f2cdcd` | 用户消息角色名（You）|

### 1.2 语义色映射

```
全局背景         → base
非焦点边框       → surface1
焦点边框         → sky
主要文字         → text
次要文字         → subtext0
用户角色名       → flamingo
助手角色名       → sky
系统提示文字     → overlay0 + dim
成功             → green
警告             → yellow
错误/阻断        → red
危险操作         → peach
Subagent 运行中  → mauve
```

---

## 2. 边框策略：减少全框，改用左侧竖线

### 2.1 原则

- **消息气泡**：不画完整边框，只用左侧竖线区分角色和内容层级
- **功能区容器**（MessageArea、InputArea、Sidebar）：保留 rounded 完整边框，因为需要明确区域感知
- **代码块**：rounded 完整边框，与正文文字区分
- **Overlay**：rounded 完整边框，表示浮层优先级

### 2.2 左侧竖线实现

OpenTUI `Box` 支持 `border: ["left"]`，配合 `borderStyle: "single"` 和 `borderColor` 实现：

```
border: ["left"]           // 只绘制左边框
borderStyle: "single"      // ─ 单线
borderColor: <角色色>      // 颜色区分角色
paddingLeft: 1             // 内容与竖线间距
```

### 2.3 各元素边框规则

| 元素 | 边框配置 | 边框颜色（焦点/非焦点） |
|------|---------|----------------------|
| Sidebar | `border: true, borderStyle: "rounded"` | 焦点 `sky` / 非焦点 `surface1` |
| MessageArea | `border: true, borderStyle: "rounded"` | 焦点 `sky` / 非焦点 `surface1` |
| InputArea | `border: true, borderStyle: "rounded"` | 焦点 `sky` / 非焦点 `surface1` |
| SubagentProgressArea | `border: true, borderStyle: "rounded"` | 运行中 `mauve` / 完成 `green` |
| Overlay | `border: true, borderStyle: "rounded"` | 始终 `sky` |
| 用户消息气泡 | `border: ["left"], borderStyle: "single"` | `flamingo` |
| 助手消息气泡 | `border: ["left"], borderStyle: "single"` | `sky` |
| 系统事件行 | `border: ["left"], borderStyle: "single"` | 按事件语义色（见第 5 节）|
| 代码块 | `border: true, borderStyle: "rounded"` | `surface1` |
| 工具危险确认 Overlay | `border: true, borderStyle: "rounded"` | `peach` |

---

## 3. 整体布局文字示意

```
+----------------------+ +----------------------------------------------------------+
| PAW                  | |                                                          |
|                      | | [flamingo竖线] You                                       |
| p   provider         | | 帮我写一个快速排序算法                                    |
| s   session          | |                                                          |
| P   persona          | | [sky竖线] PAW                                            |
| Esc abort/clear      | | 好的，以下是快速排序实现：                                |
|                      | | +--typescript--------------------------------+          |
| SESSION              | | | function quickSort(arr: number[]): number[] |          |
| 帮我写快速排序...    | | |   ...                                       |          |
|                      | | +--------------------------------------------+          |
| -------------------- | +--[mauve竖线]--------------------------------------+      |
| [默认助手]           | | >> subagent-1: 分析需求...   [running]              |      |
| Claude               | +----------------------------------------------------------+
| sonnet-5             | | > _                                                      |
+----------------------+ +----------------------------------------------------------+
```

---

## 4. Sidebar 视觉规范

### 4.1 内部结构与颜色

```
标题行 "PAW"        → fg: sky, bold
快捷键 key          → fg: sky（如 "p"、"s"、"P"）
快捷键 description  → fg: subtext0
分隔线              → fg: surface1，字符 "─" 填满内容宽度
Section 标签        → fg: subtext0, dim，大写（"SESSION"、"PROVIDER"）
session.title       → fg: text，超 20 字截断加 "..."
persona.name        → fg: overlay0，格式 "[名称]"
provider.label      → fg: text
model               → fg: subtext0
```

### 4.2 快捷键行格式

每行格式：`{key}  {description}`

- key 宽度固定 6 字符，右对齐空格填充
- key 与 description 间距 2 字符
- 整体 `paddingLeft: 1`

### 4.3 截断规则

超出字符数时末尾替换为 `...`（3 个英文句点，非省略号字符）：

| 信息项 | 最大字符数 |
|--------|-----------|
| session.title | 20 |
| persona.name | 18 |
| provider.label | 18 |
| model | 20 |

---

## 5. 消息区视觉规范

### 5.1 消息块结构

每条消息：

```
[左侧竖线，角色色] 角色名（bold）
                   消息正文（text 颜色，paddingLeft 对齐到竖线右侧）
```

- **You**（用户）：竖线色 `flamingo`，角色名 `fg: flamingo, bold`
- **PAW**（助手）：竖线色 `sky`，角色名 `fg: sky, bold`
- 消息间 `marginBottom: 1`（空一行）

### 5.2 流式光标

streaming 进行中，消息末尾追加光标 `_`（下划线字符，非 Unicode 块字符）：

- 使用 `useTimeline` + `Timeline`，对光标元素的 `opacity` 属性做动画
- 动画参数：`duration: 500`，`alternate: true`，`loop: true`，`ease: "inOutSine"`
- opacity 范围：`0 → 1`（fade in/out，比硬切换更柔和）
- streaming 结束后调用 `timeline.pause()` 并将 opacity 设为 `0` 使光标消失

```
// 伪代码（设计意图，不是实现代码）
useTimeline({ loop: true, autoplay: true })
  .add(cursorRef, { opacity: [0, 1], duration: 500, alternate: true, ease: "inOutSine" })
```

### 5.3 代码块

```
+-- typescript -----------------------------------+
| function quickSort(arr: number[]): number[] {  |
|   ...                                          |
+------------------------------------------------+
```

- 边框：`rounded`，颜色 `surface1`
- 标题（语言标签）：`title` 属性，颜色 `subtext0`
- 内容背景：`surface0`（与正文背景区分）
- 内容文字：`text`
- 代码高亮：使用 `CodeRenderable`（`@opentui/core` 内置）+ tree-sitter

### 5.4 系统事件行（inline）

出现在消息流中，格式：`[左侧竖线] TAG  内容文字`

| 事件类型 | 竖线色 | TAG 文字 | 内容颜色 |
|---------|--------|---------|---------|
| 工具执行中 | `subtext0` | `[TOOL]` | `subtext0, dim` |
| 工具完成 | `green` | `[TOOL]` | `green` |
| 工具错误 | `red` | `[TOOL]` | `red` |
| Hook 执行中 | `subtext0` | `[HOOK]` | `subtext0, dim` |
| Hook 警告 | `yellow` | `[HOOK]` | `yellow` |
| Hook 拦截 | `red` | `[HOOK BLOCKED]` | `red, bold`（必须展示，不可省略）|
| 历史裁剪 | `overlay0` | `[TRIMMED]` | `overlay0, dim` |
| Memory 成功 | `green` | `[MEMORY]` | `green` |
| Memory 错误 | `red` | `[MEMORY]` | `red` |

TAG 用方括号包裹纯文字，不用 emoji 或特殊符号。

---

## 6. InputArea 视觉规范

```
+-- > ------------------------------------------+
| _                                              |
+------------------------------------------------+
```

- 前缀 `>` 颜色 `sky, bold`，宽度固定，与输入内容间距 1
- streaming 进行中，前缀替换为 loading 动画（见第 7 节），此时输入被禁用
- 输入内容颜色 `text`
- 历史导航时（按上/下键浏览历史），内容颜色改为 `subtext0`（提示非新输入）

---

## 7. 动画规范（基于 `useTimeline` / `Timeline`）

所有动画通过 `@opentui/react` 的 `useTimeline` hook 创建，注册到 `@opentui/core` 的 `engine`。**不使用 `setInterval`，不使用 emoji 旋转字符**。

### 7.1 流式光标（streaming cursor）

- 元素：`_` 字符的 TextNode
- 动画属性：`opacity`，范围 `0 → 1`
- 参数：`duration: 500ms`，`alternate: true`，`loop: true`，`ease: "inOutSine"`
- 触发：`stream_chunk` 首次到达时 `.play()`；`stream_done` / `agent_abort` 时 `.pause()` + opacity 置 0

### 7.2 Loading 指示器（InputArea 前缀 / Subagent running）

用 Braille 字符序列配合 `Timeline.call()` 逐帧切换，实现旋转动画：

```
字符序列（10 帧）：⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
帧间隔：80ms
loop: true
```

实现思路：`Timeline` 在每帧 `call()` 中更新 React state（`frameIndex`），React 重渲染时取序列中对应字符。

```
// 伪代码（设计意图）
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
timeline.call(() => setFrame(i => (i + 1) % 10), 0)
  // 10 个等间隔 call，每帧 80ms
```

- InputArea streaming 时：前缀 `>` 替换为当前帧 Braille 字符，颜色 `mauve`
- Subagent running 时：状态行前缀同上，颜色 `mauve`

### 7.3 Subagent 完成后淡出

SubagentProgressArea 全部任务完成后，2 秒保留期结束时执行淡出：

- 对整个区域的 `opacity` 属性做动画
- 参数：`duration: 300ms`，`ease: "outQuad"`，`opacity: 1 → 0`
- 动画结束后从 DOM 中移除（`onComplete` 回调中更新 React state）

### 7.4 Overlay 出现动画

Overlay 显示时执行进入动画：

- 属性：`opacity: 0 → 1`
- 参数：`duration: 150ms`，`ease: "outQuad"`

---

## 8. Overlay 视觉规范

```
+-- 选择 Provider ------------------------------+
|                                               |
|  > Anthropic     claude-sonnet-5  (current)  |
|    OpenAI        gpt-4o                       |
|    Ollama        llama3                       |
|    DeepSeek      deepseek-chat                |
|                                               |
|  Enter  confirm    Esc  cancel                |
+-----------------------------------------------+
```

- 标题：`title` 属性，颜色 `sky`
- 选中行前缀 `>`（sky 色），非选中行前缀 ` `（空格占位）
- 当前激活项附加 `(current)` 标注，颜色 `overlay0, dim`
- Footer：`bottomTitle` 属性，格式 `Enter  confirm    Esc  cancel`，颜色 `subtext0`
- `Select` 组件（`@opentui/core` 内置 `SelectRenderable`）可直接承接列表选择交互

### 8.1 工具危险确认 Overlay

```
+-- Tool Call Confirm ---------------------------+
|                                               |
|  Tool:  write_file                            |
|  Path:  /Users/br.huang/workspace/paw/...    |
|                                               |
|  [WARNING] This action cannot be undone.     |
|                                               |
|  Enter  confirm    Esc  cancel                |
+-----------------------------------------------+
```

- `confirm` 级别：标准样式，边框 `sky`
- `dangerous` 级别：边框改为 `peach`，额外显示 `[WARNING]` 文字行（`fg: peach, bold`）
- 路径显示绝对路径，颜色 `subtext0`；dangerous 时路径颜色 `peach`

---

## 9. SubagentProgressArea 视觉规范

```
+-- Tasks (2/3) --------------------------------+
|  [DONE]    搜索文档       3.2s               |
|  [ERROR]   分析代码       timeout            |
|  [running] 查询 API       正在解析响应...    |
+-----------------------------------------------+
```

- 标题：`Tasks (完成数/总数)`，颜色 `mauve`
- 状态标签用方括号包裹文字，左对齐，固定宽度 10 字符：
  - `[DONE]`：`green`
  - `[ERROR]`：`red`
  - `[CANCEL]`：`yellow`
  - `[running]`：`mauve`，行首加当前帧 Braille loading 字符（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 序列，见 7.2）
  - `[wait]`：`overlay0, dim`
- 超过 6 行时最后一行显示 `... +N more tasks`（`subtext0, dim`）

---

## 10. 错误与状态颜色速查

| 场景 | 颜色 | 展示方式 |
|------|------|---------|
| auth_failed | `red` | inline 系统事件行 |
| rate_limited | `yellow` | inline 系统事件行 |
| network_timeout | `yellow` | inline 系统事件行 |
| model_not_found | `yellow` | inline 系统事件行 |
| server_error | `red` | inline 系统事件行 |
| hook_blocked | `red, bold` | inline 系统事件行，**必须展示** |
| hook_warning | `yellow` | inline 系统事件行 |
| context_trimmed | `overlay0, dim` | inline 系统事件行，低调 |
| memory_error | `red` | inline 系统事件行，替代"已记住"提示 |
| provider_change_error | `yellow` | inline 系统事件行 |
| streaming abort | `subtext0, dim` | 消息标注 `[aborted]` 后缀 |

---

## 11. 关键 OpenTUI API 映射速查

| 设计意图 | OpenTUI API |
|---------|-------------|
| 只画左侧竖线 | `border: ["left"], borderStyle: "single"` |
| 圆角完整边框 | `border: true, borderStyle: "rounded"` |
| 焦点边框颜色 | `focusedBorderColor: sky` |
| 文字颜色 | `fg: "#hex"` 或 `styled text fg(color)(str)` |
| 加粗 | `bold(str)` 或 `attributes: BOLD` |
| 暗化 | `dim(str)` 或 `attributes: DIM` |
| 斜体 | `italic(str)` 或 `attributes: ITALIC` |
| 透明度动画 | `Timeline.add(target, { opacity: [0,1], ... })` |
| 循环动画 | `loop: true, alternate: true` |
| 帧回调动画 | `Timeline.call(callback, startTime)` |
| 列表选择 | `SelectRenderable` / `<select>` |
| 滚动容器 | `ScrollBoxRenderable` / `<scrollbox>` |
| 代码高亮 | `CodeRenderable` + tree-sitter |
| Markdown 渲染 | `MarkdownRenderable` |
| 区域标题 | `BoxOptions.title` / `BoxOptions.bottomTitle` |

---

## 参考关系

- 布局规则、组件树、尺寸、焦点状态机、快捷键体系 → [Spec 4](../specs/4-20260710-ui-tui-layout.md)
- 实现任务清单 → [Task 4](../tasks/4-20260710-ui-tui-layout.md)
- AgentEvent 消费规则 → [Spec 2](../specs/2-20260710-agent-orchestration.md)

---

## 12. ThinkingBlock 视觉规范（Spec 1.1）

`ThinkingBlock` 渲染于助手消息的 `MessageHeader` 与 `MessageBody` 之间，仅在该消息含 thinking 内容时出现。

### 12.1 折叠态

```
[thinking  v]  (1024 chars)
```

- 整行使用左侧竖线，颜色 `overlay0`（区别于助手消息正文的 `sky`）
- 标题文字 `thinking` 颜色 `overlay0`
- 折叠图标 `v` 颜色 `overlay0`
- 字数提示 `(N chars)` 颜色 `overlay0, dim`
- streaming 进行中：折叠图标位置替换为当前帧 Braille loading 字符（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 序列，颜色 `overlay0`），字数提示不显示

### 12.2 展开态

```
[thinking  ^]  (1024 chars)
 正在思考如何分解这个问题...
 首先需要理解用户的需求，然后...
```

- 标题行同折叠态，折叠图标改为 `^`
- 内容行：`paddingLeft: 1`，`fg: overlay0`，不做 Markdown 解析，纯文本渲染
- 内容行与标题行之间无额外间距

### 12.3 边框规则

| 元素 | 边框配置 | 颜色 |
|------|---------|------|
| ThinkingBlock 整体 | `border: ["left"], borderStyle: "single"` | `overlay0` |

### 12.4 语义色映射补充

```
ThinkingBlock 竖线         → overlay0
ThinkingBlock 文字         → overlay0
ThinkingBlock loading 动画 → overlay0
```
