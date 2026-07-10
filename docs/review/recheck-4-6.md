# 复查报告：Spec 4-6

> 复查日期：2026-07-10
> 复查范围：Spec 4（TUI 布局）、Spec 5（工具系统）、Spec 6（Persona 配置）
> 参照基准：`docs/review/0-summary.md` 问题清单（P0-01 ~ P3-08）

---

## Spec 4 复查结果

### 涉及本 Spec 的问题清单

| 编号 | 优先级 | 问题摘要 |
|------|--------|---------|
| P0-01 | P0 | AgentEvent 协议跨 Spec 不兼容 |
| P2-08 | P2 | `input_submitted` 违反单向事件流 |
| P2-09 | P2 | 缺少中止 streaming 的快捷键 |
| P2-10 | P2 | `hook_blocked` 无渲染路径 |
| P2-12 | P2 | `context_trimmed` 无渲染路径 |
| P2-14 | P2 | Subagent 进度树与布局冲突 |
| P3-01 | P3 | 工具确认弹窗 y/n 与 Overlay 规范不一致 |
| P3-02 | P3 | 多 session 无 TUI 入口 |
| P3-03 | P3 | Persona 切换快捷键未收录 |
| P3-04 | P3 | Tab 键描述与 Spec 4 冲突（本 Spec 原已存在 p 键定义） |
| P3-06 | P3 | Sidebar 缺少截断规则 |

### 通过项

- **P0-01（AgentEvent 格式）**：Spec 4 Section 8 中消费的事件（`stream_chunk`、`stream_done`、`stream_error`、`provider_changed`、`context_trimmed`、`hook_started`、`hook_completed`、`hook_blocked`）均已采用嵌套 `payload` 格式描述，与 Spec 2 的 `payload` 规范一致。
- **P2-08（input_submitted）**：Section 8 明确写明"本 Spec 不新增 UI→Agent 方向的 AgentEvent；用户输入提交通过直接调用 `AgentRunner.send(text)` 实现，不经过 AgentEvent 协议"，并加注"AgentEvent 仅从 Agent 层流向 UI 层（单向）"，修复正确。
- **P2-09（中止 streaming 快捷键）**：Section 3 快捷键表新增了 `Esc` 和 `Ctrl+C` 的上下文感知行为——"streaming 进行中：调用 `AgentRunner.abort()`"，Section 2.3 焦点转换规则中也有相应描述，修复完整。
- **P2-10（hook_blocked 渲染路径）**：Section 8 新增了 `hook_started`、`hook_completed`、`hook_blocked` 三类事件的渲染规则，`hook_blocked` 明确标注"**必须**以红色系统提示条目展示，不可作为可选项"，修复正确。
- **P2-12（context_trimmed 渲染路径）**：Section 8 新增了 `context_trimmed` 事件的消费规则："在消息区插入浅灰色系统提示：'[历史已裁剪，保留最近 N 轮对话]'"，修复正确。
- **P2-14（Subagent 进度树布局冲突）**：布局图和尺寸规则表中新增了 `SubagentProgressArea`（位于 `MessageArea` 和 `InputArea` 之间，`maxHeight: 6`），折叠时机也明确："所有 Subagent 完成后保留 2 秒摘要再消失"，与 Spec 9 Section 8 的描述一致，修复完整。
- **P3-01（工具确认弹窗交互规范）**：Section 6.3 新增"所有确认类弹窗统一交互规范：`Enter` 确认、`Esc` 取消，工具确认弹窗（`ToolConfirmOverlay`）遵循此规范，**不使用 y/n 按键**"，修复正确。
- **P3-02（多 session 无 TUI 入口）**：Section 3 快捷键表新增 `s` 键"打开 session 管理浮层（`SessionPickerOverlay`）"，`overlay/SessionPicker.tsx` 也出现在目录结构中，修复正确。
- **P3-03（Persona 切换快捷键未收录）**：Section 3 快捷键表新增 `Shift+P` 键"打开 Persona 选择浮层，复用通用 `Overlay` 容器"，`overlay/PersonaPicker.tsx` 出现在目录结构中，修复正确。
- **P3-06（Sidebar 截断规则）**：新增 Section 9"Sidebar 信息展示规范"，为 `provider.label`（18 字符）、`model`（20 字符）、`persona.name`（18 字符）、`session.title`（20 字符）分别定义了截断上限，并注明"后续 Spec 新增 Sidebar 展示内容时必须同步更新本节"，修复完整。

