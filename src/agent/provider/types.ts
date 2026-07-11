/**
 * 多 Provider LLM 系统的核心类型定义。
 *
 * 本文件是与 provider 相关类型的权威来源，
 * 所有 provider 实现和注册中心都依赖这些类型。
 */

/** 聊天会话中的单条消息。 */
export interface ChatMessage {
  role: "user" | "assistant" | "system"
  content: string
}

/** Stream 过程中产出的单个数据块。 */
export interface StreamChunk {
  delta: string
  done: boolean
  /** 仅当 stream 因 tool_use 请求而停止时存在。 */
  stopReason?: "stop" | "tool_use"
}

/**
 * 统一的 provider 接口 —— 所有 provider 实现必须满足该接口。
 *
 * 可选的 `signal` 参数允许调用方（如 ProviderRegistry）
 * 中止正在进行的 stream（用于 provider 切换，P2-01）。
 */
export interface LLMProvider {
  readonly id: string
  readonly label: string
  readonly model: string
  stream(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<StreamChunk>
}

// ── Provider 配置类型 ─────────────────────────────────────────────────────────

export type ProviderType = "openai" | "anthropic" | "azure" | "ollama" | "openai-compat"

/** 所有 provider 配置共有的字段。 */
interface BaseProviderConfig {
  id: string
  type: ProviderType
  label: string
  model: string
  apiKey?: string
  baseURL?: string
}

export interface OpenAIProviderConfig extends BaseProviderConfig {
  type: "openai" | "openai-compat"
}

export interface AnthropicProviderConfig extends BaseProviderConfig {
  type: "anthropic"
}

export interface AzureProviderConfig extends BaseProviderConfig {
  type: "azure"
  azureDeployment: string
  azureApiVersion: string
}

export interface OllamaProviderConfig extends BaseProviderConfig {
  type: "ollama"
  apiKey?: undefined // Ollama 不需要 API Key
}

export type ProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | AzureProviderConfig
  | OllamaProviderConfig

/** 顶层配置文件结构（~/.paw/settings.json 或 ./.paw/settings.json）。 */
export interface PawSettings {
  activeProvider: string
  providers: ProviderConfig[]
  trustedProjectDirs?: string[]
  hooks?: Record<string, string>
}

// ── 配置加载结果类型 ──────────────────────────────────────────────────────────

export interface ConfigLoadSuccess {
  ok: true
  settings: PawSettings
  /** 已加载的配置文件路径。 */
  path: string
  /** 是否为项目本地配置文件（./.paw/settings.json）。 */
  isLocal: boolean
}

export interface ConfigLoadMissing {
  ok: false
  reason: "missing"
  guidance: string
}

export interface ConfigLoadParseError {
  ok: false
  reason: "parse_error"
  errors: string[]
  raw: string
}

export type ConfigLoadResult = ConfigLoadSuccess | ConfigLoadMissing | ConfigLoadParseError

// ── Hooks 确认 ────────────────────────────────────────────────────────────────

export interface HooksConfirmRequest {
  commands: Array<{ name: string; command: string }>
}

export type HooksConfirmAnswer = "y" | "n" | "q"
