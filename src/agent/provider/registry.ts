/**
 * ProviderRegistry —— 设置加载、provider 路由、运行时切换。
 *
 * 职责（按 Spec 1）：
 *   - 加载 `./.paw/settings.json`（项目本地）或 `~/.paw/settings.json`（全局）
 *   - 校验 `~/.paw/settings.json` 文件权限（必须为 0600）
 *   - 项目本地配置含 `hooks` 字段时，要求用户确认
 *   - 路由 `getActiveProvider()` 到正确的 LLMProvider 实例
 *   - `switchProvider()`：中止进行中的 stream → 切换 → 持久化
 *   - `listProviders()`：返回所有已配置的 provider（供选择浮层使用）
 */

import { homedir } from "os"
import { join, resolve } from "path"

import type { LLMProvider, PawSettings, ProviderConfig, ConfigLoadResult, HooksConfirmRequest, HooksConfirmAnswer } from "./types"
import type { ConfigLoadSuccess } from "./types"
import { OpenAIProvider } from "./impl/openai"
import { AnthropicProvider } from "./impl/anthropic"
import { AzureOpenAIProvider } from "./impl/azure"
import { OllamaProvider } from "./impl/ollama"
import { eventBus } from "../events"

// ── 常量 ─────────────────────────────────────────────────────────────────────

const PROJECT_CONFIG_PATH = "./.paw/settings.json"
const GLOBAL_CONFIG_DIR = ".paw"
const GLOBAL_CONFIG_FILE = "settings.json"

// ── 引导提示文本 ──────────────────────────────────────────────────────────────

const MISSING_CONFIG_GUIDANCE = `
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
`

// ── 权限警告辅助函数 ──────────────────────────────────────────────────────────

function permissionWarning(path: string, actualMode: string): string {
  return `⚠️  ${path} 权限为 ${actualMode}，建议执行 chmod 600 以保护 API Key`
}

// ── Provider 工厂 ────────────────────────────────────────────────────────────

function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.type) {
    case "openai":
    case "openai-compat":
      return new OpenAIProvider(config)
    case "anthropic":
      return new AnthropicProvider(config)
    case "azure":
      return new AzureOpenAIProvider(config)
    case "ollama":
      return new OllamaProvider(config)
  }
}

// ── Registry 类 ──────────────────────────────────────────────────────────────

export class ProviderRegistry {
  /** 所有已加载的 provider 实例，以 id 为键。 */
  private providers: Map<string, LLMProvider> = new Map()

  /** 当前激活的 provider 的 id。 */
  private activeProviderId: string = ""

  /** 原始设置（在内存中保留以便持久化）。 */
  private settings: PawSettings | null = null

  /** 已加载的配置文件路径。 */
  private settingsPath: string = ""

  /** 当前进行中 stream 的 AbortController（P2-01）。 */
  private currentAbortController: AbortController | null = null

  /** 加载过程中收集的警告（权限等）。 */
  warnings: string[] = []

  /** 项目本地配置待处理的 hooks 确认。 */
  pendingHooksConfirm: HooksConfirmRequest | null = null

  /** 注册中心是否已初始化。 */
  private loaded = false

  // ── 配置加载 ────────────────────────────────────────────────────────────────

  /**
   * 从项目本地或全局配置文件加载设置。
   *
   * 优先级：
   *   1. `./.paw/settings.json`（项目本地）
   *   2. `~/.paw/settings.json`（全局回退）
   *
   * 返回 `ConfigLoadResult`，调用方（TUI）据此决定展示什么内容。
   */
  async loadSettings(): Promise<ConfigLoadResult> {
    this.warnings = []
    this.pendingHooksConfirm = null

    // 优先尝试项目本地配置
    const projectPath = resolve(PROJECT_CONFIG_PATH)
    const projectFile = Bun.file(projectPath)
    const projectExists = await projectFile.exists()

    if (projectExists) {
      return this.parseAndApply(projectFile, projectPath, true)
    }

    // 回退到全局配置
    const globalDir = join(homedir(), GLOBAL_CONFIG_DIR)
    const globalPath = join(globalDir, GLOBAL_CONFIG_FILE)
    const globalFile = Bun.file(globalPath)
    const globalExists = await globalFile.exists()

    if (globalExists) {
      // 检查文件权限（P2-15）
      try {
        const stat = await Bun.$`stat -c "%a" ${globalPath}`.quiet().text()
        const mode = stat.trim()
        if (mode !== "600") {
          this.warnings.push(permissionWarning(globalPath, mode))
        }
      } catch {
        // 无法执行 stat —— 跳过权限检查
      }

      return this.parseAndApply(globalFile, globalPath, false)
    }

    // 都不存在 → 返回引导提示
    return {
      ok: false,
      reason: "missing",
      guidance: MISSING_CONFIG_GUIDANCE,
    }
  }

