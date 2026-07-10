# 复查报告：Spec 1-3

> 生成日期：2026-07-10
> 复查范围：Spec 1（config-multi-provider）、Spec 2（agent-orchestration）、Spec 3（agent-context-management）
> 对照来源：0-summary.md 中涉及上述 Spec 的全部 P0/P1/P2/P3 条目

---

## Spec 1 复查结果

0-summary.md 中涉及 Spec 1 的问题：P0-01、P1-09、P2-01、P2-03、P2-15、P2-17、P3-04、P3-05、P3-06（部分）。

### 通过项

- **P0-01（AgentEvent 协议权威定义）**：Spec 1 第 5 节已将 `stream_done` 的 payload 更新为嵌套格式（`payload: { totalText: string }`），并在说明中声明"全量 AgentEvent 权威定义见 `src/agent/events.ts`，此处仅列本 Spec 新增类型"，与 P0-01 的修订方向一致，格式统一。

- **P1-09（本地 hooks 确认机制）**：Spec 1 第 1 节新增了完整的安全警告机制，包含三选项确认（`y/N/q`）、`trustedProjectDirs` 白名单字段、交互文案示例，完整覆盖 P1-09 的修订建议。

- **P2-01（switchProvider 竞态）**：Spec 1 第 4 节"ProviderRegistry 行为规范"明确规定 `switchProvider()` 调用时若有进行中 stream 必须先触发 abort 再切换，并声明"立即生效"语义，覆盖 P2-01。

- **P2-03（switchProvider 持久化语义）**：Spec 1 第 4 节明确声明切换完成后写回 `activeProvider` 字段，写入失败时 emit `provider_change_error` 事件，持久化语义清晰，覆盖 P2-03。

- **P2-15（API Key 文件权限）**：Spec 1 第 2 节新增完整的安全规范，包含首次生成 `chmod 600`、每次启动校验权限、TUI 警告文案、"禁止提交到版本控制"提示，完整覆盖 P2-15。

- **P2-17（SSE ReadableStream 泄漏防范）**：Spec 1 第 4 节新增了"SSE ReadableStream 泄漏防范"段落，规定所有 provider 实现的 `parseStream` 必须包含 `try/finally` 块并调用 `response.body?.cancel()`，附有代码示例，覆盖 P2-17。

- **P3-04（Tab 键冲突）**：Spec 1 第 6 节快捷键描述明确为"快捷键 `p` 打开 provider 选择浮层"，未再出现"Tab"描述，与 Spec 4 定义一致，覆盖 P3-04。

- **P3-05（首次启动引导统一）**：Spec 1 新增"配置缺失处理（首次启动引导）"章节，规定在 TUI 消息区（非 stderr）统一展示引导提示，并附有标准文案，覆盖 P3-05 要求。

- **P3-06（Sidebar 截断规则，Spec 1 部分）**：Spec 1 第 6 节规定 `provider.label` 上限 18 字符、`model` 上限 20 字符，超出截断加 `…`，覆盖 P3-06 对 Spec 1 的要求。

### 问题项

#### [RC1-01] stream_done 的 payload 定义与 Spec 2 定义不一致

- **类型**：新引入问题（跨 Spec 不一致）
- **描述**：Spec 1 第 5 节的事件表格中 `stream_done` 的 payload 仍为 `{ totalText: string }`（无 `stopReason` 字段）。但 Spec 2 第 2 节明确将 `stream_done` 扩展为 `{ totalText: string; stopReason: "stop" | "tool_use" }`，并且 Spec 2 附录的权威事件表也使用了含 `stopReason` 的定义。Spec 1 作为 `stream_done` 的原始定义 Spec，其"事件表"与权威定义（Spec 2 / `src/agent/events.ts`）出现了字段不同步问题，可能造成阅读混乱。
- **建议**：Spec 1 第 5 节的 `stream_done` payload 应更新为 `{ totalText: string; stopReason: "stop" | "tool_use" }`，并在备注中说明 `stopReason` 由 Spec 2 引入。或者在表格旁增加"字段详情见 `src/agent/events.ts`"的引用说明，明确以权威源文件为准。

---

## Spec 2 复查结果

0-summary.md 中涉及 Spec 2 的问题：P0-01、P0-02、P0-03、P1-01、P1-02、P1-05、P1-11、P2-01（共享）、P2-04、P2-07、P2-08、P2-09、P2-13（共享）、P2-17（共享）。

### 通过项

- **P0-01（AgentEvent 权威定义）**：Spec 2 第 2 节明确声明采用嵌套 `payload` 格式，所有类型统一格式，附录提供 Spec 1-2 全量事件表，并注明"后续 Spec 只追加新类型，不得重定义已有类型"，完整覆盖 P0-01。

