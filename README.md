# ChatGPT Web Skill

[![Windows CI](https://github.com/WhatYearIsNow/chatgpt-web-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/WhatYearIsNow/chatgpt-web-skill/actions/workflows/ci.yml)

仓库：[`WhatYearIsNow/chatgpt-web-skill`](https://github.com/WhatYearIsNow/chatgpt-web-skill) · Skill 名：`chatgpt-web`

可作为 agent skill 或独立 CLI 使用的 ChatGPT 网页自动化工具。支持纯文本、ZIP 附件审查、已有会话续问、参考图生图、本地用量记录，以及显式邮箱验证的 SSO 切号。

**v0.2.0 正式版，MIT，零第三方运行依赖。** 需要 Node.js 22.15+ 和已有的本地 Chromium CDP 端点。它操作网页 UI，不是官方 API 客户端；UI、语言和账号功能变化可能需要更新选择器。

**当前验收状态（2026-10-24）：** Windows 本地与 GitHub Actions 的 Node 22/24 均各 154 项测试通过，0 失败、0 跳过。邮箱 SSO、Google 已有登录、账号恢复及完整单图生成保存已通过真实验收。完整范围见 [测试记录](docs/testing.md)。

## 安装与浏览器准备

克隆或下载源码并在项目目录运行，不需要 `npm install`。
也可从 [v0.2.0 Release](https://github.com/WhatYearIsNow/chatgpt-web-skill/releases/tag/v0.2.0) 下载 `chatgpt-web-0.2.0-source.zip`，按附带的 `SHA256SUMS` 核对文件；解压得到 `chatgpt-web/` 目录。

```sh
git clone https://github.com/WhatYearIsNow/chatgpt-web-skill.git
cd chatgpt-web-skill
```

作为 skill 使用时，将整个目录放入 agent 的技能目录并命名为 `chatgpt-web`；入口是 [SKILL.md](SKILL.md)。

准备一个**新的独立浏览器数据目录**，手动登录自己的 ChatGPT 账号。例如 PowerShell：

```powershell
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = Join-Path $env:LOCALAPPDATA 'chatgpt-web-browser'
& $chrome '--remote-debugging-port=9222' "--user-data-dir=$profile"
$env:CHATGPT_WEB_CDP_URL = 'http://127.0.0.1:9222'
node scripts/chatgpt-web.mjs ask --prompt '只回复：收到'
```

Linux 可用 `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.local/share/chatgpt-web-browser"`；macOS 使用 Chrome 应用的可执行路径与新的 profile 目录。
Chrome 136 起，默认浏览器数据目录不再支持旧式调试端口参数，需要非默认目录；参见 [Chrome 官方说明](https://developer.chrome.com/blog/remote-debugging-port)。不要复制现有 profile。

工具只连接 loopback HTTP/WS 端点，不自动启动浏览器或批准系统弹窗。已有可信中继可直接配置 WebSocket 地址。
若已有自己的浏览器连接库，可显式指定 `CHATGPT_WEB_BROWSER_MODULE`，详见 [架构和适配器接口](docs/architecture.md)。
`.env.example` 只是变量示例；CLI 不自动加载 `.env`。也可在私有运行数据目录的 `config.json` 持久保存 `endpoint` 或 `browserModule`；显式连接参数或环境变量优先，见 [迁移说明](docs/migration.md)。

## 命令

```sh
node scripts/chatgpt-web.mjs ask --prompt-file question.txt --out answer.md
node scripts/chatgpt-web.mjs review --zip source.zip --prompt-file review.txt --out report.md
node scripts/chatgpt-web.mjs followup --url https://chatgpt.com/c/CONVERSATION-ID --prompt "补充说明第三点" --out reply.md
node scripts/chatgpt-web.mjs image --prompt-file image.txt --ref reference.jpg --out image.png
node scripts/chatgpt-web.mjs image --prompt-file image.txt --out candidate.webp --candidates 2
node scripts/chatgpt-web.mjs quota --today
node scripts/chatgpt-web.mjs quota --tail 20
node scripts/chatgpt-web.mjs account --email user@example.com --provider google --keep-open
node scripts/chatgpt-web.mjs account --google --keep-open
```

每条命令有 `--help`。`scripts/ask.mjs`、`review.mjs`、`followup.mjs`、`image.mjs`、`quota.mjs`、`account.mjs` 是同一实现的兼容入口。

| 参数 | 含义 |
| --- | --- |
| `--prompt` / `--prompt-file` | 二选一，不能为空 |
| `--out` | 文本可选；review/followup 默认生成文件；image 必填 |
| `--timeout` | 回复完成与正文稳定回收共用的等待秒数（账号命令用于切号流程），不包含前置连接、上传或锁等待 |
| `--lock-timeout` | 等待本机任务互斥锁的秒数，默认 600 |
| `--dry-run` | 准备真实网页但不发送；附件/参考图会上传；account 不切号 |
| `--keep-open` / `--keep-tab` | 保留本任务标签页，便于检查与人工接手 |
| `--account` | 显示名片段检查；quota 的 account 使用事件记录里的完整标签 |
| `--think` | 打开网页中可见的 Think 开关 |
| `--ref` | 可重复指定参考图，上传后逐个检查芯片 |
| `--candidates` | 1–20，独立候选按文件名加序号；失败后不继续发送 |

JSON 结果的 `outputs` 数组包含输出路径或正文。部分失败也会保留已完成输出。
网页偶尔为新对话返回浏览器本地的临时会话 URL；工具会以 `CONVERSATION_TRANSIENT` 提示它可能不能重开。需要继续新会话时可用 `--keep-open`，待网页给出持久会话地址后再续问。已有会话加载中跳走会明确报错，避免发到另一会话。
诊断写 stderr；`--help`/`--version` 输出文本。退出码：0 成功，1 执行失败，2 参数/输入错误，3 限额，4 发送状态不明。

发送状态不明时先查看会话，勿自动重试。所有命令只操作自己创建的页，且不会清除已有草稿。
文本回收需要约 15 秒正文稳定窗；设置过短的 timeout 会明确失败，不会跳过稳定检查。清理另有独立的有界等待。
切号会改变该浏览器 profile 的共享登录状态；邮箱 SSO 要求精确邮箱，`--google` 可使用已有 Google 登录并报告实际邮箱。遇到密码、验证码、注册或人机检查时停止，详见 [切号说明](docs/account.md)。

## 数据、测试与贡献

运行记录默认在平台用户数据目录，可用 `CHATGPT_WEB_DATA_DIR` 覆盖。没有账号清单、cookie、密码或硬编码用量基线随包分发。
本地台账只表示已观察到的事件，不是服务端余额。锁限同一主机；不同锁协议版本不能混跑。

```sh
npm run check
npm test
npm run test:coverage
```

配置 `CHATGPT_WEB_TEST_CHROME` 为本地 Chrome 可执行文件后，测试会额外运行真实浏览器与本机 HTML 夹具；不配置时明确跳过该集成测试。
[测试范围与验收结果](docs/testing.md) 区分离线测试、本地浏览器测试和真实站点验证，未实测的平台不宣称通过。

参阅 [重构方案](docs/refactor-plan.md)、[贡献规范](CONTRIBUTING.md)、[问题报告与隐私](SECURITY.md) 和 [迁移说明](docs/migration.md)。项目以 [MIT](LICENSE) 许可分发。