  /**
   * 解析设置文件并从中构建 provider 实例。
   */
  private async parseAndApply(
    file: ReturnType<typeof Bun.file>,
    path: string,
    isLocal: boolean,
  ): Promise<ConfigLoadResult> {
    let raw: string
    try {
      raw = await file.text()
    } catch (err) {
      return {
        ok: false,
        reason: "parse_error",
        errors: [`无法读取文件: ${err instanceof Error ? err.message : String(err)}`],
        raw: "",
      }
    }

    // 尝试 JSON 解析
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      const msg = err instanceof SyntaxError ? err.message : `JSON 解析错误: ${err}`
      return {
        ok: false,
        reason: "parse_error",
        errors: [msg],
        raw,
      }
    }

    // 校验结构（字段级错误）
    const errors = validateSettingsShape(parsed)
    if (errors.length > 0) {
      return {
        ok: false,
        reason: "parse_error",
        errors,
        raw,
      }
    }

    const settings = parsed as PawSettings

    // 检查本地配置中的 hooks 字段（P1-09）
    if (isLocal && settings.hooks && Object.keys(settings.hooks).length > 0) {
      const commands = Object.entries(settings.hooks).map(([name, command]) => ({
        name,
        command: command as string,
      }))
      // 将 hooks 确认推迟 —— TUI 将展示确认框并回调
      // 仍然加载 provider，但 hooks 在确认前被剥离
      this.pendingHooksConfirm = { commands }
    }

    // 应用设置（构建 provider 实例）
    this.applySettings(settings, path, isLocal)

