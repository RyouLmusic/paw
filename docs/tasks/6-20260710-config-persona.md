# Task: 系统提示 / Persona 配置

| 字段 | 值 |
|------|-----|
| 关联 Spec | docs/specs/6-20260710-config-persona.md |
| 状态 | pending |

---

## 任务清单

### T1 — 定义 Persona 类型与内置默认值

**文件：** `src/agent/persona/types.ts`

- 定义 `Persona` 接口：字段包括 `id`（唯一标识符）、`name`（展示名称）、`system_prompt`（支持插值变量的模板字符串）、`providerId`（可选，绑定特定 provider id）
- 定义并导出 `BUILTIN_DEFAULT_PERSONA` 常量（类型为 `Persona`）：`id: "__builtin__"`、`name: "默认"`、`system_prompt: "You are a helpful assistant."`，作为配置缺失时的兜底值
- 同文件内定义 `InterpolationContext` 接口（供 T2 导入使用）：字段包括 `date: string`（YYYY-MM-DD）、`time: string`（HH:mm:ss）、`cwd: string`（完整绝对路径）、`cwd_basename: string`（仅目录名）

**预期结果：** 类型定义清晰，可被 T2、T3 正确导入；`BUILTIN_DEFAULT_PERSONA` 满足 `Persona` 接口约束；`bunx tsc --noEmit` 通过。

---

### T2 — 实现变量插值引擎

**文件：** `src/agent/persona/interpolate.ts`

- 实现 `interpolate(template: string, ctx: InterpolationContext, allowCwd?: boolean): string` 函数：
  - 将模板字符串中的 `{{date}}` 替换为 `ctx.date`
  - 将 `{{time}}` 替换为 `ctx.time`
  - 将 `{{cwd}}` 替换为 `ctx.cwd`；若 `allowCwd` 为 `false`，则 `{{cwd}}` 保持原样不替换（`{{cwd_basename}}` 不受此限制）
  - 将 `{{cwd_basename}}` 替换为 `ctx.cwd_basename`
  - 未识别的变量名（如 `{{foo}}`）保持原样，不抛出错误
- 实现 `buildInterpolationContext(): InterpolationContext` 辅助函数：在调用时读取当前系统时间和 `process.cwd()`，构造 `InterpolationContext` 实例；此函数每次调用均返回最新值（保证 `{{date}}` 跨日期时反映实际日期）
- 强调调用时机：此函数设计为在每次向 LLM 发起请求前调用，不在加载配置时调用

**预期结果：** 所有支持的插值变量正确替换；`allowCwd: false` 时 `{{cwd}}` 不替换；未知变量不影响其他替换；`bunx tsc --noEmit` 通过。

---

### T3 — 实现 PersonaRegistry

**文件：** `src/agent/persona/registry.ts`

- 实现 `PersonaRegistry` 类，构造函数接收已加载的 persona 列表、`activePersonaId`、`allowCwd` 配置项和 `onEvent: (event: AgentEvent) => void` 回调（注入事件回调，不直接持有事件发射器）
- 实现四层优先级加载逻辑：
  - 第1层（最低）：`BUILTIN_DEFAULT_PERSONA` 兜底
  - 第2层：全局 `~/.paw/settings.json` 中 `activePersona` 对应的 persona
  - 第3层：项目本地 `.paw/settings.json` 中 `activePersona` 对应的 persona（完整覆盖，不合并）
  - 第4层（最高）：运行时临时覆盖（仅内存，不持久化）
- 实现 `active(): Persona`：返回当前活跃 persona（不插值，原始 persona 对象）
- 实现 `list(): Persona[]`：返回所有可用 persona 列表（不插值，供 TUI 展示）
- 实现 `switchTo(id: string): Promise<void>`：
  - 验证 id 存在，不存在时抛出带明确说明的错误
  - 通过 `SettingsWriter`（T4 实现）串行化写操作，将 `activePersona` 字段写回 `settings.json`（持久化）
  - 写入成功后，通过 `onEvent` 回调 emit `persona_changed` 事件（payload：`{ personaId, name, providerId? }`）
  - 若调用时有 streaming 进行中，此方法不负责终止 stream（由调用方 `AgentRunner` 先调用 `abort()`）
