-- 授予的来源、租约与范围（契约 §60）。旧行全部落在缺省值上：本地授予（origin = ''）、
-- 不过期（expires_at_ms = 0）、指向一个工作空间（target_kind = 'workspace'）——行为不变。
--
-- origin：'' = 本机 owner / 邀请给的；'cloud:<issuer 摘要>' = 经云登录按断言同步的，
--   下一次同一签发方的登录整份替换它们，本地授予不动。
-- expires_at_ms：租约到期时刻；0 = 不过期。云端来的授予每次登录续租。
-- target_kind：'host' = 整台（workspace_id 记 '*'，不是任何合法的工作空间 id）；
--   'workspace' = 一个工作空间；'session' = 那个工作空间里的一个终端 / ACP 会话（只读）。
-- target_id：会话 id；其余两种为空串。
ALTER TABLE identity_grants ADD COLUMN origin TEXT NOT NULL DEFAULT '' CHECK(length(origin) <= 64);
ALTER TABLE identity_grants ADD COLUMN expires_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(expires_at_ms >= 0);
ALTER TABLE identity_grants ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'workspace'
  CHECK(target_kind IN ('host', 'workspace', 'session'));
ALTER TABLE identity_grants ADD COLUMN target_id TEXT NOT NULL DEFAULT '' CHECK(length(target_id) <= 256);

-- 一个主体对同一个目标同时只有一条有效授予；同一工作空间上的工作空间授予与会话授予
-- 是不同的目标，可以并存。
DROP INDEX identity_grants_one_live_per_subject;
CREATE UNIQUE INDEX identity_grants_one_live_per_target
  ON identity_grants(subject_kind, subject_id, target_kind, workspace_id, target_id)
  WHERE revoked_at_ms = 0;

CREATE INDEX identity_grants_by_origin
  ON identity_grants(subject_id, origin) WHERE revoked_at_ms = 0 AND origin <> '';

-- 邀请的终点多两种：整台（target_host = 1）与一个会话（target_session_id，须同时给它的工作空间）。
ALTER TABLE identity_invitations ADD COLUMN target_session_id TEXT NOT NULL DEFAULT ''
  CHECK(length(target_session_id) <= 256);
ALTER TABLE identity_invitations ADD COLUMN target_host INTEGER NOT NULL DEFAULT 0 CHECK(target_host IN (0, 1));
