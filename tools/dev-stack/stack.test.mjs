import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseYaml } from "../ci/workflow-yaml.mjs";
import { COMPOSE_FILE, HERE, dockerStatus, parseArgs } from "./dev-stack.mjs";
import {
  SERVICES,
  SUPPORT_SERVICES,
  get,
  selectServices,
} from "./services.mjs";

const compose = parseYaml(readFileSync(COMPOSE_FILE, "utf8"));
const composeServices = Object.entries(compose.services);

/** "127.0.0.1:8090:8090" → { host: "127.0.0.1", published: 8090, target: 8090 } */
function parsePort(spec) {
  const match = /^(\d+\.\d+\.\d+\.\d+):(\d+):(\d+)$/.exec(spec);
  assert.ok(match, `port ${spec} must be host:published:target`);
  return {
    host: match[1],
    published: Number(match[2]),
    target: Number(match[3]),
  };
}

test("compose 可解析，且只用了解析器认识的子集", () => {
  assert.equal(compose.name, "armadra-dev");
  assert.ok(composeServices.length >= 15);
});

test("每个镜像都钉到明确版本", () => {
  for (const [name, service] of composeServices) {
    if (service.build) {
      assert.equal(service.build.context, "../..", name);
      assert.equal(service.build.dockerfile, "tools/dev-stack/Dockerfile.dev");
      continue;
    }
    const image = service.image;
    assert.ok(image, `${name} has an image`);
    const tag = image.slice(image.lastIndexOf(":") + 1);
    assert.ok(
      image.includes(":") && /\d/.test(tag),
      `${name}: ${image} is pinned`,
    );
    assert.doesNotMatch(tag, /latest|nightly|edge|main/, `${name}: ${image}`);
  }
  const dockerfile = readFileSync(join(HERE, "Dockerfile.dev"), "utf8");
  const from = /^FROM (\S+)/m.exec(dockerfile)[1];
  assert.match(
    from,
    /:\d+\.\d+\.\d+-/,
    `Dockerfile.dev FROM ${from} is pinned`,
  );
});

test("端口只绑回环、互不冲突，且与 services.mjs 的端口表一致", () => {
  const seen = new Map();
  for (const [name, service] of composeServices) {
    const ports = (service.ports ?? []).map(parsePort);
    for (const port of ports) {
      assert.equal(port.host, "127.0.0.1", `${name} binds loopback only`);
      assert.ok(
        !seen.has(port.published),
        `${name} and ${seen.get(port.published)} both publish ${port.published}`,
      );
      seen.set(port.published, name);
    }
    const listed = SERVICES.find((s) => s.name === name);
    if (SUPPORT_SERVICES.includes(name)) {
      assert.equal(ports.length, 0, `${name} is internal`);
      continue;
    }
    assert.ok(listed, `${name} is in services.mjs`);
    assert.deepEqual(
      ports.map((p) => p.published),
      listed.ports,
      name,
    );
    assert.equal(service.profiles?.[0], listed.profile, `${name} profile`);
  }
  for (const service of SERVICES)
    assert.ok(compose.services[service.name], `${service.name} is in compose`);
});

test("密钥只从 .data/dev.env 来，compose 里没有写死的口令", () => {
  const text = readFileSync(COMPOSE_FILE, "utf8");
  for (const variable of [
    "KEYCLOAK_ADMIN_PASSWORD",
    "GLITCHTIP_DB_PASSWORD",
    "GLITCHTIP_SECRET_KEY",
  ])
    assert.match(text, new RegExp(`\\$\\{${variable}:\\?`), variable);
  assert.doesNotMatch(text, /PASSWORD: "?[a-z0-9]{6,}"?$/im);
});

test("服务选择与参数解析", () => {
  const defaults = selectServices().map((s) => s.name);
  assert.ok(!defaults.includes("headscale") && !defaults.includes("ntfy"));
  assert.ok(defaults.includes("armadra-server"));
  assert.ok(
    selectServices({ profiles: ["ntfy"] }).some((s) => s.name === "ntfy"),
  );
  assert.deepEqual(
    selectServices({ names: ["dex"] }).map((s) => s.name),
    ["dex"],
  );
  assert.throws(() => selectServices({ names: ["nope"] }), /unknown/);
  assert.deepEqual(parseArgs(["dex", "--profile", "ntfy", "--timeout", "30"]), {
    names: ["dex"],
    profiles: ["ntfy"],
    json: false,
    build: false,
    volumes: false,
    follow: false,
    timeout: 30,
  });
});

test("健康检查只肯打回环地址", async () => {
  await assert.rejects(get("http://example.com/"), /only 127\.0\.0\.1/);
});

test("没有 Docker 时 up 说明原因并退出 0", () => {
  const env = {
    ...process.env,
    ARMADRA_DEV_STACK_DOCKER: join(HERE, "no-such-docker"),
  };
  assert.equal(dockerStatus(env).ok, false);
  const result = spawnSync(
    process.execPath,
    [join(HERE, "dev-stack.mjs"), "up"],
    {
      env,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dev-stack 跳过：没有找到 Docker/);
  const json = spawnSync(
    process.execPath,
    [join(HERE, "dev-stack.mjs"), "health", "--json"],
    {
      env,
      encoding: "utf8",
    },
  );
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).dockerAvailable, false);
});

test(
  "docker compose config 认这份文件",
  { skip: !dockerStatus().ok && "没有 Docker" },
  () => {
    const result = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        COMPOSE_FILE,
        "--profile",
        "headscale",
        "--profile",
        "ntfy",
        "config",
        "--quiet",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          KEYCLOAK_ADMIN_PASSWORD: "x",
          GLITCHTIP_DB_PASSWORD: "x",
          GLITCHTIP_SECRET_KEY: "x",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);
