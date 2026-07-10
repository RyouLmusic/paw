# Task: 多 Provider LLM 配置与运行时切换

| 字段 | 值 |
|------|-----|
| 关联 Spec | docs/specs/1-20260710-config-multi-provider.md |
| 状态 | pending |

---

## 任务清单

### T1 — 定义类型与错误枚举

**文件：**
- `src/agent/provider/types.ts`
- `src/agent/provider/errors.ts`

**`types.ts` 要做什么：**
- 定义 `ChatMessage` 接口，包含 `role`（`"user" | "assistant" | "system"`）和 `content`（`string`）字段
- 定义 `StreamChunk` 接口，包含 `delta: string` 和 `done: boolean` 字段
- 定义 `LLMProvider` 接口，只读属性 `id`、`label`、`model`，以及 `stream(messages: ChatMessage[]): AsyncIterable<StreamChunk>` 方法
- 定义 `ProviderConfig` 联合类型，覆盖五种 provider 类型的配置字段（`openai` / `anthropic` / `azure` / `ollama` / `openai-compat`），各类型含必填字段 `id`、`type`、`label`、`model`，可选字段 `apiKey`（`ollama` 无需）、`baseURL`，`azure` 类型额外含 `azureDeployment`、`azureApiVersion`
- 定义 `PawSettings` 接口，包含 `activeProvider: string`、`providers: ProviderConfig[]`、可选 `trustedProjectDirs: string[]`

**`errors.ts` 要做什么：**
- 定义 `LLMErrorKind` 类型别名，枚举六种错误分类：`"auth_failed"` / `"rate_limited"` / `"network_timeout"` / `"model_not_found"` / `"server_error"` / `"unknown"`
- 定义 `LLMError` 类，继承 `Error`，包含 `kind: LLMErrorKind` 和 `message: string` 字段，提供静态工厂方法或构造函数便于从 HTTP 响应状态码映射

**预期结果：** 两个文件可被其他模块导入，`bunx tsc --noEmit` 对这两个文件无类型报错。`LLMProvider` 接口是所有 provider 实现的统一契约。

---

### T2 — 实现 ProviderRegistry

**文件：** `src/agent/provider/registry.ts`

**要做什么：**
- 实现 `ProviderRegistry` 类，对外暴露以下能力：
  - **配置加载**：`loadSettings()` 方法，优先读取 `./.paw/settings.json`（项目本地），不存在则回退到 `~/.paw/settings.json`（全局）；使用 `Bun.file` 读取文件；JSON 解析失败或字段不合规时，收集具体字段错误并返回结构化错误信息（不崩溃）
  - **首次启动引导**：配置文件不存在时，返回友好引导提示内容（含示例配置路径和最简配置结构），由调用方在 TUI 消息区展示
  - **文件权限校验**：每次启动读取 `~/.paw/settings.json` 后，校验文件权限是否为 `0600`；不满足时返回警告文本，由调用方在 TUI 消息区展示
  - **hooks 安全确认**：检测到项目本地 `.paw/settings.json` 含 `hooks` 字段时，返回需要用户确认的信号（含所有 hooks 命令列表）；当前工作目录在 `trustedProjectDirs` 白名单中则跳过确认；确认结果决定是否加载 hooks 字段（`y` 加载、`n` 跳过 hooks 仅加载非 hooks 字段、`q` 中止）
  - **provider 路由**：`getActiveProvider(): LLMProvider` 方法，根据 `activeProvider` 字段在已注册的 provider 实例中路由；`activeProvider` 指向不存在的 id 时抛出明确错误
  - **provider 切换 `switchProvider(id: string)`**：若有进行中的 stream，先触发 abort 终止当前 stream 再切换（竞态语义 P2-01）；切换完成后异步写回配置文件的 `activeProvider` 字段（持久化语义 P2-03）；写入失败时 emit `provider_change_error` 事件（含 `reason: string`），内存状态仍保持
  - **获取所有 provider 列表**：`listProviders()` 方法，返回当前已加载的所有 provider 配置信息（用于切换浮层展示）

**预期结果：** `ProviderRegistry` 可被实例化，能正确加载配置、路由 provider、处理切换逻辑。配置缺失或格式错误时不崩溃，给出结构化错误或引导信息。

---

### T3 — 实现 OpenAI / openai-compat provider

**文件：** `src/agent/provider/impl/openai.ts`

