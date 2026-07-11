/**
 * paw —— TUI 主 App 组件。
 *
 * Spec 1 的接入点：
 *   - 侧边栏：显示 provider 标签 + 模型名（超出截断）
 *   - 快捷键 `p`：打开 provider 选择浮层
 *   - 错误展示：按 LLMErrorKind 区分显示
 *   - 启动时：配置缺失引导 / hooks 确认
 *
 * 配色方案：Catppuccin Mocha（参见 docs/design/tui-visual-design.md）
 */

import { createCliRenderer, TextAttributes } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useState, useEffect, useCallback } from "react"

import type { AgentEvent } from "./agent/events"
import { eventBus } from "./agent/events"
import { providerRegistry } from "./agent/provider/registry"
import type { ConfigLoadResult, HooksConfirmAnswer } from "./agent/provider/types"
import type { LLMErrorKind } from "./agent/provider/errors"

// ── Catppuccin Mocha 调色板 ──────────────────────────────────────────────────

const C = {
  base: "#1e1e2e",
  surface0: "#313244",
  surface1: "#45475a",
  overlay0: "#6c7086",
  text: "#cdd6f4",
  subtext0: "#a6adc8",
  sky: "#89dceb",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  red: "#f38ba8",
  peach: "#fab387",
  mauve: "#cba6f7",
  flamingo: "#f2cdcd",
} as const

const BOLD = TextAttributes.BOLD
const DIM = TextAttributes.DIM

// ── 消息类型 ─────────────────────────────────────────────────────────────────

type MessageEntry =
  | { kind: "chat"; role: "user" | "assistant"; text: string }
  | { kind: "error"; kindLabel: LLMErrorKind; message: string }
  | { kind: "system"; text: string }
  | { kind: "guidance"; text: string }

// ── 截断 ─────────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "…"
}

// ── 错误类型 → 展示文本 ───────────────────────────────────────────────────────

function errorDisplayText(kind: LLMErrorKind): { label: string; color: string } {
  switch (kind) {
    case "auth_failed":
      return { label: "API Key 无效，请检查配置", color: C.red }
    case "rate_limited":
      return { label: "请求过于频繁，请稍后重试", color: C.yellow }
    case "network_timeout":
      return { label: "连接超时，请检查网络或 baseURL", color: C.yellow }
    case "model_not_found":
      return { label: "模型不存在，请确认 model 名称", color: C.yellow }
    case "server_error":
      return { label: "服务端错误，请稍后重试", color: C.red }
    case "unknown":
      return { label: "发生错误，请稍后重试", color: C.red }
  }
}

// ── App 组件 ─────────────────────────────────────────────────────────────────

