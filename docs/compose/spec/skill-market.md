---
feature: skill-market
status: designed
updated: 2026-11-15
source: main
---

# Skill 市场 v0.1：专家模板与导入导出

---
feature: skill-market
status: delivered
updated: 2026-11-15
source: main
---

# Skill 市场 v0.1：专家模板与导入导出

## Report

**What was built** — 内置 6 个精选专家模板（周报/代码审查/翻译润色/行程规划/数据分析/文案策划，`expert-templates.json`）+ `GET /agent-defs/templates` + L2 控制台「模板」区一键复制；专家 JSON 导出（剔内部字段下载）/ 导入（白名单字段 + 同名自动改名 xxx(2)）。

**Verification** — 生产烟测：模板 6 个下发；同名导入两次得「周报助手 / 周报助手(2)」；web tsc 绿。

## [S1] Problem

专家（instructions/tools/mcp 配置）是产品厚度所在，但今天每个用户都得从零手搓：没有起步模板、没有分享搬运通道。零成本高杠杆的一步：**精选模板开箱即用 + JSON 导出分享**——「市场」的心智先立起来，托管交易后置。

## [S2] Design

### S2.1 模板目录

- `src/mastra/expert-templates.json`：精选 6 个起步模板（周报助手、代码审查员、翻译润色、行程规划、数据分析师、文案策划），字段与 agent_defs 对齐（name/description/instructions/model 可选）。
- `GET /agent-defs/templates`（会话鉴权）返回目录；L2 控制台「专家」tab 加「模板」区：卡片 + 「复制到我的专家」（走既有 POST /agent-defs，改名防冲突）。

### S2.2 导入 / 导出

- 导出：专家行「导出」按钮 → 前端下载 `<name>.json`（仅 name/description/instructions/model/tools_json/mcp_json/skills_json/memory_json，剔除 id/时间戳）。
- 导入：「导入」按钮 → 文件选择 → `POST /agent-defs/import`（校验字段白名单 + 长度上限，同名自动改名 `xxx(2)`）。
- 分享 = 把导出的 JSON 发给对方导入（不引入链接托管）。

## [S3] Out of Scope

- 托管市场（上传/评分/付费下载/审核）、模板自动更新、团队共享模板库。

## Tasks

- [x] T1: 模板目录 — acceptance: templates 接口返回 ≥6 个精选模板；一键复制入我的专家且可直接使用 (covers: S2.1) — ✅ 6 模板，复制走 import 通道（带改名）
- [x] T2: 导入/导出 — acceptance: 导出 JSON 不含内部字段；导入白名单校验、同名改名；坏文件报错可读 (covers: S2.2) — ✅ 生产烟测改名链

## Journey log

- 2026-11-15：定位「模板 + 搬运」而非托管市场——先验证用户是否真的要复用专家；真有人传起来再上托管。