- **P0-02（AgentRunner 与 AgentOrchestrator 职责边界）**：Spec 2 第 1 节新增"架构层次说明（P0-02）"，以文字版架构图明确：`AgentRunner` 为对外接口层，`AgentOrchestrator` 为内部执行层，`AgentOrchestrator` 通过回调将事件返回给 `AgentRunner` 统一发射，不直接持有事件发射器，完整覆盖 P0-02。

- **P0-03（ConversationHistory 与 SessionManager 替代关系）**：Spec 2 第 5 节新增"P0-03 占位声明"，明确 `ConversationHistory` 为占位实现，Spec 3 后由 `SessionManager` 替代，并在迁移路径中描述了 `AgentRunner` 的改持方式，覆盖 P0-03。

- **P1-01（ToolConfirmRequiredEvent 无 resolve 回调）**：Spec 2 第 2 节中 `ToolConfirmRequiredEvent` 的 payload 明确不含 `resolve` 回调，仅含 `toolCallId`、`toolName`、`input`、`safetyLevel`；`AgentRunner` 接口新增 `confirmToolCall(toolCallId, approved)` 方法；`abort()` 文档中注明所有待决 confirm 以 `approved=false` 结算，完整覆盖 P1-01。

- **P1-02（Hook 阻断前历史未写入）**：Spec 2 第 4 节核心循环流程的第 0 步明确：`before_user_message` hook 执行在 `ConversationHistory.append()` 和磁盘写入之前，hook 退出码 2 时只 emit `hook_blocked`，不写历史不写盘，覆盖 P1-02 对 Spec 2 的要求。

- **P1-05（send() 状态机）**：Spec 2 第 6 节新增完整的三态状态机（`IDLE / STREAMING / ABORTING`）说明，`send()` 改为 `async`，带有等待旧流终止的逻辑，附伪代码示例，覆盖 P1-05。

- **P1-11（abort 未传播到 SubagentManager）**：Spec 2 第 3 节 `abort()` 的文档注释和第 6 节伪代码均包含 `subagentManager.cancelAll()` 的调用逻辑，验收标准也列明此项，覆盖 P1-11。

- **P2-04（ContextManager 事件发送权）**：Spec 2 第 5 节"Spec 3 接入后的迁移路径"明确规定由调用方（`AgentRunner` 或 `AgentOrchestrator`）在 `trimmedCount > 0` 时主动 emit `context_trimmed` 事件，`ContextManager` 保持无副作用，覆盖 P2-04。

- **P2-07（maxHistoryTokens 冗余）**：Spec 2 第 5 节新增"P2-07 说明"，明确本 Spec 不定义 `maxHistoryTokens`，上下文截断由 Spec 3 的 `ContextManager` 负责，以 `contextWindow` 为准，覆盖 P2-07。

- **P2-08（input_submitted 不属于 AgentEvent）**：Spec 2 第 2 节明确注明"`input_submitted` 不属于 `AgentEvent`（P2-08）"，并规定 UI 发起输入统一通过 `AgentRunner.send()` 调用，覆盖 P2-08。

- **P2-09（abort 快捷键）**：Spec 2 验收标准最后一条明确要求 Spec 4 定义 abort 的触发快捷键，且 `abort()` 须有可验证的 TUI 触发路径，覆盖 P2-09 对 Spec 2 的要求。

- **P2-13（streaming 中切换 session）**：Spec 2 第 5 节"P2-13 说明"明确规定 `switchSession()` 调用时若有 streaming 进行中，须先调用 `AgentRunner.abort()` 并等待状态机转为 `IDLE` 后再切换，覆盖 P2-13 对 Spec 2 的要求。

### 问题项

#### [RC2-01] 状态机伪代码中 send() 在 STREAMING 状态下 abort 后未 await 旧流终止

- **类型**：修复错误（伪代码逻辑缺陷）
- **描述**：Spec 2 第 6 节的状态机伪代码中，`send()` 在检测到 `STREAMING` 状态时调用 `this.abort()`，随后立即检查 `if (this.state === "ABORTING" && this.streamSettledPromise)`。但 `abort()` 内部将 `state` 同步置为 `"ABORTING"`，所以紧接的 `if` 判断会执行 `await this.streamSettledPromise`——这在逻辑上是可行的。然而，如果在 `abort()` 执行后、进入 `await` 之前，流已经立即完成并将 `state` 重置为 `"IDLE"`，此时 `this.state === "ABORTING"` 条件为假，`send()` 会跳过 `await` 直接继续，在此微任务间隙内可能产生短暂的双流并发。文档未说明 `streamSettledPromise` 何时被创建和重置，这个 Promise 的生命周期管理是缺失的关键实现细节。
- **建议**：在伪代码中补充 `streamSettledPromise` 的创建时机（在 `STREAMING` 进入时创建）和重置时机（在状态转回 `IDLE` 时 resolve 并置 null），确保 await 路径完整、无竞争窗口。或者将等待逻辑改为：只要 `state !== "IDLE"` 则 await，避免依赖时序假设。

