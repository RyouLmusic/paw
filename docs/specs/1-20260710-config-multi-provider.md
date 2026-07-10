# Spec: 多 Provider LLM 配置与运行时切换

| 字段 | 值 |
|------|-----|
| 状态 | approved |
| 修订日期 | 2026-07-10（review 修复）|
| 日期 | 2026-07-10 |
| 风险级别 | 高 |

---

## 背景 / 目标 / 范围

### 背景

paw 当前无任何 LLM 接入逻辑。用户需要同时使用多家 LLM 提供商（OpenAI、Anthropic、Azure OpenAI、Ollama/LM Studio、DeepSeek/Kimi 等兼容 OpenAI 协议的第三方端点），不同 provider 的鉴权方式和 API 协议存在差异。

### 目标

1. 定义统一的 provider 配置结构，存储于 `~/.paw/settings.json`
2. 实现 provider 注册与路由层，屏蔽各 provider 的协议差异
3. 支持 streaming（必须）
4. 支持 TUI 内运行时切换 provider/model
5. 差异化展示 LLM 错误类型（key 无效 / 网络超时 / rate limit / 其他）

### 包含

- `~/.paw/settings.json` 配置 schema 定义
- provider 抽象接口 `LLMProvider`
- 五类 provider 实现：OpenAI-compat / Anthropic / Azure OpenAI / Ollama / 自定义端点
- `ProviderRegistry`：加载配置 + 路由到对应实现
- `AgentEvent` 扩展：`stream_chunk` / `stream_done` / `stream_error` / `provider_changed`
- TUI 切换 UI（provider/model 选择）

### 不包含

- GUI 配置编辑器（settings.json 由用户手动编辑）
- 多轮对话上下文管理（独立需求）
- 费用统计 / token 计量

---

## 技术方案

### 1. 配置加载优先级

优先读取 `./.paw/settings.json`（项目本地），不存在时回退到 `~/.paw/settings.json`（全局）。两者均不存在则显示友好引导提示。

**安全警告——本地 `hooks` 字段确认机制（P1-09）：**

检测到项目本地 `.paw/settings.json` 含 `hooks` 字段时，启动时必须在 TUI 消息区展示醒目警告，逐条列出 `hooks` 中的所有命令，并要求用户交互确认（`y` 继续加载，`n` 跳过本地 hooks 仅加载非 hooks 字段，`q` 中止启动）。

```
⚠️  检测到项目本地 .paw/settings.json 含 hooks 配置：
    on_session_start: "sh ./scripts/init.sh"
    before_tool_call: "python3 ./hooks/check.py"
是否信任并加载上述 hook 命令？[y/N/q]
```

支持在 `~/.paw/settings.json` 配置 `trustedProjectDirs` 白名单，列表中的目录路径将自动跳过确认：

```json
{
  "trustedProjectDirs": [
    "/Users/br.huang/workspace/paw",
    "/Users/br.huang/workspace/my-project"
  ]
}
```

### 2. `~/.paw/settings.json` 结构

```json
{
  "activeProvider": "anthropic-default",
  "providers": [
    {
      "id": "openai-default",
      "type": "openai",
      "label": "OpenAI",
      "apiKey": "sk-...",
      "model": "gpt-4o",
      "baseURL": "https://api.openai.com/v1"
    },
    {
      "id": "anthropic-default",
      "type": "anthropic",
      "label": "Anthropic",
      "apiKey": "sk-ant-...",
      "model": "claude-sonnet-5"
    },
    {
      "id": "azure-gpt4",
      "type": "azure",
      "label": "Azure GPT-4",
      "apiKey": "...",
      "model": "gpt-4",
      "baseURL": "https://<resource>.openai.azure.com",
      "azureDeployment": "my-gpt4-deploy",
      "azureApiVersion": "2024-02-01"
    },
    {
      "id": "ollama-local",
      "type": "ollama",
      "label": "Ollama (本地)",
      "model": "llama3",
      "baseURL": "http://localhost:11434"
    },
    {
      "id": "deepseek",
      "type": "openai-compat",
      "label": "DeepSeek",
      "apiKey": "sk-...",
      "model": "deepseek-chat",
      "baseURL": "https://api.deepseek.com/v1"
    }
  ]
}
```

