/**
 * ProviderRegistry 测试。
 *
 * 使用 Bun 的 `mock.module` 覆盖 os.homedir()，
 * 使设置从临时目录加载，避免污染真实路径。
 */

import { test, expect, describe, mock } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

let testHomeDir = ""

// 在导入 registry 之前 mock os.homedir()
mock.module("os", () => ({
  homedir: () => testHomeDir,
}))

// 在 os mock 生效后导入待测模块
const { ProviderRegistry } = await import("./registry")

const VALID_SETTINGS = {
  activeProvider: "my-openai",
  providers: [
    {
      id: "my-openai",
      type: "openai" as const,
      label: "My OpenAI",
      apiKey: "sk-test123",
      model: "gpt-4o",
    },
    {
      id: "my-anthropic",
      type: "anthropic" as const,
      label: "My Anthropic",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5",
    },
    {
      id: "ollama-local",
      type: "ollama" as const,
      label: "Ollama Local",
      model: "llama3",
      baseURL: "http://localhost:11434",
    },
  ],
}

async function withGlobalSettings(settings: object = VALID_SETTINGS): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), "paw-reg-"))
  const pawDir = join(tmpDir, ".paw")
  await mkdir(pawDir, { recursive: true })
  await writeFile(join(pawDir, "settings.json"), JSON.stringify(settings, null, 2))
  return tmpDir
}

describe("ProviderRegistry", () => {
  // ── 配置加载 ──────────────────────────────────────────────────────────────

  test("loadSettings: 配置文件不存在时返回 missing", async () => {
    testHomeDir = await mkdtemp(join(tmpdir(), "paw-reg-noconfig-"))
    try {
      const r = new ProviderRegistry()
      const result = await r.loadSettings()
      expect(result.ok).toBe(false)
      if (!result.ok && result.reason === "missing") {
        expect(result.guidance).toContain("欢迎使用 paw")
      }
    } finally {
      await rm(testHomeDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("loadSettings: 从全局配置解析有效的设置", async () => {
    const tmpDir = await withGlobalSettings()
    testHomeDir = tmpDir

    const r = new ProviderRegistry()
    const result = await r.loadSettings()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.settings.activeProvider).toBe("my-openai")
      expect(result.settings.providers).toHaveLength(3)
      expect(r.getActiveProviderId()).toBe("my-openai")

      const active = r.getActiveProvider()
      expect(active.id).toBe("my-openai")
      expect(active.label).toBe("My OpenAI")
      expect(active.model).toBe("gpt-4o")
    }

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  test("loadSettings: 无效 JSON 返回解析错误", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "paw-reg-"))
    const pawDir = join(tmpDir, ".paw")
    await mkdir(pawDir, { recursive: true })
    await writeFile(join(pawDir, "settings.json"), "this is not json")
    testHomeDir = tmpDir

    const r = new ProviderRegistry()
    const result = await r.loadSettings()

    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === "parse_error") {
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain("JSON")
    }

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  test("loadSettings: 校验必填的 provider 字段", async () => {
    const tmpDir = await withGlobalSettings({
      activeProvider: "",
      providers: [{ id: "test" }],
    })
    testHomeDir = tmpDir

    const r = new ProviderRegistry()
    const result = await r.loadSettings()

    if (!result.ok && result.reason === "parse_error") {
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors.some((e) => e.includes("type"))).toBe(true)
    }

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  // ── 激活 provider 路由 ─────────────────────────────────────────────────────

  test("getActiveProvider: 未加载 provider 时抛出异常", () => {
    const r = new ProviderRegistry()
    expect(() => r.getActiveProvider()).toThrow()
  })

  test("listProviders: 返回所有已配置的 provider", async () => {
    const tmpDir = await withGlobalSettings()
    testHomeDir = tmpDir

    const r = new ProviderRegistry()
    await r.loadSettings()

    const list = r.listProviders()
    expect(list).toHaveLength(3)
    expect(list.find((p) => p.id === "my-openai")).toBeDefined()
    expect(list.find((p) => p.id === "my-anthropic")).toBeDefined()
    expect(list.find((p) => p.id === "ollama-local")).toBeDefined()

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  // ── Provider 切换 ─────────────────────────────────────────────────────────

  test("switchProvider: 切换到有效的 provider", async () => {
    const tmpDir = await withGlobalSettings()
    testHomeDir = tmpDir

    const r = new ProviderRegistry()
    await r.loadSettings()

    expect(r.getActiveProviderId()).toBe("my-openai")

    await r.switchProvider("my-anthropic")
    expect(r.getActiveProviderId()).toBe("my-anthropic")

    const active = r.getActiveProvider()
    expect(active.id).toBe("my-anthropic")
    expect(active.model).toBe("claude-sonnet-5")

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  test("switchProvider: 不存在的 provider id 返回拒绝", async () => {
    const tmpDir = await withGlobalSettings()
    testHomeDir = tmpDir

    const r = new ProviderRegistry()
    await r.loadSettings()

    expect(r.switchProvider("non-existent")).rejects.toThrow()

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  // ── Stream 中止 (P2-01) ──────────────────────────────────────────────────

  test("beginStream / endStream: 管理 abort controller", () => {
    const r = new ProviderRegistry()

    const signal1 = r.beginStream()
    expect(signal1.aborted).toBe(false)

    const signal2 = r.beginStream()
    expect(signal1.aborted).toBe(true)
    expect(signal2.aborted).toBe(false)

    r.endStream()
  })

  // ── 警告 ─────────────────────────────────────────────────────────────────

  test("warnings: 加载后数组始终存在", async () => {
    const tmpDir = await withGlobalSettings()
    testHomeDir = tmpDir

    const r = new ProviderRegistry()
    await r.loadSettings()

    expect(Array.isArray(r.warnings)).toBe(true)

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })
})