#### [RC2-02] 验收标准缺少 provider_change_error 事件的测试项

- **类型**：遗漏修复
- **描述**：Spec 1 第 4 节在 P2-03 修复中新增了 `provider_change_error` 事件（持久化写入失败时 emit），但 Spec 2 的验收标准和附录的权威事件表均未收录该事件类型。该事件在 Spec 2 的联合类型 `AgentEvent` 定义中也缺席，造成已定义的事件类型无法通过 TypeScript 类型检查。
- **建议**：Spec 2 第 2 节的 `AgentEvent` 联合类型和附录的权威事件表中补充 `provider_change_error` 事件（`payload: { reason: string }`），并在验收标准中添加相应的测试项。

---

## Spec 3 复查结果

0-summary.md 中涉及 Spec 3 的问题：P0-01、P0-03、P1-02（共享）、P1-03、P1-04、P2-02、P2-04（共享）、P2-07（共享）、P2-12、P2-13（共享）、P2-16（部分）、P3-02、P3-05（部分）。

### 通过项

- **P0-01（AgentEvent 格式一致性）**：Spec 3 第 4 节明确声明"所有类型统一采用嵌套 `payload` 格式"，新增的 4 个事件类型（`session_created`、`session_switched`、`session_deleted`、`context_trimmed`）均采用 `{ type: "xxx"; payload: { ... } }` 格式，与权威定义一致，覆盖 P0-01。

- **P0-03（ConversationHistory 替代声明）**：Spec 3 第 3 节新增完整的替代关系声明，明确 `ConversationHistory` 被废弃，`AgentRunner` 改持 `SessionManager` 引用，并附有字段对比表（`HistoryEntry` vs `MessageRecord`），覆盖 P0-03 对 Spec 3 的要求。

- **P1-02（Hook 阻断写盘时机）**：Spec 3 第 8 节同步时机表格中明确规定"`before_user_message` hook 执行早于 `appendMessage()` 写盘"，并在下方注释说明 hook 阻断时消息不写入 JSONL 也不写入内存，且验收标准中有对应项，覆盖 P1-02 对 Spec 3 的要求。

- **P1-03（SubagentRunner 存储隔离）**：Spec 3 第 3 节新增"ephemeral 模式"段落，明确 `SessionManager` 支持 `ephemeral: true` 构造选项，该模式下 `appendMessage()` 只更新内存、不写磁盘，`SubagentRunner` 必须使用此模式，验收标准中有对应测试项，覆盖 P1-03。

- **P1-04（flushMeta 非原子竞态）**：Spec 3 第 5 节持久化实现规范明确了 4 条原子性保障：① SessionMeta 独立文件与 JSONL 分离；② 整体写操作使用"写临时文件 → fsync → rename 原子替换"模式；③ 异步互斥锁保证串行化；④ 启动时完整性扫描降级重建，完整覆盖 P1-04。

- **P2-02（system prompt token 未扣除）**：Spec 3 第 2 节裁剪触发条件中引入 `availableBudget = contextWindow - systemPromptTokenEstimate - replyReserve` 公式，`ContextConfig` 增加 `systemPromptTokenEstimate` 字段，默认值 500，Spec 8 注入后由上层传入，覆盖 P2-02。

- **P2-04（ContextManager 不自行 emit 事件）**：Spec 3 第 2 节明确 `buildPrompt()` 为纯计算函数，无副作用，不自行 emit 任何事件，由调用方在 `trimmedCount > 0` 后负责 emit，覆盖 P2-04。

- **P2-07（maxHistoryTokens 被取代）**：Spec 3 第 6 节配置项说明中明确 `contextWindow` 取代 Spec 2 的 `maxHistoryTokens`，并注明 Spec 2 相关描述仅为占位，覆盖 P2-07。

- **P2-12（context_trimmed 渲染路径）**：Spec 3 验收标准中明确注明"`context_trimmed` 事件须在 TUI 消息区渲染为浅灰色系统提示（由 Spec 4 实现），本 Spec 保证事件正确 emit"，将该职责明确分配给 Spec 4，覆盖 P2-12 对 Spec 3 的要求。

