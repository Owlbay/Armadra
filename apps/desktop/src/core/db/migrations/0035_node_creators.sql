-- 节点的触发者（补全架构 §8.2「创建者 = 触发者」，契约 §23）。
--
-- 0028 把终端的创建者落进了会话行，但只有「人从页面开终端」那一条路会写它。
-- Agent 用控制动词（`open-agent` / `open-terminal` / `team`）建的节点、工作流
-- 起的角色节点，终端是之后才起的：页面挂载时由**随便哪个看着画布的人**起，或
-- 由依赖编排在 core 里起。前者把创建者记成那个恰好挂载的人，后者记成空串
-- （owner）——都不是触发这件事的人。于是 operator 起的协调者，审批不了自己
-- 团队里的成员。
--
-- 这张表在建节点的那一刻记下触发者：控制动词记调用方节点终端的创建者，工作流
-- 记起跑的人。它只由 core 写，不在画布文档里——编辑者能改节点数据，但改不了
-- 谁是触发者。空串仍是「本机 owner 或 core 自己」。
--
-- 触发器让**每一条**起终端的路（页面、依赖编排、ACP、切换驱动、日后的 runner）
-- 都继承它，而不是在七个调用点上各写一遍。新行的 `creator_principal_id` 恒为
-- 空串（插入不写这一列），触发器只在节点有记录时覆盖；没有记录的节点保持 0028
-- 的判法。定时冷启动按规则继承自动化的创建者，由调用方在起完之后显式写回。
--
-- 不挂外键：与 0028 同理，节点在画布文档里，删节点或删账号都不该连带改写历史。
CREATE TABLE node_creators (
  node_id       TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  principal_id  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TRIGGER terminal_sessions_inherit_creator
AFTER INSERT ON terminal_sessions
WHEN NEW.owner_node_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM node_creators WHERE node_id = NEW.owner_node_id)
BEGIN
  UPDATE terminal_sessions
     SET creator_principal_id =
         (SELECT principal_id FROM node_creators WHERE node_id = NEW.owner_node_id)
   WHERE id = NEW.id;
END;
