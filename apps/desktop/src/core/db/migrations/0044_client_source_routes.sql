-- 一台主机的多条到达方式（契约 §55）：同一个源可以同时经直连 Gateway 与几个中继到达，
-- 每条路一行。`client_sources` 上的 base_url / relay_origin / fingerprint / cloud_issuer
-- 留作首选路由的镜像（§33 的形状不变）。凭据仍在 SecretStore
-- `armadra-source-<source_id>.byOrigin[origin]`，键就是这里的 origin。
CREATE TABLE client_source_routes (
  source_id     TEXT NOT NULL REFERENCES client_sources(source_id) ON DELETE CASCADE,
  via           TEXT NOT NULL CHECK(via IN ('direct', 'relayed')),
  origin        TEXT NOT NULL CHECK(length(origin) BETWEEN 1 AND 2048),      -- direct：Gateway 来源；relayed：中继来源
  cloud_issuer  TEXT NOT NULL DEFAULT '' CHECK(length(cloud_issuer) <= 2048), -- relayed：经哪个远程服务
  fingerprint   TEXT NOT NULL DEFAULT '' CHECK(length(fingerprint) IN (0, 64)),
  preferred     INTEGER NOT NULL DEFAULT 0 CHECK(preferred IN (0, 1)),
  added_at_ms   INTEGER NOT NULL CHECK(added_at_ms > 0),
  last_ok_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_ok_at_ms >= 0),
  PRIMARY KEY (source_id, via, origin)
) WITHOUT ROWID;

-- 回填直连：有 base_url 的建一条 direct，首选（直连优先）。
INSERT INTO client_source_routes(source_id, via, origin, cloud_issuer, fingerprint, preferred, added_at_ms, last_ok_at_ms)
SELECT source_id, 'direct', base_url, '', fingerprint, 1, added_at_ms, last_ok_at_ms
FROM client_sources
WHERE kind IN ('direct', 'relayed') AND base_url <> '';

-- 回填中继：有 relay_origin 的建一条 relayed。
-- 旧版挂第二个中继时保留旧的 relay_origin、却把 cloud_issuer 写成新的 issuer。
-- relay_origin 本身登记为一个远程服务（个人中转的来源就是 issuer）而与 cloud_issuer
-- 不同时，这一条归还给 relay_origin 那个服务，新的那个另建一条（下一条语句）。
INSERT INTO client_source_routes(source_id, via, origin, cloud_issuer, fingerprint, preferred, added_at_ms, last_ok_at_ms)
SELECT s.source_id, 'relayed', s.relay_origin,
  CASE
    WHEN s.cloud_issuer <> '' AND s.cloud_issuer <> s.relay_origin
      AND EXISTS (SELECT 1 FROM remote_services r WHERE r.issuer = s.relay_origin)
      AND EXISTS (SELECT 1 FROM remote_services r WHERE r.issuer = s.cloud_issuer)
    THEN s.relay_origin
    ELSE s.cloud_issuer
  END,
  '',
  CASE
    WHEN s.base_url <> '' THEN 0
    WHEN s.cloud_issuer <> '' AND s.cloud_issuer <> s.relay_origin
      AND EXISTS (SELECT 1 FROM remote_services r WHERE r.issuer = s.relay_origin)
      AND EXISTS (SELECT 1 FROM remote_services r WHERE r.issuer = s.cloud_issuer)
    THEN 0
    ELSE 1
  END,
  s.added_at_ms, s.last_ok_at_ms
FROM client_sources s
WHERE s.kind IN ('direct', 'relayed') AND s.relay_origin <> '';

-- 拆出来的新中继：来源取它的 issuer；它是旧版最后一次挂载的那条，没有直连时作首选。
INSERT INTO client_source_routes(source_id, via, origin, cloud_issuer, fingerprint, preferred, added_at_ms, last_ok_at_ms)
SELECT s.source_id, 'relayed', s.cloud_issuer, s.cloud_issuer, '',
  CASE WHEN s.base_url <> '' THEN 0 ELSE 1 END,
  s.added_at_ms, s.last_ok_at_ms
FROM client_sources s
WHERE s.kind IN ('direct', 'relayed') AND s.relay_origin <> ''
  AND s.cloud_issuer <> '' AND s.cloud_issuer <> s.relay_origin
  AND EXISTS (SELECT 1 FROM remote_services r WHERE r.issuer = s.relay_origin)
  AND EXISTS (SELECT 1 FROM remote_services r WHERE r.issuer = s.cloud_issuer);

-- 镜像跟上：拆过的行以新中继那条为镜像（旧版的 session() 走的就是它），
-- relay_origin 与 cloud_issuer 重新成对。
UPDATE client_sources SET relay_origin = cloud_issuer
WHERE kind IN ('direct', 'relayed') AND relay_origin <> ''
  AND cloud_issuer <> '' AND cloud_issuer <> relay_origin
  AND EXISTS (SELECT 1 FROM remote_services r WHERE r.issuer = client_sources.relay_origin)
  AND EXISTS (SELECT 1 FROM remote_services r WHERE r.issuer = client_sources.cloud_issuer);