### 问题项

#### [RC2-01] `stream_done` 的 payload 格式与 Spec 2 权威定义不一致

- **类型**：新引入问题
- **描述**：Spec 4 Section 8 中 `stream_done` 事件的 payload 写为 `{ totalText: string }`，但 Spec 2 Section 2 及附录"AgentEvent 权威类型定义"中明确规定 `stream_done` 的 payload 为 `{ totalText: string; stopReason: "stop" | "tool_use" }`（多了 `stopReason` 字段）。Spec 4 描述的是截断后的旧版本格式，导致消费侧与权威定义不一致。
- **建议**：将 Spec 4 Section 8 中 `stream_done` 的 payload 更新为 `{ totalText: string; stopReason: "stop" | "tool_use" }`，与 Spec 2 附录保持一致。

#### [RC2-02] Section 8 未列出 Spec 5 工具调用事件的渲染规则

- **类型**：遗漏修复（关联 P0-01 / P2-09 范围外，但属于 Spec 4 完整性缺口）
- **描述**：Spec 5 定义了 `tool_call_start`、`tool_call_result`、`tool_error`、`tool_confirm_required`、`max_tool_turns_reached` 五类 AgentEvent，需要 UI 层消费。Spec 4 Section 8 的事件消费规则表中未列出任何工具调用相关事件的渲染路径（仅在验收标准中有一行"UI 层可收到...事件并渲染"的要求，但属于 Spec 5 的验收标准，非 Spec 4 的布局设计）。用户对工具执行进度（如"正在执行 shell_exec..."）的感知完全缺失。
- **建议**：Spec 4 Section 8 补充 `tool_call_start`（显示工具调用进度提示）、`tool_call_result`（完成后更新提示）、`tool_error`（红色错误提示，类似 `stream_error`）、`max_tool_turns_reached`（系统提示）四类事件的渲染规则；`tool_confirm_required` 的渲染（打开 `ToolConfirmOverlay`）也应在此处描述。

---

## Spec 5 复查结果

### 涉及本 Spec 的问题清单

| 编号 | 优先级 | 问题摘要 |
|------|--------|---------|
| P0-01 | P0 | AgentEvent 协议跨 Spec 不兼容 |
| P0-02 | P0 | AgentRunner 与 AgentOrchestrator 职责边界未划定 |
| P1-01 | P1 | `ToolConfirmRequiredEvent.resolve` 回调耦合 + 死锁风险 |
| P1-08 | P1 | read_file / write_file 缺少 workingDir 路径边界校验 |
| P2-19 | P2 | 用户自定义工具无签名校验和信任确认 |
| P3-01 | P3 | 工具确认弹窗 y/n 与 Overlay 规范不一致 |

### 通过项

