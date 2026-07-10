# Spec: 系统提示 / Persona 配置

| 字段 | 值 |
|------|-----|
| 状态 | approved |
| 日期 | 2026-07-10 |
| 修订日期 | 2026-07-10（review 修复）|
| 风险级别 | 中 |

> **风险判定理由：** 本 Spec 新增两个 `AgentEvent` 类型（`persona_changed`、`system_prompt_override`），修改 `PawSettings` schema 及配置加载入口逻辑（`registry.ts` 需同时解析 persona），并新增 TUI 内的 Persona 切换浮层组件。变更范围集中在 config 层与 agent-UI 事件接口，不更换渲染框架、不引入外部服务鉴权、不修改已有事件的 payload 结构，因此评级为"中"。

---

## 背景 / 目标 / 范围

### 背景

Spec 1（多 Provider 配置）已定义 `activeProvider` / `providers[]`，但 settings.json 中尚无 system prompt 相关字段。当前所有对话均无系统提示，用户无法为不同工作场景（代码审查、写作助手、翻译等）切换不同的 Persona，也无法在 system prompt 中引用运行时上下文（当前日期、工作目录等）。

### 目标

1. 定义 Persona 的数据结构与配置 schema（扩展 `settings.json`）
2. 建立四层 system prompt 优先级规则，确保各层可独立覆盖
3. 支持 system prompt 中的变量插值（`{{date}}`、`{{cwd}}` 等）
4. 支持 TUI 内运行时切换 Persona（类似 provider 切换交互）
5. 支持 per-project Persona 覆盖（`.paw/settings.json` 优先于全局）
6. Persona 可选绑定特定 provider，切换 Persona 时自动联动切换 provider

### 包含

- `PawSettings` schema 扩展：新增 `activePersona` / `personas[]` 字段
- `Persona` 类型定义
- System prompt 四层优先级规则与合并逻辑
- 变量插值引擎（`{{date}}`、`{{cwd}}`、`{{time}}`）
- 新增 `AgentEvent`：`persona_changed`、`system_prompt_override`
- TUI Persona 切换浮层组件
- per-project `.paw/settings.json` 中的 Persona 覆盖机制

### 不包含

- Persona 的 GUI 编辑器（settings.json 仍由用户手动编辑）
- 基于 Persona 的多轮对话历史隔离（独立需求）
- 自定义插值变量（用户自定义 `{{foo}}`）
- Persona 云端同步 / 导入导出

---

## 技术方案

### 1. System Prompt 四层优先级

优先级由低到高，高优先级完整覆盖低优先级（不做字符串拼接）：

```
第1层（最低）: 内置默认 system prompt（硬编码于源码，保底兜底）
第2层:         ~/.paw/settings.json 全局 activePersona 的 system_prompt
第3层:         .paw/settings.json 项目本地 activePersona 的 system_prompt
第4层（最高）: 运行时临时覆盖（session 内生效，不写回磁盘）
```

**层级说明：**
- 第1层仅在 settings.json 未定义任何 persona 时生效，防止空白 system prompt。
- 第2层和第3层通过 Spec 1 已有的"项目本地优先"机制自然实现：加载哪份 `settings.json`，就使用其中的 `activePersona`。
- 第3层（项目本地）与第2层（全局）的关系：若 `.paw/settings.json` 存在且定义了 `activePersona`，则完整使用该 Persona 的 `system_prompt`，不再回退到全局。
- 第4层通过新的 `AgentEvent` 类型 `system_prompt_override` 触发，Agent 层接收后更新当前 session 的 system prompt，不修改 settings.json。

### 2. Persona 类型定义

```ts
// src/agent/persona/types.ts

export interface Persona {
  /** 唯一标识符，用于 activePersona 引用 */
  id: string
  /** 展示名称（TUI 浮层显示） */
  name: string
  /** System prompt 模板，支持插值变量 */
  system_prompt: string
  /** 可选：绑定特定 provider id；切换到此 Persona 时自动联动切换 provider */
  providerId?: string
}

/** 内置默认 Persona（硬编码兜底） */
export const BUILTIN_DEFAULT_PERSONA: Persona = {
  id: "__builtin__",
  name: "默认",
  system_prompt: "You are a helpful assistant.",
}
```

### 3. settings.json Schema 扩展

在 Spec 1 的 schema 基础上新增 `activePersona` 和 `personas[]`：

