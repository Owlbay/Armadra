-- 源与远程服务的缺省名称（契约 §61）：label 仍是显示的名字（§33 的形状不变），
-- default_label 是服务端报的名字——直连主机的 hello `hostName`、个人中转的
-- platform.info `name`、远程服务目录里的源名称、本机的「主机名称」设置。
-- 用户改过名的行 label ≠ default_label；改名为空即恢复成 default_label。
-- 旧行无从分辨是不是改过名，按「没改过」回填：default_label = label。
ALTER TABLE client_sources ADD COLUMN default_label TEXT NOT NULL DEFAULT '' CHECK(length(default_label) <= 128);
ALTER TABLE remote_services ADD COLUMN default_label TEXT NOT NULL DEFAULT '' CHECK(length(default_label) <= 128);
UPDATE client_sources SET default_label = label;
UPDATE remote_services SET default_label = label;