- **P0-01（AgentEvent 格式统一）**：Section 6 新增事件定义全部采用嵌套 `payload` 格式（`{ type: "xxx"; payload: { ... } }`），与 Spec 2 规范一致；注释中明确写明"采用嵌套 payload 格式（与 Spec 2 一致）"。Spec 1 原有四个事件的 `AgentEvent` 联合类型也在 Section 6 末尾整合展示，格式统一。
- **P0-02（AgentOrchestrator 与 AgentRunner 职责边界）**：Section 5.1 新增"AgentOrchestrator 与 AgentRunner 职责划定"章节，包含文字版架构层次图，明确"AgentRunner 是对外接口层，唯一对 UI 暴露的 Agent 接口；AgentOrchestrator 是内部执行层，通过构造时注入的回调函数将事件返回给 AgentRunner 统一发射，不直接持有事件发射器；AgentOrchestrator 不直接暴露给 UI 层"，修复正确且完整。
- **P1-01（ToolConfirmRequiredEvent 死锁风险）**：`ToolConfirmRequiredEvent` 的 payload 中已删除 `resolve` 回调；新增 `ToolExecutor.resolveConfirm(toolCallId, approved)` 和 `abortAllPendingConfirms()` 方法；Section 8.2 明确用户确认流程通过 `AgentRunner.confirmToolCall(toolCallId, approved)` 传回，`abort()` 时所有待决 confirm 自动以 `approved=false` 结算，修复正确完整。
- **P1-08（路径边界校验）**：`read_file` 和 `write_file` 均新增了详细的路径边界校验说明：调用 `path.resolve(workingDir, inputPath)` 规范化、验证以 `workingDir` 为前缀、`write_file` 对 `~/.paw/`/`~/.ssh/`/`~/.aws/`/`~/.bashrc`/`~/.zshrc` 强制拒绝且不可被 `autoApprove` 覆盖、确认弹窗展示绝对路径。验收标准中也有对应验证项，修复完整。
- **P2-19（自定义工具安全机制）**：新增 Section 2"自定义工具安全加载机制"四步流程（首次确认、信任记录 SHA-256 hash、变更重新确认、路径限制仅允许用户主目录），并在验收标准中新增对应测试项，修复完整。
- **P3-01（工具确认弹窗规范）**：Section 8.2 明确"用户按 `Enter` 确认、`Esc` 取消（与 Spec 4 Overlay 规范一致）"，验收标准也有"工具确认弹窗支持 `Enter` 确认、`Esc` 取消（而非 y/n）"，修复正确。

### 问题项

#### [RC2-03] `ToolConfirmRequiredEvent` 的 `safetyLevel` 字段类型与 Spec 2 定义不完全一致

- **类型**：内部矛盾
- **描述**：Spec 5 Section 6 中 `ToolConfirmRequiredEvent.payload.safetyLevel` 的类型为字面量联合 `"confirm" | "dangerous"`。而 Spec 2 附录中同一事件的字段类型为 `string`（更宽泛）。虽然 Spec 5 的具体类型从语义上更严格、更合理，但与 Spec 2 中已经"预留并声明"的接口定义存在宽窄不一致，实现时以哪个为准不明确。
- **建议**：Spec 2 附录中 `tool_confirm_required` 的 `safetyLevel: string` 应更新为 `safetyLevel: "confirm" | "dangerous"`，与 Spec 5 的具体定义保持一致；或在 Spec 5 的注释中明确"此处比 Spec 2 预留定义更严格，以 Spec 5 为准"。

#### [RC2-04] `ToolExecutor` 构造函数注入的 `emitter` 回调类型与 AgentOrchestrator 层次架构存在歧义

- **类型**：内部矛盾
- **描述**：Spec 5 Section 5 中 `ToolExecutor` 构造函数签名为：
  ```ts
  constructor(
    private registry: ToolRegistry,
    private emitter: (event: AgentEvent) => void,  // 向 AgentRunner 发事件，由 AgentRunner 统一转发至 UI
  )
  ```
  注释写明"向 AgentRunner 发事件"，但根据 Section 5.1 的架构图，`AgentOrchestrator` 是内部执行层、持有 `ToolExecutor` 实例，且"`AgentOrchestrator` 通过构造时注入的回调通知 `AgentRunner`"。这意味着 `ToolExecutor` 的 `emitter` 实际上是注入的 `AgentOrchestrator` 的回调，而非直接指向 `AgentRunner` 的发射器。注释中"向 AgentRunner 发事件"的表述容易让实现者误解为直接持有 `AgentRunner` 的发射器引用，与架构约束（`AgentOrchestrator` 不直接持有事件发射器）形成歧义。