**字段规则：**
- `type` 枚举：`"openai"` | `"anthropic"` | `"azure"` | `"ollama"` | `"openai-compat"`
- `ollama` 无需 `apiKey`
- `openai-compat` 与 `openai` 结构相同，语义上标识第三方兼容端点
- `baseURL` 在 `openai` / `azure` / `ollama` / `openai-compat` 中有意义；`anthropic` 可省略（走官方端点）

**API Key 文件权限安全规范（P2-15）：**

- 首次生成 `~/.paw/settings.json` 时，自动执行 `chmod 600`（仅文件所有者可读写）
- 每次启动时校验文件权限，若不满足 `0600` 则在 TUI 消息区输出警告：
  ```
  ⚠️  ~/.paw/settings.json 权限为 644，建议执行 chmod 600 以保护 API Key
  ```
- `~/.paw/settings.json` 文件头部需包含注释提醒（JSON 不支持注释，在文档和引导提示中说明）：**不要将此文件提交到版本控制系统**
- 长期规划：提供可选 OS Keychain 后端，配置文件只保留引用 ID（`apiKeyRef`），`apiKey` 字段变为可选

### 3. Provider 抽象接口

```ts
// src/agent/provider/types.ts

export interface StreamChunk {
  delta: string          // 本次增量文本
  done: boolean
}

export interface LLMProvider {
  readonly id: string
  readonly label: string
  readonly model: string
  // 返回 AsyncIterable，每次 yield 一个 StreamChunk
  stream(messages: ChatMessage[]): AsyncIterable<StreamChunk>
}
```

### 4. Provider 实现分层

```
src/agent/provider/
├── types.ts                  # LLMProvider 接口 + 配置类型
├── registry.ts               # ProviderRegistry（加载 settings + 路由）
├── impl/
│   ├── openai.ts             # OpenAI（含 openai-compat，复用）
│   ├── anthropic.ts          # Anthropic（纯 fetch + SSE，手写事件解析）
│   ├── azure.ts              # Azure OpenAI（继承 openai.ts 逻辑）
│   └── ollama.ts             # Ollama（OpenAI-compat 端点）
└── errors.ts                 # LLMError 类型定义
```

**错误分类（`errors.ts`）：**

```ts
export type LLMErrorKind =
  | "auth_failed"       // 401 / invalid key
  | "rate_limited"      // 429
  | "network_timeout"   // 请求超时
  | "model_not_found"   // 404 / 模型不存在
  | "server_error"      // 5xx
  | "unknown"
```

**ProviderRegistry 行为规范：**

`switchProvider()` 竞态语义（P2-01）：若调用 `switchProvider()` 时有进行中的 stream，必须先触发 abort 终止当前 stream，再执行 provider 切换。切换立即生效（不是"下次请求生效"）。

`switchProvider()` 持久化语义（P2-03）：切换完成后立即异步写回配置文件的 `activeProvider` 字段（持久化到 `settings.json`）。写文件为 async 操作；写入失败时 emit `provider_change_error` 事件（payload 含 `reason: string`），本次切换内存状态仍保持，但需在 TUI 中展示警告提示用户持久化失败。

**SSE ReadableStream 泄漏防范（P2-17）：**

所有 provider 实现（`impl/*.ts`）中的 `parseStream` generator 函数必须包含 `try/finally` 块，确保 abort 或异常中断后 `ReadableStream` 被显式取消：