```json
{
  "activeProvider": "anthropic-default",
  "providers": [ ],

  "activePersona": "default",
  "personas": [
    {
      "id": "default",
      "name": "默认助手",
      "system_prompt": "You are a helpful assistant. Today is {{date}}."
    },
    {
      "id": "coder",
      "name": "代码专家",
      "system_prompt": "You are an expert programmer. Current working directory: {{cwd}}. Today is {{date}}.",
      "providerId": "openai-default"
    },
    {
      "id": "writer",
      "name": "写作助手",
      "system_prompt": "You are a professional writing assistant. Current time: {{time}}."
    }
  ],
  "interpolation": {
    "allowCwd": true
  }
}
```

**字段规则：**
- `activePersona`：引用 `personas[].id`，不存在时给出明确错误（同 `activeProvider` 的处理方式）。
- `personas`：数组，每项必须包含 `id`、`name`、`system_prompt`；`providerId` 可选。
- `personas` 为空数组或字段缺失时，回退到内置默认 Persona。
- `id` 在同一 settings.json 内必须唯一。
- `interpolation.allowCwd`：默认 `true`；设为 `false` 时全局禁用 `{{cwd}}` 插值（见第 5 节）。

### 4. per-project Persona 覆盖机制

`.paw/settings.json`（项目本地）与 `~/.paw/settings.json`（全局）保持**独立 persona 命名空间**，不做合并。

规则：
- 存在 `.paw/settings.json` 且含有 `personas[]` → 完整使用项目本地 personas，忽略全局 personas。
- 存在 `.paw/settings.json` 但**不含** `personas[]` → 回退到全局 personas。
- 项目本地 `activePersona` 只在项目本地 personas 中查找；全局 `activePersona` 只在全局 personas 中查找。

此设计避免 id 冲突与隐式合并带来的歧义，行为与 Spec 1 中 provider 配置的项目本地优先原则一致。

### 5. 变量插值引擎

```ts
// src/agent/persona/interpolate.ts

export interface InterpolationContext {
  date: string        // 格式：YYYY-MM-DD
  time: string        // 格式：HH:mm:ss
  cwd: string         // process.cwd() 完整绝对路径
  cwd_basename: string // path.basename(process.cwd()) 仅目录名
}

/**
 * 将 system_prompt 模板中的 {{variable}} 替换为运行时值。
 * 在每次向 LLM 发起请求前调用，不在加载配置时调用。
 * 未识别的变量名保持原样（不抛出错误）。
 * 若 interpolation.allowCwd 配置为 false，{{cwd}} 变量将保持原样不替换。
 */
export function interpolate(template: string, ctx: InterpolationContext): string
```

**支持的变量（初版）：**

| 变量 | 替换值 | 备注 |
|------|--------|------|
| `{{date}}` | 当前日期，`YYYY-MM-DD` | |
| `{{time}}` | 当前时间，`HH:mm:ss` | |
| `{{cwd}}` | `process.cwd()` 的绝对路径 | ⚠️ 含用户名，见隐私说明 |
| `{{cwd_basename}}` | `path.basename(process.cwd())`，仅目录名 | 隐私友好替代选项 |

**`{{cwd}}` 隐私说明：**

`{{cwd}}` 展开为 `process.cwd()` 的完整绝对路径（如 `/Users/br.huang/workspace/paw`），该路径通常**包含本机用户名**，会随每次 LLM 请求明文发送给第三方服务商（OpenAI、Anthropic 等）。在企业安全合规或个人隐私场景下，建议改用 `{{cwd_basename}}` 替代（仅发送目录名，不含上级路径及用户名）。

可在 `settings.json` 中配置 `interpolation.allowCwd: false` 全局禁用 `{{cwd}}` 变量（此时 `{{cwd}}` 保持原样不替换；`{{cwd_basename}}` 不受此配置影响）：

```json
{
  "interpolation": {
    "allowCwd": false
  }
}
```

**调用时机：** 每次向 provider 发起 `stream()` 请求之前，在构建 `messages` 数组时对 system prompt 进行插值，确保 `{{date}}` 始终是当次请求的实际日期。

### 6. AgentEvent 扩展

在 Spec 1 已有事件基础上新增以下两个类型。**全量权威定义见 `src/agent/events.ts`，此处仅列本 Spec 新增类型**：

```ts
// src/agent/events.ts（新增条目）
// 采用嵌套 payload 格式，与全局 AgentEvent 协议保持一致

{ type: "persona_changed"; payload: { personaId: string; name: string; providerId?: string } }
{ type: "system_prompt_override"; payload: { preview: string } }
```