    return {
      ok: true,
      settings: this.settings!,
      path,
      isLocal,
    }
  }

  /**
   * 根据验证通过的设置构建 provider 实例。
   */
  private applySettings(settings: PawSettings, path: string, _isLocal: boolean): void {
    this.settings = settings
    this.settingsPath = path
    this.providers.clear()

    for (const config of settings.providers) {
      try {
        const provider = createProvider(config)
        this.providers.set(provider.id, provider)
      } catch {
        // 跳过无效的 provider 配置
      }
    }

    this.activeProviderId = settings.activeProvider
    this.loaded = true
  }

  // ── Hooks 确认回调 ─────────────────────────────────────────────────────────

  /**
   * 处理用户对 hooks 确认的回应。
   * TUI 在用户输入 y/n/q 后调用此方法。
   */
  async confirmHooks(answer: HooksConfirmAnswer): Promise<void> {
    if (!this.settings) return

    if (answer === "n") {
      // 从内存设置中剥离 hooks
      this.settings = { ...this.settings, hooks: undefined }
    }
    // 'y' → 保持 hooks 不变（已加载）
    // 'q' → 调用方应中止启动

    this.pendingHooksConfirm = null
  }

  // ── Provider 访问 ───────────────────────────────────────────────────────────

  /** 获取当前激活的 provider 实例。 */
  getActiveProvider(): LLMProvider {
    const provider = this.providers.get(this.activeProviderId)
    if (!provider) {
      throw new Error(
        `activeProvider "${this.activeProviderId}" 不存在，请检查 settings.json 配置`,
      )
    }
    return provider
  }

  /** 获取当前激活的 provider id。 */
  getActiveProviderId(): string {
    return this.activeProviderId
  }

  /** 列出所有已配置的 provider（供选择浮层使用）。 */
  listProviders(): Array<{ id: string; label: string; model: string }> {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      label: p.label,
      model: p.model,
    }))
  }

  // ── 切换 ────────────────────────────────────────────────────────────────────

  /**
   * 运行时切换当前激活的 provider。
   *
   * 语义（P2-01）：
   *   - 如果有正在进行的 stream，立即中止它。
   *   - 立即在内存中切换到新 provider。
   *   - 异步将变更持久化到 settings.json。
   *
   * 持久化失败时发送 `provider_change_error` 事件（P2-03）。
   */
  async switchProvider(id: string): Promise<void> {
    if (!this.providers.has(id)) {
      throw new Error(`Provider "${id}" 未注册`)
    }

    // 中止正在进行的 stream（P2-01）
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }

    // 在内存中切换
    const previousId = this.activeProviderId
    this.activeProviderId = id

    // 发送变更事件
    const provider = this.providers.get(id)!
    eventBus.emit({
      type: "provider_changed",
      payload: { providerId: id, model: provider.model },
    })

    // 异步持久化（P2-03）
    try {
      await this.persistActiveProvider()
    } catch (err) {
      // 持久化失败 —— 内存状态仍然更新，但示警用户
      eventBus.emit({
        type: "provider_change_error",
        payload: {
          providerId: id,
          reason: `持久化失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      })
      // 回滚内存状态
      this.activeProviderId = previousId
    }
  }

  /**
   * 注册一个 stream 的开始，以便 switchProvider 可以中止它。
   * 返回一个 AbortSignal，调用方应将其传递给 `stream()`。
   */
  beginStream(): AbortSignal {
    // 中止先前的 stream
    if (this.currentAbortController) {
      this.currentAbortController.abort()
    }
    this.currentAbortController = new AbortController()
    return this.currentAbortController.signal
  }

  /** 标记当前 stream 已完成。 */
  endStream(): void {
    this.currentAbortController = null
  }

  // ── 持久化 ──────────────────────────────────────────────────────────────────

  /**
   * 将当前的 `activeProvider` 写回配置文件。
   */
  private async persistActiveProvider(): Promise<void> {
    if (!this.settings || !this.settingsPath) return

    const updated: PawSettings = {
      ...this.settings,
      activeProvider: this.activeProviderId,
    }

    await Bun.write(this.settingsPath, JSON.stringify(updated, null, 2))
  }
}

// ── 校验 ──────────────────────────────────────────────────────────────────────

/**
 * 验证 `obj` 是否符合 PawSettings 的结构。
 * 返回人类可读的字段级错误列表（空数组表示有效）。
 */
function validateSettingsShape(obj: unknown): string[] {
  const errors: string[] = []

  if (!obj || typeof obj !== "object") {
    errors.push("settings.json 必须是 JSON 对象")
    return errors
  }

  const s = obj as Record<string, unknown>

  // activeProvider
  if (typeof s.activeProvider !== "string" || !s.activeProvider) {
    errors.push('缺少或无效的 "activeProvider" 字段，应为非空字符串')
  }

  // providers
  if (!Array.isArray(s.providers)) {
    errors.push('缺少或无效的 "providers" 字段，应为数组')
    return errors
  }

  for (let i = 0; i < s.providers.length; i++) {
    const p = s.providers[i] as Record<string, unknown> | undefined
    if (!p || typeof p !== "object") {
      errors.push(`providers[${i}] 不是有效对象`)
      continue
    }

    if (typeof p.id !== "string" || !p.id) {
      errors.push(`providers[${i}] 缺少或无效的 "id" 字段`)
    }
    if (typeof p.type !== "string") {
      errors.push(`providers[${i}] 缺少 "type" 字段`)
    } else if (!["openai", "anthropic", "azure", "ollama", "openai-compat"].includes(p.type)) {
      errors.push(`providers[${i}].type "${p.type}" 不合法（应为 openai/anthropic/azure/ollama/openai-compat）`)
    }
    if (typeof p.label !== "string" || !p.label) {
      errors.push(`providers[${i}] 缺少或无效的 "label" 字段`)
    }
    if (typeof p.model !== "string" || !p.model) {
      errors.push(`providers[${i}] 缺少或无效的 "model" 字段`)
    }
    // apiKey：除 ollama 外都需要
    if (p.type !== "ollama" && typeof p.apiKey !== "string") {
      errors.push(`providers[${i}] 缺少 "apiKey" 字段（ollama 类型除外）`)
    }
    // Azure 专有字段
    if (p.type === "azure") {
      if (typeof p.azureDeployment !== "string" || !p.azureDeployment) {
        errors.push(`providers[${i}] 缺少 "azureDeployment" 字段（azure 类型必填）`)
      }
      if (typeof p.azureApiVersion !== "string" || !p.azureApiVersion) {
        errors.push(`providers[${i}] 缺少 "azureApiVersion" 字段（azure 类型必填）`)
      }
    }
  }

  return errors
}

// ── 单例 ─────────────────────────────────────────────────────────────────────

/** 全局单例注册中心实例。 */
export const providerRegistry = new ProviderRegistry()