- 实现 `overrideSystemPrompt(prompt: string | null): void`：设置或清除第4层临时覆盖（仅内存，sync）；清除时传 `null` 回退到当前 persona 的 `system_prompt`
- 实现 `resolveSystemPrompt(): string`：按四层优先级获取最终 system prompt，调用 `interpolate()` 进行变量插值（使用当时的 `buildInterpolationContext()` 结果），返回最终字符串
- 处理配置缺失场景：`personas[]` 未定义或为空时使用 `BUILTIN_DEFAULT_PERSONA`，不崩溃；`activePersona` 引用不存在的 id 时，返回明确错误信息（非崩溃，降级到 `BUILTIN_DEFAULT_PERSONA` 并记录警告）
- 处理 `personas[].id` 重复：解析时检测并抛出解析错误

**预期结果：** 四层优先级规则正确实现；`switchTo()` 持久化写回并 emit 事件；配置缺失时优雅降级；`bunx tsc --noEmit` 通过。

---

### T4 — 实现 SettingsWriter（串行化配置写操作）

**文件：** `src/agent/config/settings-writer.ts`

- 实现 `SettingsWriter` 类，用于串行化所有对 `settings.json` 的写操作，防止 Spec 1 provider 切换与本 Spec persona 切换并发写冲突
- 内部使用队列（Promise 链）确保写操作严格串行执行：即使多个写操作并发调用，也依次排队执行，不并发写文件
- 实现核心方法 `write(updater: (current: PawSettings) => PawSettings): Promise<void>`：
  - 加入串行队列
  - 读取当前 `settings.json` 内容（使用 `Bun.file` 读取）
  - 调用 `updater` 函数生成新的 settings 对象
  - 将新内容写回文件（使用 `Bun.write`）
- 此组件供 `PersonaRegistry.switchTo()` 和 Spec 1 `ProviderRegistry.switchProvider()` 共用，两者均通过此组件写入 `settings.json`，确保不发生写冲突
- 提供 `SettingsWriter` 的单例获取方式（或在 `AgentRunner` 中统一实例化后注入），避免多处实例化导致队列失效

**预期结果：** 并发调用 `write()` 时，写操作严格串行；文件内容不丢失；`bunx tsc --noEmit` 通过。

---

### T5 — 扩展 AgentEvent，新增 2 个 Persona 相关事件类型

**文件：** `src/agent/events.ts`

- 新增 `PersonaChangedEvent`：`type: "persona_changed"`，payload 包含 `personaId: string`、`name: string`、`providerId?: string`
- 新增 `SystemPromptOverrideEvent`：`type: "system_prompt_override"`，payload 包含 `preview: string`（覆盖内容的首 100 字符预览，用于日志和 UI 展示）
- 将以上 2 个新接口追加到 `AgentEvent` 联合类型

**预期结果：** 2 个新事件加入 `AgentEvent`；现有监听方不受影响；`bunx tsc --noEmit` 通过。

---

### T6 — 更新 AgentRunner 和 AgentOrchestrator，接入 PersonaRegistry

**文件：**
- `src/agent/runner.ts`
- `src/agent/orchestrator.ts`

**runner.ts：**
- 在 `AgentRunner` 构造时初始化 `PersonaRegistry` 实例（注入 settings 中的 persona 配置、`SettingsWriter` 实例和事件回调）
- 监听 `persona_changed` 事件：若 `payload.providerId` 存在，调用 `ProviderRegistry.switchProvider(payload.providerId)`（通过事件驱动实现 provider 联动，`PersonaRegistry` 不直接感知 `ProviderRegistry`）
- 更新 `abort()` 方法：在终止 stream 后允许外部调用 `PersonaRegistry.switchTo()`（`abort()` 本身不调用 switchTo，顺序由 UI 层保证）
- 在 `AgentRunner` 对外接口中暴露 `PersonaRegistry` 的必要方法（如 `listPersonas()`、`switchPersona(id)`、`overrideSystemPrompt()`），或通过代理方法转发