**要做什么：**
- 实现 `OpenAIProvider` 类，满足 `LLMProvider` 接口
- 支持 `type` 为 `"openai"` 和 `"openai-compat"` 两种配置，逻辑复用（`openai-compat` 只是语义标识，协议完全相同）
- `stream()` 方法使用原生 `fetch` 向 `baseURL`（默认 `https://api.openai.com/v1`）发起 `/chat/completions` SSE 请求（`stream: true`）
- 实现 `parseStream` generator 函数，解析 SSE 数据行，逐行 yield `StreamChunk`；必须包含 `try/finally` 块，在 abort 或异常时通过 `response.body?.cancel()` 显式取消 `ReadableStream`（防止资源泄漏，P2-17）
- 根据 HTTP 状态码将响应错误映射为对应 `LLMErrorKind`（401→`auth_failed`，429→`rate_limited`，404→`model_not_found`，5xx→`server_error`），网络超时映射为 `network_timeout`，其他映射为 `unknown`，统一包装为 `LLMError` 抛出

**预期结果：** 可向 OpenAI 官方端点和兼容端点（如 DeepSeek、Kimi）发起 streaming 请求，逐字收到 `StreamChunk`；各类 HTTP 错误均被转换为 `LLMError` 抛出，不泄漏 `ReadableStream`。

---

### T4 — 实现 Anthropic provider

**文件：** `src/agent/provider/impl/anthropic.ts`

**要做什么：**
- 实现 `AnthropicProvider` 类，满足 `LLMProvider` 接口
- 使用原生 `fetch`（不依赖 Anthropic SDK），向 `https://api.anthropic.com/v1/messages`（`baseURL` 可省略时走此默认值）发起 SSE 请求；请求头含 `x-api-key`、`anthropic-version`
- 实现 Anthropic SSE 事件格式的手写解析器，将 `content_block_delta` 事件的 `delta.text` 字段 yield 为 `StreamChunk`；`message_stop` 事件对应 `done: true` 的 `StreamChunk`；`stop_reason: "tool_use"` 映射为 `stopReason: "tool_use"`
- `parseStream` generator 函数必须包含 `try/finally` 块，在 abort 或异常时显式取消 `ReadableStream`（P2-17）
- HTTP 错误映射为对应 `LLMErrorKind` 并包装为 `LLMError` 抛出（同 T3 的映射规则）

**预期结果：** 可向 Anthropic 官方端点发起 streaming 请求，Anthropic SSE 格式被正确解析为 `StreamChunk`，资源不泄漏。

---

### T5 — 实现 Azure OpenAI provider

**文件：** `src/agent/provider/impl/azure.ts`

**要做什么：**
- 实现 `AzureOpenAIProvider` 类，满足 `LLMProvider` 接口
- 在 T3 的 `OpenAIProvider` 逻辑基础上复用 SSE 解析逻辑（可通过继承或组合引用 `openai.ts` 中的 `parseStream` 函数）
- Azure OpenAI 端点 URL 格式为：`{baseURL}/openai/deployments/{azureDeployment}/chat/completions?api-version={azureApiVersion}`；鉴权方式改用 `api-key` 请求头（而非 `Authorization: Bearer`）
- HTTP 错误映射与 T3 相同，包装为 `LLMError` 抛出

**预期结果：** 可向 Azure OpenAI 端点发起 streaming 请求，URL 和请求头格式正确，SSE 解析复用 OpenAI 逻辑。

---

### T6 — 实现 Ollama provider

**文件：** `src/agent/provider/impl/ollama.ts`

**要做什么：**
- 实现 `OllamaProvider` 类，满足 `LLMProvider` 接口
- Ollama 提供 OpenAI 兼容的 `/v1/chat/completions` 端点（默认 `baseURL` 为 `http://localhost:11434`），无需 `apiKey`；在 T3 的 `OpenAIProvider` 逻辑基础上复用 SSE 解析逻辑
- 网络连接失败时（Ollama 服务未启动），映射为 `LLMErrorKind: "network_timeout"`，提示信息注明可能是本地服务未启动

**预期结果：** 可向本地 Ollama 端点发起 streaming 请求，SSE 解析复用 OpenAI 逻辑；服务未启动时给出明确错误。

---

### T7 — 定义 AgentEvent 类型（Spec 1 新增部分）

**文件：** `src/agent/events.ts`