**事件语义：**
- `persona_changed`：由 `PersonaRegistry.switchTo()` emit，`AgentRunner` / `AgentOrchestrator` 监听该事件；若 `payload.providerId` 存在，由 `AgentRunner` / `AgentOrchestrator` 调用 `switchProvider()` 完成 provider 联动（`PersonaRegistry` 不直接感知 `ProviderRegistry`，模块间解耦）。
- `system_prompt_override`：Agent 层接收后仅更新内存中的 system prompt，不修改 settings.json，session 结束后失效（第4层临时覆盖）。`preview` 字段为覆盖内容的首 100 字符预览，用于日志和 UI 展示。

**Persona 与 Provider 联动的事件驱动路径（P2-05 修复）：**

```
用户在浮层选择绑定了 providerId 的 Persona
        │
        ▼
PersonaRegistry.switchTo(id)
  ├─ 写回 settings.json activePersona（持久化，通过 SettingsWriter）
  └─ emit persona_changed { personaId, name, providerId }
        │
        ▼
AgentRunner / AgentOrchestrator 监听 persona_changed
  └─ 若 payload.providerId 存在
        └─ 调用 ProviderRegistry.switchProvider(providerId)
                └─ emit provider_changed（复用 Spec 1 已有事件）
```

`PersonaRegistry` 不持有 `ProviderRegistry` 引用，符合分层原则（provider 为基础层，persona 为 config 层）。

### 7. PersonaRegistry 接口设计

```ts
// src/agent/persona/registry.ts

export interface PersonaRegistry {
  /** 获取当前活跃 Persona（已完成变量插值） */
  active(): Persona
  /** 获取所有可用 Persona 列表（不插值，用于 TUI 展示） */
  list(): Persona[]
  /**
   * 切换活跃 Persona。
   * 【async，持久化：写回 settings.json，重启后生效】
   * 切换后立即写回 settings.json 的 activePersona 字段（持久化）。
   * 通过统一的 SettingsWriter 组件串行化写操作，避免与 Spec 1 provider 切换并发写冲突。
   * emit persona_changed 事件（完整 payload：{ personaId: string; name: string; providerId?: string }），
   * 由 AgentRunner / AgentOrchestrator 监听后调用 switchProvider() 完成 provider 联动。
   *
   * 若调用时有 streaming 进行中，必须先调用 AgentRunner.abort() 终止当前 stream，
   * 再执行 Persona 切换（立即生效，不等待 stream 结束）。
   */
  switchTo(id: string): Promise<void>
  /**
   * 运行时临时覆盖 system prompt（第4层）；传 null 清除覆盖，回退到 Persona 的 system_prompt。
   * 【sync，仅内存：本次会话有效，重启失效，不写回 settings.json】
   */
  overrideSystemPrompt(prompt: string | null): void
  /** 获取最终生效的 system prompt（经过四层优先级处理 + 变量插值） */
  resolveSystemPrompt(): string
}
```

### 8. System Prompt 最终组装（P2-06）

system prompt 的最终组装由 `AgentOrchestrator` 在每次请求构建阶段执行，步骤如下：

1. `PersonaRegistry.resolveSystemPrompt()` → 获取 persona system prompt（含四层优先级处理 + 变量插值）
2. `MemoryStore.load()` → 加载当前 session 的 memory 条目（详见 Spec 8）
3. `MemoryInjector.buildBlock(entries)` → 将 memory 条目构建为结构化 memory 块
4. 拼接最终 system prompt：`personaSystemPrompt + "\n\n" + memoryBlock`

此组装逻辑位于 `AgentOrchestrator` 的**请求构建阶段**（每次 `send()` 触发的 LLM 请求构建时执行），保证 `{{date}}` 等插值变量每次反映实时值，memory 块使用最新条目。

### 9. TUI Persona 切换交互

- 左侧边栏底部在 provider 信息下方增加一行，展示当前 `persona.name`（Sidebar 展示上限为 **18 字符**，超出截断加 `…`，详见 Spec 4 Section Sidebar 布局）。
- 快捷键 `Shift+P` 打开 Persona 选择浮层（**此键位已在 Spec 4 Section 3 快捷键表中注册**；`p` 键已被 provider 切换占用，故选用 `Shift+P` 避免冲突）。
- Persona 选择浮层**复用 Spec 4 的通用 `Overlay` 容器组件**，传入 Persona 数据源，与 provider 切换浮层保持视觉一致。
- 浮层显示 `personas[]` 列表，每项显示 `name`（若有 `providerId` 绑定，追加显示绑定的 provider label）。
- 选中后调用 `PersonaRegistry.switchTo()`，emit `persona_changed` 事件；若该 Persona 绑定了 `providerId`，UI 同时更新 provider 显示。