- **建议**：将 `ToolExecutor` 的 `emitter` 注释修改为"通过 AgentOrchestrator 注入的回调通知上层，最终由 AgentRunner 统一发射到 UI 事件总线"，以明确事件传播路径不绕过 `AgentOrchestrator`。

---

## Spec 6 复查结果

### 涉及本 Spec 的问题清单

| 编号 | 优先级 | 问题摘要 |
|------|--------|---------|
| P0-01 | P0 | AgentEvent 协议跨 Spec 不兼容 |
| P2-03 | P2 | Persona 与 Provider 切换的持久化语义未声明 |
| P2-05 | P2 | `PersonaRegistry.switchTo()` 直接调用 `ProviderRegistry`，违反模块层级边界 |
| P2-06 | P2 | Memory 注入顺序依赖 Persona 初始化，system prompt 最终组装职责未明确 |
| P3-03 | P3 | Persona 切换快捷键未收录于 Spec 4 |
| P3-05 | P3 | 首次启动错误提示分散，缺乏统一引导体验 |
| P3-08 | P3 | `{{cwd}}` 插值含用户名，隐私风险 |

### 通过项

- **P0-01（AgentEvent 格式统一）**：Section 6 两个新增事件均使用嵌套 `payload` 格式：`{ type: "persona_changed"; payload: { personaId: string; name: string; providerId?: string } }` 和 `{ type: "system_prompt_override"; payload: { preview: string } }`，与 Spec 2 规范一致。
- **P2-03（持久化语义声明）**：Section 7 `PersonaRegistry.switchTo()` 注释明确："切换后立即写回 settings.json 的 activePersona 字段（持久化）。通过统一的 `SettingsWriter` 组件串行化写操作，避免与 Spec 1 provider 切换并发写冲突。"验收标准也有"切换后写回 settings.json 的 activePersona 字段（持久化）"和"并发调用 switchTo() 和 Spec 1 的 switchProvider() 时，通过 SettingsWriter 串行化，settings.json 不发生写冲突"，修复完整。
- **P2-05（PersonaRegistry 模块边界）**：Section 6 明确"`PersonaRegistry` 不持有 `ProviderRegistry` 引用，符合分层原则"，并提供事件驱动联动路径图：`switchTo()` 只 emit `persona_changed`，由 `AgentRunner / AgentOrchestrator` 监听后调用 `switchProvider()`，修复正确。
- **P2-06（system prompt 最终组装）**：新增 Section 8"System Prompt 最终组装"，明确四步组装顺序：① `PersonaRegistry.resolveSystemPrompt()` → ② `MemoryStore.load()` → ③ `MemoryInjector.buildBlock(entries)` → ④ 拼接，并说明"此组装逻辑位于 `AgentOrchestrator` 的请求构建阶段"，修复完整。
- **P3-03（Persona 快捷键同步）**：Section 9 明确快捷键为 `Shift+P`，并注明"此键位已在 Spec 4 Section 3 快捷键表中注册，`p` 键已被 provider 切换占用，故选用 `Shift+P` 避免冲突"；Persona 选择浮层"复用 Spec 4 的通用 `Overlay` 容器组件"，修复正确。
- **P3-05（首次启动错误提示统一）**：Section 10 配置缺失处理明确"在 TUI 消息区展示系统提示"，并注明"此提示风格与 Spec 1 / Spec 8 的配置缺失提示保持一致（均在 TUI 消息区展示，而非 stderr）"，修复正确。
- **P3-08（`{{cwd}}` 隐私风险）**：新增 `{{cwd_basename}}` 变量（仅目录名），在变量表中为 `{{cwd}}` 增加"⚠️ 含用户名，见隐私说明"标注，专门新增"`{{cwd}}` 隐私说明"段落，并支持 `interpolation.allowCwd: false` 全局禁用，修复完整。

