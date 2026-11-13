# cf-bot — Your Personal AI Secretary

**English** · [中文](#中文)

An open-source, self-hosted AI secretary with a two-layer architecture: a cloud **L1** orchestrator (chat, memory, scheduling, pages) and a desktop **L2** execution agent (runs tasks on *your* PC via ACP harnesses — your files, your logins, your privacy).

> **Don't want to self-host?** The managed SaaS edition is available — see the product site. This repo is the self-deployable edition under the [Fair Source license](#license).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/summersmile1984/cf-bot)

## Features

- **Chat-first secretary** — rooms & topic threads (it files work into topics on its own), one-line conclusions in the main chat, details in the dossier
- **Long-running tasks** — dispatch to the desktop agent; live one-line progress, artifacts, and HTML pages published to shareable URLs (Cloudflare Pages)
- **Experts** — forge specialized sub-agents from conversation; MCP integrations (marketplace + OAuth)
- **Memory** — observational memory you can view, edit, and export (no black box)
- **Scheduling** — cron routines in natural language; **secrets vault** with HITL approval
- **White-label** — product name is data, not code: change it in Settings

## Quick start (≈5 minutes)

1. Click **Deploy to Cloudflare** above (you need a free Cloudflare account). D1, Durable Objects, Queues, Vectorize and Workers AI are provisioned automatically.
2. Add two secrets when prompted: **`DEEPSEEK_API_KEY`** (platform.deepseek.com) and **`BETTER_AUTH_SECRET`** (`openssl rand -hex 32`).
3. Open your `*.workers.dev` URL — the **first-run setup wizard** greets you: create the admin account (first user = admin), then a config checklist (DeepSeek key / public URL / product name). Registration is closed by default after setup; re-open it anytime in Settings.
4. *(Optional, for heavy tasks)* Install the desktop agent from [Releases](../../releases), point `L1_PULL_URL` at your deployment, and let it claim tasks.

Manual deploy: `npm install && npm run cf:build && npx wrangler deploy -c .mastra/output/wrangler.json` (Node ≥ 22.13).

## Configuration

| Where | What |
|---|---|
| Settings → 产品名称 | White-label product name |
| Settings → 秘书设置 | Persona, prompts, model gateway (DeepSeek by default) |
| Worker vars | `L1_PUBLIC_URL` (your public URL, used for callbacks) |

## License

Fair Source — [Functional Source License 1.1 (ALv2)](LICENSE): free for personal use, education, research, and internal business use; **commercial hosting / competing services are not permitted**; converts to Apache-2.0 two years after each release. The SaaS edition is operated by the original author under the licensor's rights.

---

# 中文

开源可自部署的个人 AI 秘书，两层架构：云端 **L1** 协调（对话/记忆/例程/页面发布）+ 桌面端 **L2** 执行（任务跑在你自己的电脑上——你的文件、你的登录态、你的隐私）。

> **不想自己部署？** 也有托管 SaaS 版。本仓库是自部署版，采用[公平源许可](#license)。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/summersmile1984/cf-bot)

**快速开始**：点上面的 Deploy 按钮（需免费 Cloudflare 账号，数据库等资源自动开通）→ 按提示填 `DEEPSEEK_API_KEY` 与 `BETTER_AUTH_SECRET`（openssl rand -hex 32）→ 打开你的 `*.workers.dev` 域名，**首跑向导**会带你建管理员账号并检查配置；完成后默认关闭注册（管理员可在设置里重开）。重任务装桌面端（Releases）后在本地电脑执行。

**许可**：FSL-1.1-ALv2 公平源——个人/企业内部/教研免费，**禁止商业托管与竞品运营**，每版本两年后转 Apache-2.0。
