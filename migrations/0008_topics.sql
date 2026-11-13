-- 主题 IA（topic-ia S2.1）：rooms 扩主题卷宗字段。幂等：列已存在则跳过（应用层 ensureTopicCols 同步兜底）。
-- kind: 'main' 主会话 | 'room' 多人共享房间 | 'topic' 单人主题卷宗
-- status: 'active' | 'archived'（收卷）
ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'room';
ALTER TABLE rooms ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE rooms ADD COLUMN summary TEXT;
ALTER TABLE rooms ADD COLUMN last_topic_id TEXT;
UPDATE rooms SET kind = 'main' WHERE is_main = 1 AND kind = 'room';
