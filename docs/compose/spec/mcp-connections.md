---
feature: mcp-connections
status: delivered
updated: 2026-11-11
source: mcp-connections
---

# MCP 连接管理：注册表 + 桌面面板 + 真连接测试 + 专家引用

## Report

**What was built** — 本机 MCP 服务器注册表 `~/.config/mastra-l2/mcp.json`（数据驱动；秘钥只收 `secret:<vault_id>` 引用，疑似明文令牌拒入库；原子写）+ 真连接测试（`@mastra/mcp` 真握手列工具，区分连不上/零工具，超时 30s，不回显 env 值）+ 桌面 MCP 卡片（列表/一键测试/增删改/启用停用/删除二次确认，失败行内可见 ✗）+ 专家 `mcp_json` 的 `use:[id]` 注册表引用（内联同名覆盖，缺失/停用跳过但经进度播报留痕不许无声）。单一实现：`mcp-registry.ts`（校验/合并/toClientServerEntry）+ `mcp-test.ts`（真握手，@mastra/mcp 懒加载）+ `secret-resolver.ts`（从 expert-agent 提取共用）+ `mcp-cli.ts`（list/show/set/remove/test，结果一律 JSON 落 stdout）经 Rust `mcp_cli`/`run_node_cli` 供面板调用；bundle 资源 l2-pkg（含 `package.json {"type":"module"}`）脱离源码树可用（`test` 缺依赖时明确报错不崩）。

**Verification** — tsc（build+check）/ cargo check / cf:build / tauri:build 全绿（204.92MB app，l2-pkg 9 件）。单测（tsx，HOME 隔离）：注册表合并/覆盖/跳过/校验/原子写/毒条目可删 PASS；experts `use` 校验 PASS；明文令牌拒入库 PASS。真链路：`use:["fs"]` → 真握手 `@modelcontextprotocol/server-filesystem` 16 工具 PASS（~7.6s，计时器修复后即退）；面板点「测试」→ 行内 ✓ 16 工具 · 7.6s + LOG（截图）；全链 E2E：d1 专家 `mcp_json='{"use":["fs","ghost"]}'` → 本地 claim → `[expert] ⚠️ MCP 注册表缺/停用：ghost，已跳过` → fs 服务器真拉起 → 任务 completed → 房间回复含 readme.txt 原文 `hello`（截图+日志）；l2-pkg 拷贝到 /tmp 脱树 `list/show/set/remove` 可用、`test` 明确报错。证据集 `docs/compose/spec/mcp-connections-evidence/`（8 件）。

**评审修复记录（先修后合）** — 首轮评审 1 critical + 4 major 全修：① 打包脱树 TLA/CJS 崩 + @mastra/mcp 不可加载 → l2-pkg/package.json + 懒加载明确报错；② Promise.race 悬挂计时器拖满 30s → clearTimeout/unref；③ renderMcp innerHTML XSS → esc() 全转义；④ 编辑丢字段（note/enabled/requireToolApproval）→ show 取原值合并 + 复选框权威语义；⑤ 失败不可见（stderr 吞 stdout JSON）→ fail() 全 JSON exit0 + Rust 回 stdout + 行内 ✗。复审残留 minor 亦清：env 改行分隔防逗号截断、毒条目可删（raw 增删）、删除二次确认。

**已知边界（不阻合入）** — 完整依赖（@mastra/mcp 等）仍以源码树/monorepo 为界（claim loop 同界，AGENTS.md §7.4 backlog）；打包 app 的 list/set/remove/show/registry 管理已独立可用，`test` 缺依赖时给出明确指引。HTTP MCP 鉴权 headers 未扩（S3）。

## [S1] Problem

专家只能在 `agent_defs.mcp_json` 里内联 MCP 服务器配置，没有任何管理界面：装没装、连不连得上、配置错没错都看不见——`buildMcpClient` 握手失败还静默降级为无工具，专家悄悄少能力。用户需要像 Harness 卡片那样的 MCP 连接管理面板：一份可配置的服务器注册表、本机真实连接测试、增删改、以及专家按 id 引用注册表（不再复制粘贴配置）。

## [S2] Design

### S2.1 MCP 服务器注册表（数据驱动，不写死）

- 注册表文件 `~/.config/mastra-l2/mcp.json`（本机配置，检测/测试结果不上云，与 harnesses.json 同一隐私立场；秘钥只允许 `secret:<vault_id>` 引用，明文令牌不入库——安全硬约束）。
- 格式：`{ "servers": { "<id>": { "name"?, "command"? | "url"?, "args"?: [], "env"?: { "<K>": "值 | secret:<vault_id>" }, "requireToolApproval"?: bool, "enabled"?: bool, "note"? } } }`；`command` 与 `url` 二选一（stdio / HTTP），校验同 experts.ts 现行 mcp server 规则（未知字段拒）。
- 单一实现 `src/l2/mcp-registry.ts`：`loadRegistry()`（读文件+校验）、`upsertServer(id, def)`、`removeServer(id)`、`resolveMcpConfig(mcpJson)`（见 S2.4）。`enabled:false` 的条目不参与引用解析与测试（面板可重新启用）。