**orchestrator.ts（system prompt 组装）：**
- 在每次 `run()` 方法的请求构建阶段，调用 `PersonaRegistry.resolveSystemPrompt()` 获取最终 system prompt（含四层优先级处理 + 变量插值）
- 将 system prompt 作为 `system` 字段（或 `role: "system"` 消息，视各 provider 协议而定）传入 `provider.stream()` 调用
- 确保每次请求均重新调用 `resolveSystemPrompt()`，保证插值变量（如 `{{date}}`）每次反映实时值

**预期结果：** Persona 切换正确联动 provider 切换；每次请求携带最新的插值后 system prompt；`bunx tsc --noEmit` 通过。

---

### T7 — 更新 UI 组件，接入 Persona 浮层

**文件：**
- `src/App.tsx`（或对应的 TUI 根组件文件）
- `src/components/Sidebar.tsx`（或对应的侧边栏组件文件）

**Sidebar.tsx：**
- 在 provider 信息下方新增一行，展示当前活跃 persona 的 `name`（显示上限 18 字符，超出截断加 `…`）
- 监听 `persona_changed` 事件，收到后更新 persona 名称显示

**App.tsx（或根组件）：**
- 注册 `Shift+P` 快捷键（与 Spec 4 快捷键表一致，`p` 键已被 provider 切换占用）：触发时打开 Persona 选择浮层
- 复用 Spec 4 的通用 `Overlay` 容器组件，传入 persona 数据源，与 provider 切换浮层保持视觉一致
- 浮层展示 `personas[]` 列表，每项显示 `name`；若该 persona 有 `providerId` 绑定，追加展示绑定的 provider label
- 用户在浮层选中 persona 后：
  - 调用 `AgentRunner.switchPersona(id)`（内部调用 `PersonaRegistry.switchTo()`）
  - 若当前有 streaming 进行中，先调用 `AgentRunner.abort()` 终止，再执行切换
  - 关闭浮层
- 监听 `persona_changed` 事件：若 `payload.providerId` 存在，同时更新 Sidebar 的 provider 显示

**预期结果：** TUI 内可通过 `Shift+P` 打开 Persona 浮层并切换；切换绑定了 `providerId` 的 persona 时，provider 联动切换（通过事件驱动）；Sidebar 实时展示当前 persona 名称；`bunx tsc --noEmit` 通过。

---

## 执行顺序

```
T1
├─→ T2（依赖 T1，插值引擎实现独立）
├─→ T3（依赖 T1 和 T2，T2 完成后才能调用 interpolate）
└─→ T4（独立，仅依赖 Bun 文件 API，可与 T2 T3 并行）
    └─→ T5（T3 T4 均完成后：PersonaRegistry 需要 SettingsWriter；事件类型需要先定义）
        └─→ T6（依赖 T3 T5，接入事件和 PersonaRegistry）
            └─→ T7（依赖 T6，UI 组件最后实现）
```

可并行执行的阶段：
- **第一批（并行）**：T2、T3（依赖 T1 完成后）和 T4（独立，可最早开始）
- **注意**：T3 必须在 T2 完成后才能开始（T3 内部调用 `interpolate()`）
- **顺序**：T5 → T6 → T7

---

## 完成记录

| 任务 | 状态 | 验证结果 |
|------|------|----------|
| T1 — 定义 Persona 类型 | pending | — |
| T2 — 实现插值引擎 | pending | — |
| T3 — 实现 PersonaRegistry | pending | — |
| T4 — 实现 SettingsWriter | pending | — |
| T5 — 扩展 AgentEvent | pending | — |
| T6 — 更新 Runner 和 Orchestrator | pending | — |
| T7 — 更新 UI 组件 | pending | — |
