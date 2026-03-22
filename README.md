# WeChat for Claude Code

用微信控制你电脑上的 Claude Code。

不需要 API Key，不需要部署服务器，不需要任何额外账号。只要你电脑上装了 Claude Code 并登录了 claude.ai，就可以在微信里随时随地跟 Claude 对话——和在终端里用 Claude Code 一样，只是入口变成了微信。

**支持 macOS / Windows / Linux。**

## 与同类项目的对比

社区已有 [claude-code-wechat-channel](https://github.com/Johnixr/claude-code-wechat-channel)，基于 MCP Channel 实验性协议。本项目采用完全不同的技术路线，体验差异如下：

| 对比项 | wechat-for-claude-code（本项目） | claude-code-wechat-channel |
|--------|------|------|
| **技术方案** | `claude -p` CLI pipe 模式（稳定） | MCP Channel 协议（实验性，需 `--dangerously-load-development-channels`） |
| **上下文记忆** | 有，per-user `--resume` 持久化，重启不丢 | 无，关终端即丢失全部上下文 |
| **后台常驻** | 开机自启，关终端不影响 | 必须保持终端窗口打开 |
| **跨平台服务** | macOS launchd / Linux systemd / Windows Task Scheduler | 无 |
| **打字气泡** | 持续循环 sendTyping 直到回复完成 | 无 |
| **Markdown 处理** | 自动转纯文本（代码块、表格、链接、删除线等） | 靠 prompt 提示 Claude "别用 markdown"（不可靠） |
| **长文本分段** | 智能分段（按段落/换行/空格断句，4000 字限制） | 无，超长会被微信截断 |
| **消息去重** | 11 分钟去重窗口 | 无 |
| **频率限制** | 可配置（默认 3 秒/用户） | 无 |
| **多用户并发** | per-user 队列，同用户按序，不同用户并发 | 无 |
| **微信端命令** | `新对话` 重置 / `帮助` 查看命令 | 无 |
| **媒体提示** | 收到图片/文件/视频友好提示 | 静默忽略 |
| **QR 码过期** | 自动刷新（最多 3 次） | 过期需重启 |
| **日志系统** | 时间戳 + 按天轮转 + 7 天自动清理 | 仅 stderr，无持久化 |
| **token 过期检测** | 连续过期明确提示重新登录 | 无 |
| **环境检测** | 启动时检测 claude CLI 并给安装指引 | 无 |
| **安装步骤** | `bun setup.ts` 一步搞定 | 三步：setup → install → 手动带 flag 启动 |
| **外部依赖** | 1 个（qrcode-terminal） | 2 个（+@modelcontextprotocol/sdk） |

**核心差异**：本项目使用稳定的 `claude -p` pipe 模式直接调用本地 Claude Code，不依赖实验性 MCP Channel 协议。这意味着：
- 不需要 `--dangerously-load-development-channels` 标志
- 不受 Claude Code Channel 功能迭代影响
- 后台常驻，真正做到"装完就忘"

## 它能做什么

- 在微信中直接跟 Claude 对话，获得和 Claude Code 一样的能力
- 每个微信用户独立会话，上下文自动保持（可跨多条消息连续对话）
- 语音消息自动转文字，发语音也能用
- 引用回复带上下文，Claude 能看到你引用的内容
- 发送"新对话"随时重置上下文，开始全新话题
- 电脑开机自动启动，关掉终端也不影响，后台常驻
- 微信端看到"对方正在输入"气泡，知道 Claude 在处理中
- 长回复自动分段发送，不会被微信截断

## 它做不到什么

- **不能处理图片、文件、视频**——收到会提示你发文字（后续迭代）
- **不能离线使用**——你的电脑必须保持开机联网（Claude Code CLI 在本地运行）
- **不是手机 App**——是一个运行在电脑上的桥接服务
- **不支持群聊**——目前只支持一对一私聊
- **不能流式输出**——Claude 回复是等生成完毕后一次性发送的

## 工作原理

```
你的微信 → ClawBot 插件 → 微信 ilink API → [本项目] → claude -p → Claude
   ↑                                                                  |
   └──────────────── 回复原路返回 ←────────────────────────────────────┘
```

1. 你在微信 ClawBot 里发消息
2. 本项目通过微信官方 ilink API 长轮询收到消息
3. 调用本地的 `claude -p`（Claude Code CLI pipe 模式）处理
4. 把 Claude 的回复去掉 markdown 格式，发回微信
5. 每个用户的对话上下文通过 `--resume` 持久化，重启也不丢

**不依赖任何第三方 AI 服务或框架**，直接调用你本地已安装的 Claude Code。

## 一键安装

复制下面一行命令到终端，回车，然后用微信扫个码就完事了：

**macOS / Linux：**
```bash
curl -fsSL https://raw.githubusercontent.com/Hollychou924/wechat-for-claude-code/main/install.sh | bash
```

**Windows（PowerShell）：**
```powershell
irm https://raw.githubusercontent.com/Hollychou924/wechat-for-claude-code/main/install.ps1 | iex
```

脚本会自动完成所有事情：
1. 检测并安装 Bun（如果没装）
2. 检测 Claude Code 是否可用（没装会提示你怎么装）
3. 下载本项目到 `~/.wechat-for-claude-code`
4. 安装依赖
5. **显示二维码 → 你用微信扫码确认**
6. 自动安装开机自启后台服务

**唯一需要你做的就是扫码。** 其他全部自动。

### 前提条件

安装前需要确保：
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 已安装并登录（`npm install -g @anthropic-ai/claude-code && claude`）
- 微信已更新到最新版（iOS 8.0.70+），并在「我 → 设置 → 插件」中开启 ClawBot

> ClawBot 目前还在灰度放量中。如果在「插件」里没看到，关掉微信进程重新打开试试，或等几天。

### 手动安装（可选）

如果你不想用一键脚本，也可以手动：

```bash
git clone https://github.com/Hollychou924/wechat-for-claude-code.git
cd wechat-for-claude-code
bun setup.ts
```

### 后台服务

一键安装会自动配置开机自启，关掉终端也不影响：

| 系统 | 自启方式 |
|------|----------|
| macOS | launchd（LaunchAgents） |
| Linux | systemd user service |
| Windows | Task Scheduler（登录时启动） |

不想用后台服务的话，也可以每次手动启动：`bun start`

## 微信端命令

在微信里直接发这些文字即可：

| 命令 | 说明 |
|------|------|
| `新对话` 或 `reset` | 清除上下文，开始全新对话 |
| `帮助` 或 `help` | 查看可用命令 |

其他任何文字都会发给 Claude 处理。

## 管理命令

在项目目录下执行：

```bash
bun run status      # 查看运行状态、登录信息
bun run uninstall   # 卸载后台服务、清理数据
bun setup.ts --service  # 仅重装后台服务（不重新登录）
```

## 自定义配置

可通过环境变量调整（均可选）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAUDE_TIMEOUT` | `300` | Claude 响应超时（秒） |
| `RATE_LIMIT` | `3` | 同一用户消息最短间隔（秒） |
| `MAX_SEND_CHUNK` | `4000` | 单条回复最大字符数 |

## 技术细节

<details>
<summary>展开查看</summary>

### 协议

基于微信官方 ClawBot ilink API，与 `@tencent-weixin/openclaw-weixin` 官方插件使用完全相同的协议接口。

### 项目结构

```
src/
├── index.ts       # 入口，环境检测，信号处理
├── config.ts      # 配置（支持环境变量覆盖）
├── api.ts         # WeChat ilink API 客户端
├── auth.ts        # QR 扫码登录（支持自动刷新）
├── message.ts     # 消息解析 + markdown 转纯文本
├── claude.ts      # Claude Code CLI 调用 + 会话管理
├── polling.ts     # 长轮询 + per-user 消息队列
├── storage.ts     # 凭据 / 会话 / 同步状态持久化
├── service.ts     # 跨平台后台服务管理
└── log.ts         # 带时间戳的日志 + 按天轮转
scripts/
├── status.ts      # 服务状态检查
└── uninstall.ts   # 卸载清理
setup.ts           # 一键安装脚本
```

### 完整特性列表

- 上下文记忆：`--resume` per-user 会话持久化
- 跨平台自启：macOS launchd / Linux systemd / Windows Task Scheduler
- 打字气泡：每 3 秒循环 sendTyping 直到回复完成
- Per-user 消息队列：同一用户按序处理，不同用户并发
- Markdown 转纯文本：代码块、表格、链接、加粗、删除线等
- 长文本分段：按段落 > 换行 > 空格智能断句
- 消息去重：11 分钟内相同消息自动过滤
- 频率限制：可配置的用户消息间隔
- 语音转文字：利用微信端 voice_item.text
- 引用回复：提取引用内容作为上下文
- 日志轮转：按天创建，自动保留 7 天
- 会话清理：30 天未活跃自动清理
- Token 过期检测：连续过期提示重新登录
- 凭据安全：文件权限 0o600

### 数据存储

```
~/.claude/channels/wechat/
├── account.json        # 微信登录凭据（仅限本机读取）
├── sync_buf.txt        # 消息同步状态
└── sessions/           # 每个用户的 Claude 会话 ID
    └── {userId}.txt
```

</details>

## 常见问题

**Q: 需要 Claude API Key 吗？**
A: 不需要。直接用你 claude.ai 账号登录的 Claude Code，走 Pro/Free 额度。

**Q: 电脑关机了还能用吗？**
A: 不能。Claude Code 在你电脑本地运行，电脑必须开机联网。

**Q: 多个人可以同时用吗？**
A: 可以。每个微信用户独立会话，多人同时发消息互不影响。

**Q: 微信会话怎么重置？**
A: 在微信里发"新对话"两个字。

**Q: 微信里找不到 ClawBot 插件怎么办？**
A: ClawBot 目前还在灰度放量中。确保你的微信是 iOS 8.0.70 及以上版本，然后在「我 → 设置 → 插件」里查看。如果没有，关掉微信进程重新打开试试，或者等几天。

**Q: 我电脑上开了好几个 Claude Code 终端窗口，微信连的是哪个？**
A: 都不是。微信桥接用的是 `claude -p`（pipe 模式），这是一个无界面的独立调用，不连接任何终端窗口。你在终端里用 Claude Code 写代码，微信上同时聊天，完全互不干扰。上下文记忆靠磁盘上的 session 文件，不依赖任何运行中的窗口。

**Q: 安全吗？**
A: 凭据文件仅存在你本地（~/.claude/channels/wechat/），权限设为仅本人可读。消息通过微信官方 ilink API 传输，不经过任何第三方服务器。

**Q: 和 claude-code-wechat-channel 有什么区别？**
A: 见上方对比表。核心区别：本项目使用稳定的 CLI pipe 模式，支持上下文记忆和后台常驻，不依赖实验性协议。

## License

MIT