### 10. 配置缺失处理

若 `personas[]` 未定义或为空，系统自动回退到内置默认 Persona（`BUILTIN_DEFAULT_PERSONA`），并在 **TUI 消息区**展示系统提示：

```
未配置 Persona，使用内置默认 system prompt
```

此提示风格与 Spec 1 / Spec 8 的配置缺失提示保持一致（均在 TUI 消息区展示，而非 stderr）。

### 11. 文件结构

```
src/agent/persona/
├── types.ts          # Persona 类型 + BUILTIN_DEFAULT_PERSONA
├── registry.ts       # PersonaRegistry 实现
└── interpolate.ts    # 变量插值引擎
```

---

## 验收标准

- [ ] `personas[]` 未定义或为空时，自动使用内置默认 Persona，不崩溃
- [ ] 首次启动无 Persona 配置时，TUI 消息区展示"未配置 Persona，使用内置默认 system prompt"
- [ ] `activePersona` 引用不存在的 id 时，给出明确错误信息（非崩溃）
- [ ] `personas[].id` 在同一 settings.json 内重复时，给出解析错误
- [ ] `{{date}}`、`{{time}}`、`{{cwd}}`、`{{cwd_basename}}` 在 system prompt 中正确替换
- [ ] `interpolation.allowCwd: false` 时，`{{cwd}}` 保持原样不替换，`{{cwd_basename}}` 正常替换
- [ ] 未识别的插值变量（如 `{{foo}}`）保持原样，不报错
- [ ] 插值在每次请求前执行，`{{date}}` 跨日期使用时反映当次请求的实际日期
- [ ] TUI 内可通过 `Shift+P` 快捷键打开 Persona 浮层并切换，切换即时生效
- [ ] 切换到绑定了 `providerId` 的 Persona 时，provider 自动联动切换（通过事件驱动，不直接调用 ProviderRegistry）
- [ ] `PersonaRegistry.switchTo()` 切换后写回 settings.json 的 `activePersona` 字段（持久化）
- [ ] 并发调用 `switchTo()` 和 Spec 1 的 `switchProvider()` 时，通过 `SettingsWriter` 串行化，settings.json 不发生写冲突
- [ ] `.paw/settings.json` 中定义的 Persona 优先于 `~/.paw/settings.json` 中的 Persona
- [ ] `.paw/settings.json` 不含 `personas[]` 时，回退到全局 Persona，不报错
- [ ] `system_prompt_override` 事件触发后，后续请求使用覆盖的 prompt；session 重启后不持久
- [ ] `bunx tsc --noEmit` 通过

---

## 验证方式

1. `bun run dev` 启动 TUI，手动验证各 Persona 的 system prompt 是否在 stream 请求中正确传递（可通过 Ollama 本地端点抓包或日志确认）
2. 修改 `{{date}}` 插值，验证每次请求的日期反映实时日期
3. 配置带 `providerId` 的 Persona，切换后验证 provider 联动切换（通过 `persona_changed` 事件驱动，而非直接调用）
4. 构造 `activePersona` 指向不存在 id 的 settings.json，验证错误提示
5. 同时存在 `.paw/settings.json` 和 `~/.paw/settings.json`，验证项目本地 Persona 优先
6. 配置 `interpolation.allowCwd: false`，验证 `{{cwd}}` 不替换，`{{cwd_basename}}` 正常替换
7. `bunx tsc --noEmit` 类型检查通过

---

## 回滚策略

Persona 层完全独立于已有 provider 层和 UI 渲染层。回滚只需：
1. 移除 `src/agent/persona/` 目录
2. 从 `src/agent/events.ts` 中删除 `persona_changed` 和 `system_prompt_override` 两个事件类型
3. 从 `PawSettings` 中移除 `activePersona` / `personas[]` / `interpolation` 字段（schema 向后兼容，旧 settings.json 不含这些字段时行为不变）
4. 移除 TUI 中 Persona 切换浮层组件

已有 provider 切换逻辑、stream 逻辑、UI 渲染主体均不受影响。
