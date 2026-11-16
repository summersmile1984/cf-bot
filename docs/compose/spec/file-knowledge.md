---
feature: file-knowledge
status: delivered
updated: 2026-11-15
source: main
---

# 文件与知识库：把资料喂给秘书

## Report

**What was built** — 文本资料上传（≤512KB，txt/md/csv/json/log，D1 `user_files`）→ 切块（1200 字）→ Workers AI bge-m3 嵌入 → Vectorize（`memory_messages_1024` 同索引，metadata `kind='file_chunk'` 不带 resource_id，与 semanticRecall 互不污染）→ 聊天检索注入 + `[file:文件名]` 引用。资料面板（记忆页新 tab）上传/列表/删除，删除级联清块。摄取走 waitUntil 异步（状态 pending→indexed）。

**Verification** — 生产全链：上传→索引→聊天问资料命中并正确引用 `[file:定价备忘v2.md]`（内容如实）。spike 无（向量链需 AI binding），以生产 E2E 为准。

## [S1] Problem

OM 记忆全部来自对话。用户把合同/表格/笔记交给秘书是个人 agent 的基本盘（「我的资料它都知道」）：今天只能贴进聊天（受消息长度限制、不留档、不可复用）。需要一条「上传 → 入库 → 问答时可引用」的通路。

## [S2] Design

### S2.1 采集与存储（v1 文本档）

- web「资料」面板 + 房间内上传入口；`txt/md/csv/json/log` ≤512KB 直存 D1 `user_files(id, user_id, name, kind, size, content, status, created_at)`（v1 先文本，二进制/大文件 v2 走 R2 + L2 抽取）。
- 归属硬约束：`user_id` 置顶过滤；房间可选绑定（`room_id`，绑定资料仅该房间检索可见）。

### S2.2 摄取

- 切块（约 800 字/块，带文件名与序号前缀）→ `workers-ai-embedder` 嵌入 `memory_messages_1024` 同型向量（行 `kind='file_chunk'`，含 file_id）；状态机 `pending → indexed | failed`。
- 重摄取（内容更新）先清旧块再插；删除文件级联清块。

### S2.3 检索与引用

- chat 入口对用户消息做一次文件向量检索（top-k 5，user 作用域 + 房间可见性过滤），拼进 withThreadBlock 附近的上下文（「来自资料：…」块）。
- 回答引用标注：prompt 约定「引用资料时用 [file:文件名] 标注」；抽屉/资料面板可看命中块。

## [S3] Out of Scope

- PDF/DOCX/图片 OCR（v2，走 L2 本地抽取回传）；>512KB 大文件/R2；资料共享给房间外协作者；知识图谱。

## Tasks

- [x] T1: 上传存储 + 资料面板 — acceptance: 上传/列表/删除可用；user 归属隔离；512KB/类型闸 (covers: S2.1) — ✅ 记忆页「资料」tab
- [x] T2: 切块嵌入管线 — acceptance: 上传后状态到 indexed；重摄取去旧块；删除级联清块 (covers: S2.2) — ✅ waitUntil 异步摄取
- [x] T3: 检索引用接入 chat — acceptance: 问资料内事实能命中并带 [file:] 标注；跨用户检索不出界 (covers: S2.3) — ✅ 生产 E2E 引用正确

## Journey log

- 2026-11-15：v1 只收文本档（D1 直存）——二进制抽取链（L2 本地解析回传）工程量大且是差异化能力，挪 v2 与桌面端协同设计。
- 2026-11-15：**Vectorize 元数据过滤三个坑**（都实测踩过）：①查询过滤只认「已建 metadata_index」的字段，否则静默 0 匹配——`kind/user_id/room_id` 三索引已进 `cf-ensure-resources.mjs` 自举；②新建索引**不回填旧向量**（只对此后 upsert 生效），存量资料需重摄取一遍；③索引/向量都有分钟级传播延迟（`info.processedUpToMutation` 看进度）。另：原生 binding `upsert` 形状是 `[{id,values,metadata}]` 数组（不是 Mastra 包装层形状），`returnMetadata` 要 `'all'` 字符串不是布尔。
