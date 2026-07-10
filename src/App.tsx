import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { useKeyboard } from "@opentui/react"
import { useState } from "react"

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  text: string
}

const theme = {
  bg: "black",
  panel: "gray",
  accent: "cyan",
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "1", role: "assistant", text: "Hello, World! 这是 UI 模块的占位内容。" },
  ])

  useKeyboard((key) => {
    if (key.name === "escape") {
      disableMouseReporting()
      process.exit(0)
    }
    if (key.name === "return") {
      setMessages((prev: ChatMessage[]) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text: "(回车触发)" },
        { id: crypto.randomUUID(), role: "assistant", text: "(占位回复) 已收到回车事件" },
      ])
    }
  })

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "row",
        padding: 1,
        gap: 1,
        backgroundColor: theme.bg,
      }}
    >
      <box
        style={{
          width: 24,
          flexShrink: 0,
          borderStyle: "rounded",
          borderColor: theme.panel,
          padding: 1,
        }}
      >
        <text style={{ fg: theme.accent }}>PAW</text>
        <text>Esc 退出</text>
        <text>Enter 追加占位消息</text>
      </box>
      <box
        style={{
          flexGrow: 1,
          flexDirection: "column",
          borderStyle: "rounded",
          borderColor: theme.panel,
          padding: 1,
          gap: 1,
        }}
      >
        {messages.map((msg: ChatMessage) => (
          <text key={msg.id}>
            [{msg.role}] {msg.text}
          </text>
        ))}
      </box>
    </box>
  )
}
const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l\x1b[?1015l';

// 为什么会出现你看到的输出: 许多 TUI 库在运行时会开启鼠标上报（让终端在鼠标点击/移动时把事件发送回应用）。如果程序退出时没有把这些模式关闭，
// 终端仍然把后续鼠标动作编码为控制序列并写回到 pty，结果就是那些控制字符被当作普通文本显示（你截图里的 35;29;8M...）。
      // 为什么写这些序列能修复: 把上面那些“禁用”序列写到控制终端上，终端会把对应的鼠标上报模式关闭。关闭后鼠标事件就不会再被发送为控制序列，终端显示恢复正常。因此在退出前发送这些序列可以确保终端回到非鼠标上报状态。
function disableMouseReporting() {
  try { process.stdout.write(DISABLE_MOUSE); } catch (e) { /* ignore */ }
}

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App />)