**要做什么：**
- 创建 `src/agent/events.ts` 文件，作为全量 `AgentEvent` 的权威定义文件（P0-01 约定）
- 定义本 Spec（Spec 1）新增的以下 4 个事件接口（均采用嵌套 `payload` 格式）：
  - `StreamChunkEvent`：`type: "stream_chunk"`，`payload: { delta: string }`
  - `StreamDoneEvent`：`type: "stream_done"`，`payload: { totalText: string; stopReason: "stop" | "tool_use" }`
  - `StreamErrorEvent`：`type: "stream_error"`，`payload: { kind: LLMErrorKind; message: string }`
  - `ProviderChangedEvent`：`type: "provider_changed"`，`payload: { providerId: string; model: string }`
  - `ProviderChangeErrorEvent`：`type: "provider_change_error"`，`payload: { providerId: string; reason: string }`（Spec 1 P2-03 新增）
- 定义 `AgentEvent` 联合类型，包含上述 5 个事件接口
- 文件头部注释标明：后续 Spec 只追加新类型，不得重定义已有类型；最终权威源为此文件

**预期结果：** `src/agent/events.ts` 包含 Spec 1 的 5 个事件类型和 `AgentEvent` 联合类型，`bunx tsc --noEmit` 通过。文件结构为后续 Spec 2 扩展预留位置。

---

### T8 — TUI 接入：provider 切换浮层 + 错误差异化展示

**文件：** `src/App.tsx`

**要做什么：**
- 在左侧边栏底部新增 provider 状态展示区域：显示当前 `provider.label`（上限 18 字符，超出截断并追加 `…`）和 `model`（上限 20 字符，超出截断并追加 `…`）
- 绑定快捷键 `p`，触发时展示 provider 选择浮层（overlay box）；浮层列出所有可用 provider 的 `label` 和 `model`；用户选中后调用 `ProviderRegistry.switchProvider(id)`，浮层关闭，状态栏更新
- 订阅 `AgentEvent` 中的 `provider_changed` 事件，更新状态栏展示
- 在消息区实现差异化错误展示，根据 `stream_error` 事件的 `kind` 字段显示不同提示文本：
  - `auth_failed`：「API Key 无效，请检查配置」
  - `rate_limited`：「请求过于频繁，请稍后重试」
  - `network_timeout`：「连接超时，请检查网络或 baseURL」
  - `model_not_found`：「模型不存在，请确认 model 名称」
  - 其他：「发生错误，请稍后重试」
- 启动时若 `ProviderRegistry` 返回配置缺失引导内容，在消息区展示该引导文本
- 启动时若 `ProviderRegistry` 返回文件权限警告，在消息区展示警告文本
- 启动时若 `ProviderRegistry` 返回 hooks 确认请求，在 TUI 消息区展示醒目警告（逐条列出 hooks 命令），等待用户输入 `y` / `n` / `q` 后再继续
- 当前为占位接入：事件订阅和 provider 路由与真实 `AgentRunner` 对接（Spec 2 实现后完整接通）；本任务聚焦于 UI 结构和交互逻辑

**预期结果：** TUI 左侧边栏展示当前 provider 信息；按 `p` 可打开 provider 选择浮层并完成切换；`stream_error` 事件触发时展示对应差异化提示；启动时配置缺失/权限警告/hooks 确认均在 TUI 消息区展示，不使用 stderr。

---

## 执行顺序

```
T1 → T2 → T3 / T4 / T5 / T6（可并行）→ T7 → T8
```

- **T1**（类型定义）是所有后续任务的基础，必须最先完成
- **T2**（ProviderRegistry）依赖 T1 的 `LLMProvider` 接口和 `ProviderConfig` 类型
- **T3 / T4 / T5 / T6**（各 provider 实现）均依赖 T1，互相独立，可并行实现；T5 可在 T3 完成后开始（复用 `parseStream`），T6 同理，但不强制阻塞
- **T7**（AgentEvent 定义）依赖 T1 的 `LLMErrorKind`，在 provider 实现稳定后再定义事件类型
- **T8**（TUI 接入）依赖 T2、T7，需要 `ProviderRegistry` 和 `AgentEvent` 类型均就绪

---

## 完成记录

| 任务 | 状态 | 验证结果 |
|------|------|----------|
| T1 — 定义类型与错误枚举 | pending | — |
| T2 — 实现 ProviderRegistry | pending | — |
| T3 — 实现 OpenAI / openai-compat provider | pending | — |
| T4 — 实现 Anthropic provider | pending | — |
| T5 — 实现 Azure OpenAI provider | pending | — |
| T6 — 实现 Ollama provider | pending | — |
| T7 — 定义 AgentEvent 类型（Spec 1 新增部分）| pending | — |
| T8 — TUI 接入：provider 切换浮层 + 错误差异化展示 | pending | — |
