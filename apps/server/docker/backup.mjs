// 一致性备份：在容器里经 core 的回环监听调 `POST /api/data/backup`。
//
//   docker compose exec armadra node /app/docker/backup.mjs
//
// core 用 `VACUUM INTO` 在一个读事务里把库复制成
// `<数据目录>/canvas.db.backup-manual-<时间>`（含已提交的 WAL 内容，不会是半页），
// 服务不停。回环监听的地址从 `<数据目录>/endpoints.json` 读，它只在容器里。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.ARMADRA_DATA_DIR ?? "/data";
const endpoints = JSON.parse(
  readFileSync(join(dataDir, "endpoints.json"), "utf8"),
);
const base = endpoints.runtime?.http;
if (typeof base !== "string") {
  console.error("core 没在跑：endpoints.json 里没有回环地址");
  process.exit(1);
}
const answer = await fetch(`${base}/api/data/backup`, { method: "POST" });
const text = await answer.text();
if (!answer.ok) {
  console.error(`备份失败：${answer.status} ${text}`);
  process.exit(1);
}
console.log(text);