- **P2-13（streaming 中切换 session）**：Spec 3 第 3 节新增"switchSession() 前置 abort"段落，明确规定调用前若有 streaming 进行中必须先 abort 再切换，验收标准中有对应测试项，覆盖 P2-13 对 Spec 3 的要求。

- **P3-02（TUI 入口说明）**：Spec 3 第 3 节新增"TUI 入口（P3-02）"说明，明确 session 管理功能通过 Spec 4 定义的 Overlay 组件提供入口，本 Spec 仅定义后端 API，职责边界清晰，覆盖 P3-02 对 Spec 3 的要求。

### 问题项

#### [RC3-01] ephemeral 模式的 SessionManager 接口签名未定义构造选项

- **类型**：内部矛盾（实现描述缺失）
- **描述**：Spec 3 第 3 节正文描述 `SessionManager` 支持 `ephemeral: true` 构造选项，但第 3 节给出的 `SessionManager` 类接口签名中没有任何构造函数签名，也未定义接受 `ephemeral` 选项的工厂方法或构造参数。实现者无法从接口签名判断如何创建 ephemeral 模式的实例，与正文描述形成文档内部矛盾。
- **建议**：在 `SessionManager` 接口定义中补充构造函数签名，例如 `constructor(opts?: { ephemeral?: boolean; basePath?: string })` 或提供独立的工厂方法，使接口与正文描述自洽。

#### [RC3-02] P2-16 对 Spec 3 的要求（Hook stdout 落盘脱敏）未在 Spec 3 中体现

- **类型**：遗漏修复
- **描述**：0-summary.md 的 P2-16 涉及 Spec 3（`hook_completed.stdout` 可能经 Session JSONL 持久化，造成 API Key 落盘）。修订建议要求 Spec 3 中对落盘的 `hook_completed` 事件内容做脱敏处理。当前 Spec 3 中无任何关于 hook 事件内容落盘脱敏的说明，该风险在持久化实现规范中没有被提及。
- **建议**：Spec 3 的持久化实现规范（第 5 节）或同步时机（第 8 节）中补充说明：`hook_completed` 事件的 `stdout` 字段在写入 JSONL 之前，须经过 API Key 格式扫描和 `[REDACTED]` 替换；或明确声明 `hook_completed` 事件不写入 JSONL。

---

## 总结

**整体评价：** 三份 Spec 的修订工作完成度较高，P0-01、P0-02、P0-03 三条阻断级问题均已有效处理，P1 级别的大部分关键问题（P1-01、P1-02、P1-03、P1-04、P1-05、P1-09、P1-11）修复方向正确，修复实质性充分。P2 级别的大多数问题也已得到覆盖。

**发现的问题共 4 条：**

| 编号 | 所属 Spec | 类型 | 严重程度 | 简述 |
|------|-----------|------|----------|------|
| RC1-01 | Spec 1 | 新引入问题（跨 Spec 不一致） | 低（文档不同步，不影响实现） | Spec 1 的 `stream_done` payload 缺少 `stopReason` 字段，与 Spec 2 权威定义不一致 |
| RC2-01 | Spec 2 | 修复错误（伪代码逻辑缺陷） | 中（`streamSettledPromise` 生命周期未定义，可能导致实现出现竞争窗口） | 状态机伪代码中 `streamSettledPromise` 的创建和重置时机缺失 |
| RC2-02 | Spec 2 | 遗漏修复 | 中（会导致 TypeScript 类型检查失败） | `provider_change_error` 事件未纳入 `AgentEvent` 联合类型 |
| RC3-01 | Spec 3 | 内部矛盾 | 低（实现时需要自行推断构造方式） | `SessionManager` 接口签名缺少 `ephemeral` 构造选项定义 |
| RC3-02 | Spec 3 | 遗漏修复 | 低（安全问题，但 P2 级别，非阻断） | Hook stdout 落盘脱敏要求未在 Spec 3 持久化规范中体现 |

**优先处理建议：**
1. **RC2-02**（中）：`provider_change_error` 缺少类型定义会直接导致 TypeScript 编译失败，需在实现前补齐。
2. **RC2-01**（中）：`streamSettledPromise` 生命周期不明确会给实现者带来歧义，建议在 Spec 2 中补充说明。
3. **RC1-01**（低）：Spec 1 与 Spec 2 的 `stream_done` 定义不同步，建议更新 Spec 1 与权威源保持一致，避免阅读混乱。
4. **RC3-01**（低）、**RC3-02**（低）：可在 Spec 3 实现阶段同步补充。