### 问题项

#### [RC2-05] `persona_changed` 事件 payload 的 `personaId` 字段命名与 Spec 2 权威附录预期不一致

- **类型**：新引入问题（跨 Spec 不一致）
- **描述**：Spec 6 Section 6 中定义 `persona_changed` 事件的 payload 为 `{ personaId: string; name: string; providerId?: string }`。Spec 2 的附录"AgentEvent 权威类型定义"中，`persona_changed` 未在 Spec 1–2 范围内定义，因此没有在附录中列出，这是符合预期的。但 Spec 6 的 `PersonaRegistry.switchTo()` 注释中写"emit persona_changed 事件（payload 含可选 providerId）"，而 Section 6 中的 payload 实际还含有 `personaId` 和 `name` 字段。Spec 6 本身两处描述（注释与接口定义）对 payload 内容的表述不完整/不一致——注释只提 `providerId` 一个字段，遗漏了 `personaId` 和 `name`。
- **建议**：将 Section 7 `PersonaRegistry.switchTo()` 方法注释中的 payload 描述更新为"emit persona_changed 事件（payload 含 personaId, name, 以及可选的 providerId）"，与 Section 6 的接口定义完全对应。

#### [RC2-06] `switchTo()` 改为 `async` 后，`PersonaRegistry` 接口定义中返回类型为 `Promise<void>`，但 `overrideSystemPrompt()` 仍为同步方法，持久化与非持久化操作混用可能引发调用者误解

- **类型**：内部矛盾（轻微）
- **描述**：Section 7 接口中 `switchTo(id: string): Promise<void>` 为 async（涉及写盘），而 `overrideSystemPrompt(prompt: string | null): void` 为同步（不写盘，仅更新内存）。两个"写"操作的异步性语义差异隐含了"同步=不持久化，异步=持久化"的约定，但接口文档中未明确说明，调用者若不注意返回类型可能忽视 `await`。
- **建议**：在 `PersonaRegistry` 接口注释中为 `overrideSystemPrompt()` 明确标注"仅更新内存，不写盘，同步返回"，与 `switchTo()` 的"写回 settings.json（持久化）"形成明确对比，消除调用者歧义。

---

## 总结

| Spec | 覆盖率 | 主要问题 |
|------|--------|---------|
| Spec 4 | 高（10/11 条已修复） | [RC2-01] `stream_done` payload 少 `stopReason` 字段（与 Spec 2 不一致）；[RC2-02] 工具调用事件渲染路径未在 Section 8 定义（功能性遗漏） |
| Spec 5 | 高（6/6 条已修复） | [RC2-03] `safetyLevel` 类型宽窄与 Spec 2 预留定义不一致（轻微）；[RC2-04] `ToolExecutor.emitter` 注释描述路径存在歧义（表述问题） |
| Spec 6 | 高（7/7 条已修复） | [RC2-05] `switchTo()` 注释对 payload 字段描述不完整（内部矛盾，轻微）；[RC2-06] 同步/异步操作的持久化语义对比不明确（建议性改善） |

**最高优先级问题：**

1. **[RC2-01]（P1 级建议修复）** Spec 4 的 `stream_done` payload 定义落后于 Spec 2 权威定义，会导致 TypeScript 类型不匹配。
2. **[RC2-02]（P2 级建议修复）** Spec 4 Section 8 缺少工具调用事件的渲染路径描述，虽然验收标准中已隐含，但 Spec 作为设计文档应当完整。
3. **[RC2-03]（P3 级建议修复）** Spec 5 与 Spec 2 对 `safetyLevel` 类型的宽窄不一致，建议统一收紧为 Spec 5 的具体联合类型。
4. **[RC2-04]、[RC2-05]、[RC2-06]** 均为注释/文档表述问题，不影响实现，可随手修正。

三个 Spec 整体修复质量较高，P0/P1 级问题均已正确处理，未发现会阻断实现的新引入问题。