### S2.2 连接测试（真调用，无 mock）

- `apps/l2-desktop/scripts/mcp-cli.ts`（单一实现复用 mcp-registry，harness-cli 同款模式）：`list`（JSON 状态）、`set <id> <json>`、`remove <id>`、`test <id>`。
- `test`：按条目起真实 `@mastra/mcp` MCPClient（stdio 起子进程 / HTTP 连 URL），`listToolsets()` 握手，返回 `{ok, id, tools:[名称], ms, error?}`。env 中 `secret:<vault_id>` 经 L1 `/l2-secret`（设备令牌）解析后注入，解析失败即报错退出。
- 测试输出与面板日志**不得回显 env 值**（只报变量名）；超时 30s 判失败。

### S2.3 桌面 MCP 卡片（P2）

- l2-desktop 侧栏 Harness 卡片之下新增 **MCP 卡片**：服务器列表（id/名称/command|url/启用/上次测试结果）、每行 **测试连接**、**新增/编辑** 表单（id、name、command 或 url、args、env 键值对——值支持 `secret:` 引用并提示、requireToolApproval）、启用/停用、删除（需二次确认文案）。
- Rust 命令 `mcp_cli` 包装 `mcp-cli.ts`（package_root/bundle resources 同 harness 机制，脚本+registry 进 l2-pkg）；增删改后列表刷新，状态与日志只留本机面板。

### S2.4 专家 mcp_json 引用（use）

- `mcp_json` 扩展：`{"servers": {...内联...}, "use": ["<注册表id>", ...]}`。`servers` 与 `use` 至少一个非空（experts.ts 校验放宽：仅有 use 也合法；`use` ≤ 10 条、id 格式同注册表）。
- 解析（L2 侧 `resolveMcpConfig`）：`use` 条目按 id 从注册表取 def（`enabled:false` 视为缺失）；与内联 `servers` 合并，**同名内联覆盖注册表**；产物仍是 `{servers: {...}}` 喂给 buildMcpClient，形态不变。
- 错误行为：缺失/停用的 use id **跳过该条并打日志/进度一句**（不挂任务，延续握手失败降级语义，但不再无声）；面板与 `mcp-cli test` 可先行发现此类错配。

### S2.5 权限与秘钥边界

- `requireToolApproval` 照旧透传 MCPClient（专家工具面自行裁决）；`secret:` 解析继续走 secret-pipeline（secretRef 句柄，明文只进 MCP 子进程 env，不进模型上下文/日志/面板）。

## [S3] Out of Scope

- 对话工坊/Web 里的 mcp_json 编辑 UI（工坊照旧走 draft/save_expert；本片只加 `use` 校验）
- HTTP MCP 的鉴权 headers 扩展（现行 requestInit.headers 为空，保持现状）
- MCP 连接池化/常驻复用（仍每任务独立生命周期）
- 云电脑/沙箱内的 MCP 检测与测试（本机）
- 非 MCP 工具源（本地 toolset）管理

## Tasks

- [x] T1: mcp-registry.ts（load/upsert/remove/校验 + resolveMcpConfig use 合并）+ 格式契约 — acceptance: 单测真跑——use 引用合并、内联覆盖、缺失 id 跳过降级、enabled:false 排除、非法 def 拒 — ✅ ALL PASS（含原子写/毒条目可删/明文令牌拒）
- [x] T2: buildMcpClient 接 resolveMcpConfig + experts.ts 校验收 use — acceptance: 真 MCP server 经 use 引用真握手拿到工具列表 — ✅ filesystem 16 工具；全链 E2E ghost 降级留痕 + hello 回流
- [x] T3: mcp-cli（list/show/set/remove/test）+ Rust 命令 + 桌面 MCP 卡片 — acceptance: 面板展示注册表并一键真测试出工具数；增删改落文件即生效 — ✅ 面板截图（✓ 16 工具 · 7.6s + LOG）
- [x] T4: E2E + **截图/终端证据入 Report** — acceptance: 全链截图/终端证据；构建绿 — ✅ evidence/ 8 件 + tsc/cargo/cf/tauri 全绿

## Journey log

- 2026-11-10 spec 起草（范围轴经确认：面板+注册表+专家引用一并打通）；T1–T3 实现；真握手实证发现 `inheritDefaultEnv:false` 会压制默认环境（含 PATH）导致 stdio npx 服务器必炸——沿用 MCPClient 默认 curated env。
- 可迁移经验：打包 l2-pkg 需自带 `package.json {"type":"module"}`（否则顶层 await 脱树即崩）；测试类 Promise.race 必须 clearTimeout/unref；注册表读时过滤会让毒条目删不掉——增删走原始结构。