```ts
async function* parseStream(response: Response): AsyncIterable<StreamChunk> {
  try {
    // ... 正常 SSE 解析逻辑
    for await (const chunk of reader) {
      yield parseChunk(chunk)
    }
  } finally {
    // 无论正常结束还是 abort，均显式取消 ReadableStream
    await response.body?.cancel()
  }
}
```

验收标准须包含：100 次快速 abort 后无悬挂连接（通过 `netstat` 或测试验证）。

### 5. AgentEvent 扩展

> 全量 AgentEvent 权威定义见 `src/agent/events.ts`，此处仅列本 Spec 新增类型。

```ts
// src/agent/events.ts（本 Spec 新增类型，采用嵌套 payload 形式）

| type              | payload 类型                                         | 触发时机             |
|-------------------|------------------------------------------------------|----------------------|
| stream_chunk      | { delta: string }                                    | 每个 token 到达      |
| stream_done       | { totalText: string; stopReason: "stop" \| "tool_use" } | 流完整结束        |
| stream_error      | { kind: LLMErrorKind; message: string }              | 流过程出错           |
| provider_changed  | { providerId: string; model: string }                | 用户切换 provider    |
```

类型结构示例：

```ts
{ type: "stream_chunk"; payload: { delta: string } }
{ type: "stream_done"; payload: { totalText: string; stopReason: "stop" | "tool_use" } }
{ type: "stream_error"; payload: { kind: LLMErrorKind; message: string } }
{ type: "provider_changed"; payload: { providerId: string; model: string } }
```

### 6. TUI 切换交互

- 左侧边栏底部显示当前 `provider.label` 和 `model`
- `provider.label` 展示上限 18 字符，`model` 展示上限 20 字符，超出部分截断并追加 `…`
- 快捷键 `p` 打开 provider 选择浮层（overlay box）
- 选中后发送 `provider_changed` 事件，UI 更新显示，后续请求走新 provider

---

## 验收标准

- [ ] `~/.paw/settings.json` 不存在时，给出友好提示（非崩溃）
- [ ] settings.json 格式错误时，显示具体字段错误
- [ ] 五类 provider 均可发起 streaming 请求并逐字渲染到 TUI
- [ ] `auth_failed` 显示"API Key 无效，请检查配置"
- [ ] `rate_limited` 显示"请求过于频繁，请稍后重试"
- [ ] `network_timeout` 显示"连接超时，请检查网络或 baseURL"
- [ ] `model_not_found` 显示"模型不存在，请确认 model 名称"
- [ ] TUI 内可通过快捷键切换 provider，切换即时生效
- [ ] `activeProvider` 指向不存在的 id 时，给出明确错误
- [ ] `bunx tsc --noEmit` 通过

## 验证方式

1. `bun run dev` 手动验证各 provider streaming
2. `bunx tsc --noEmit` 类型检查通过
3. 手动构造错误场景（错误 key、断网）验证差异化提示

## 回滚策略

provider 层完全解耦于 UI，回滚只需移除 `src/agent/provider/` 目录及 `AgentEvent` 新增类型，App.tsx 的现有占位逻辑不受影响。

---

## 配置缺失处理（首次启动引导）

`settings.json` 不存在时，paw 在 TUI 启动后的消息区统一展示引导提示（不使用 stderr），引导内容包含示例配置路径和最简配置结构：

```
欢迎使用 paw！检测到尚未创建配置文件。

请创建 ~/.paw/settings.json，最简配置如下：

  {
    "activeProvider": "my-openai",
    "providers": [
      {
        "id": "my-openai",
        "type": "openai",
        "label": "OpenAI",
        "apiKey": "sk-...",
        "model": "gpt-4o"
      }
    ]
  }

配置文件路径：~/.paw/settings.json
注意：请勿将此文件提交到版本控制系统（如 git），该文件含有敏感 API Key。

创建完成后重新启动 paw 即可开始使用。
```

若配置文件存在但格式错误（JSON 解析失败或字段不合规），在消息区展示具体字段错误位置，不崩溃退出。