function App() {
  // ── 核心状态 ────────────────────────────────────────────────────────────────
  const [messages] = useState<MessageEntry[]>([])
  const [providerLabel, setProviderLabel] = useState("—")
  const [providerModel, setProviderModel] = useState("—")
  const [showProviderOverlay, setShowProviderOverlay] = useState(false)
  const [showHooksOverlay, setShowHooksOverlay] = useState(false)
  const [selectedOverlayIndex, setSelectedOverlayIndex] = useState(0)
  const [providerList, setProviderList] = useState<
    Array<{ id: string; label: string; model: string }>
  >([])
  const [systemMessages, setSystemMessages] = useState<string[]>([])
  const [hasErrors, setHasErrors] = useState<
    Array<{ kind: LLMErrorKind; message: string }>
  >([])
  const [hasGuidance, setHasGuidance] = useState<string | null>(null)
  const [hooksCommands, setHooksCommands] = useState<
    Array<{ name: string; command: string }>
  >([])

  const addSystemMessage = useCallback((text: string) => {
    setSystemMessages((prev) => [...prev, text])
  }, [])

  const addError = useCallback(
    (kind: LLMErrorKind, message: string) => {
      setHasErrors((prev) => [...prev, { kind, message }])
    },
    [],
  )

  // ── 启动：加载设置 ──────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      const result: ConfigLoadResult = await providerRegistry.loadSettings()

      if (result.ok) {
        // 加载成功
        try {
          const active = providerRegistry.getActiveProvider()
          setProviderLabel(active.label)
          setProviderModel(active.model)
        } catch (err) {
          addSystemMessage(
            `⚠️  激活 provider 无效: ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        // 检查警告（权限等）
        for (const warning of providerRegistry.warnings) {
          addSystemMessage(warning)
        }

        // 检查 hooks 确认
        if (providerRegistry.pendingHooksConfirm) {
          setHooksCommands(providerRegistry.pendingHooksConfirm.commands)
          setShowHooksOverlay(true)
        }
      } else if (result.reason === "missing") {
        setHasGuidance(result.guidance)
      } else if (result.reason === "parse_error") {
        addSystemMessage(
          `⚠️  配置文件格式错误:\n${result.errors.join("\n")}`,
        )
      }
    })()
  }, [addSystemMessage])

  // ── 事件总线订阅 ───────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = eventBus.on((event: AgentEvent) => {
      switch (event.type) {
        case "provider_changed":
          setProviderLabel(event.payload.providerId)
          setProviderModel(event.payload.model)
          break
        case "provider_change_error":
          addSystemMessage(
            `⚠️  Provider 切换持久化失败: ${event.payload.reason}。内存状态已更新。`,
          )
          break
        case "stream_error":
          addError(event.payload.kind, event.payload.message)
          break
        case "stream_chunk":
        case "stream_done":
          break
      }
    })
    return unsub
  }, [addSystemMessage, addError])

  // ── 辅助：从 registry 刷新 provider 信息 ────────────────────────────────────
  const refreshProviderInfo = useCallback(() => {
    try {
      const active = providerRegistry.getActiveProvider()
      setProviderLabel(active.label)
      setProviderModel(active.model)
    } catch {
      setProviderLabel("—")
      setProviderModel("—")
    }
  }, [])

  // ── 键盘处理器 ──────────────────────────────────────────────────────────────
  useKeyboard((key) => {
    // 如果 hooks 确认浮层打开，只处理 y/n/q
    if (showHooksOverlay) {
      if (key.name === "y") {
        handleHooksAnswer("y")
      } else if (key.name === "n") {
        handleHooksAnswer("n")
      } else if (key.name === "q" || key.name === "escape") {
        handleHooksAnswer("q")
      }
      return
    }

    // 如果 provider 选择浮层打开
    if (showProviderOverlay) {
      if (key.name === "escape") {
        setShowProviderOverlay(false)
      } else if (key.name === "return") {
        const selected = providerList[selectedOverlayIndex]
        if (selected) {
          handleProviderSwitch(selected.id)
        }
        setShowProviderOverlay(false)
      } else if (key.name === "up" || key.sequence === "k") {
        setSelectedOverlayIndex((prev) => Math.max(0, prev - 1))
      } else if (key.name === "down" || key.sequence === "j") {
        setSelectedOverlayIndex((prev) =>
          Math.min(providerList.length - 1, prev + 1),
        )
      }
      return
    }

    if (key.name === "escape") {
      disableMouseReporting()
      process.exit(0)
    }

    // `p` → 打开 provider 选择浮层
    if (key.sequence === "p") {
      openProviderOverlay()
      return
    }
  })

  // ── Provider 浮层逻辑 ───────────────────────────────────────────────────────
  const openProviderOverlay = () => {
    const list = providerRegistry.listProviders()
    setProviderList(list)
    const currentId = providerRegistry.getActiveProviderId()
    const idx = list.findIndex((p) => p.id === currentId)
    setSelectedOverlayIndex(idx >= 0 ? idx : 0)
    setShowProviderOverlay(true)
  }

  const handleProviderSwitch = (id: string) => {
    providerRegistry.switchProvider(id).catch((err) => {
      addSystemMessage(`⚠️  切换 provider 失败: ${err.message}`)
    })
    refreshProviderInfo()
  }

  // ── Hooks 确认 ──────────────────────────────────────────────────────────────
  const handleHooksAnswer = async (answer: HooksConfirmAnswer) => {
    setShowHooksOverlay(false)
    setHooksCommands([])

    if (answer === "q") {
      addSystemMessage("用户取消加载 hooks，paw 退出。")
      setTimeout(() => {
        disableMouseReporting()
        process.exit(0)
      }, 500)
      return
    }

    await providerRegistry.confirmHooks(answer)
    const label = answer === "y" ? "已加载" : "已跳过"
    addSystemMessage(`Hook 配置${label}。`)
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────────
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "row",
        padding: 1,
        gap: 1,
        backgroundColor: C.base,
      }}
    >
      {/* ── 侧边栏 ── */}
      <box
        style={{
          width: 24,
          flexShrink: 0,
          borderStyle: "rounded",
          borderColor: C.surface1,
          backgroundColor: C.base,
          padding: 1,
          flexDirection: "column",
        }}
      >
        <text attributes={BOLD} fg={C.sky}>
          PAW
        </text>

        <text fg={C.sky}>p</text>
        <text fg={C.subtext0}>  provider</text>

        <text fg={C.sky}>Esc</text>
        <text fg={C.subtext0}>  exit</text>

        <text fg={C.surface1}>{"─".repeat(18)}</text>

        <text attributes={DIM} fg={C.subtext0}>
          PROVIDER
        </text>
        <text fg={C.text}>{truncate(providerLabel, 18)}</text>
        <text fg={C.subtext0}>{truncate(providerModel, 20)}</text>
      </box>

      {/* ── 消息区 ── */}
      <box
        style={{
          flexGrow: 1,
          borderStyle: "rounded",
          borderColor: C.surface1,
          backgroundColor: C.base,
          padding: 1,
          flexDirection: "column",
          gap: 1,
        }}
      >
        {/* 引导消息 */}
        {hasGuidance && (
          <text fg={C.sky} wrapMode="word">
            {hasGuidance}
          </text>
        )}

        {/* 系统消息 */}
        {systemMessages.map((msg, i) => (
          <text key={`sys-${i}`} attributes={DIM} fg={C.overlay0}>
            {msg}
          </text>
        ))}

        {/* 错误消息 */}
        {hasErrors.map((err, i) => {
          const display = errorDisplayText(err.kind)
          return (
            <text key={`err-${i}`} fg={display.color}>
              {display.label}
            </text>
          )
        })}

        {/* 空状态 */}
        {systemMessages.length === 0 &&
          hasErrors.length === 0 &&
          !hasGuidance && (
            <text attributes={DIM} fg={C.overlay0}>
              按 p 选择 provider，输入消息开始对话
            </text>
          )}
      </box>

      {/* ── Hooks 确认浮层 ── */}
      {showHooksOverlay && (
        <box
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 60,
            height: 12,
            marginLeft: -30,
            marginTop: -6,
            borderStyle: "rounded",
            borderColor: C.yellow,
            backgroundColor: C.base,
            padding: 1,
            flexDirection: "column",
            gap: 0,
          }}
        >
          <text attributes={BOLD} fg={C.yellow}>
            {"⚠️  检测到 hooks 配置"}
          </text>
          {hooksCommands.map((c, i) => (
            <text key={i} fg={C.text}>
              {"  "}{c.name}: {c.command}
            </text>
          ))}
          <text attributes={DIM} fg={C.subtext0}>
            y 加载 / n 跳过 / q 退出
          </text>
        </box>
      )}

      {/* ── Provider 选择浮层 ── */}
      {showProviderOverlay && (
        <box
          title="选择 Provider"
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 48,
            height: providerList.length + 4,
            borderStyle: "rounded",
            borderColor: C.sky,
            backgroundColor: C.base,
            padding: 1,
            flexDirection: "column",
            gap: 0,
            marginLeft: -24,
            marginTop: -((providerList.length + 4) / 2),
          }}
        >
          {providerList.map((p, i) => {
            const isSelected = i === selectedOverlayIndex
            const currentId = providerRegistry.getActiveProviderId()
            const isCurrent = p.id === currentId
            return (
              <box key={p.id} style={{ flexDirection: "row", gap: 1 }}>
                <text
                  fg={isSelected ? C.sky : C.overlay0}
                  width={2}
                >
                  {isSelected ? ">" : " "}
                </text>
                <text
                  fg={
                    isCurrent
                      ? C.green
                      : isSelected
                        ? C.text
                        : C.subtext0
                  }
                  attributes={isCurrent || isSelected ? BOLD : 0}
                >
                  {p.label}
                </text>
                <text fg={C.overlay0}> {p.model}</text>
                {isCurrent && (
                  <text attributes={DIM} fg={C.overlay0}>
                    (current)
                  </text>
                )}
              </box>
            )
          })}
          <text attributes={DIM} fg={C.subtext0}>
            Enter 确认 Esc 取消
          </text>
        </box>
      )}
    </box>
  )
}

// ── 禁用鼠标的转义序列 ───────────────────────────────────────────────────────

const DISABLE_MOUSE =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l\x1b[?1015l"

function disableMouseReporting() {
  try {
    process.stdout.write(DISABLE_MOUSE)
  } catch {
    /* 忽略 */
  }
}

// ── 启动 ─────────────────────────────────────────────────────────────────────

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App />)
