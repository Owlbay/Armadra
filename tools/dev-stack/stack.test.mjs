import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseYaml } from "../ci/workflow-yaml.mjs";
import {
  CLOUD_SRC_FILE,
  COMPOSE_FILE,
  HERE,
  dockerStatus,
  parseArgs,
  resolveCloudSrc,
} from "./dev-stack.mjs";
import {
  RELAY_PERSONAL,
  SERVICES,
  SCOPED_PROFILES,
  SUPPORT_SERVICES,
  get,
  profilesOf,
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
      assert.equal(service.build.dockerfile, "apps/server/docker/Dockerfile");
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
  // 服务器壳的正式镜像（G3-5）：基础镜像经 `ARG NODE_IMAGE` 给出，缺省值钉版本。
  const dockerfile = readFileSync(
    join(HERE, "../../apps/server/docker/Dockerfile"),
    "utf8",
  );
  const from = /^ARG NODE_IMAGE=(\S+)/m.exec(dockerfile)[1];
  assert.match(from, /:\d+\.\d+\.\d+-/, `NODE_IMAGE ${from} is pinned`);
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
    assert.deepEqual(
      service.profiles ?? [],
      profilesOf(listed),
      `${name} profile`,
    );
  }
  for (const service of SERVICES)
    assert.ok(compose.services[service.name], `${service.name} is in compose`);
});

test("platform / personal 自成一体，只选各自的服务", () => {
  const names = (profiles) =>
    selectServices({ profiles })
      .map((s) => s.name)
      .sort();
  assert.deepEqual(names(["personal"]), [
    "armadra-server-nat-personal",
    "relay-personal",
  ]);
  assert.deepEqual(names(["platform"]), [
    "armadra-server-nat",
    "cloud",
    "platform-postgres",
    "platform-redis",
    "relay",
  ]);
  assert.ok(!names(["platform", "personal"]).includes("release"));
  // 默认那组不含平台服务；平台服务要点名才能单选。
  const defaults = selectServices().map((s) => s.name);
  for (const name of [
    "cloud",
    "relay",
    "relay-personal",
    "armadra-server-nat",
    "armadra-server-nat-personal",
  ])
    assert.ok(!defaults.includes(name), name);
  assert.deepEqual(SCOPED_PROFILES, ["platform", "personal"]);
  // 没有发布端口的服务只能走容器 healthcheck 这条检查。
  assert.deepEqual(
    SERVICES.find((s) => s.name === "armadra-server-nat").ports,
    [],
  );
});

test("relay-personal：issuer 取宿主机可达的映射端口，NAT 后的 core 共用其网络并自动登记", () => {
  const relay = compose.services["relay-personal"];
  const port = SERVICES.find((s) => s.name === "relay-personal").ports[0];
  assert.equal(RELAY_PERSONAL.port, port);
  assert.equal(RELAY_PERSONAL.issuer, `https://127.0.0.1:${port}`);
  // --port（issuer 的端口）、监听端口与发布端口三者同一个，不是容器内端口。
  const args = relay.command;
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after("--host"), "127.0.0.1");
  assert.equal(after("--port"), String(port));
  assert.equal(after("--listen"), `0.0.0.0:${port}`);
  assert.deepEqual(relay.ports, [`127.0.0.1:${port}:${port}`]);
  assert.match(after("--tls"), /self-signed/);

  const nat = compose.services["armadra-server-nat-personal"];
  assert.equal(nat.network_mode, "service:relay-personal");
  assert.deepEqual(nat.ports ?? [], []);
  assert.equal(nat.environment.ARMADRA_CLOUD_ISSUER, RELAY_PERSONAL.issuer);
  for (const name of [
    "ARMADRA_CLOUD_REGISTRATION_TOKEN",
    "ARMADRA_CLOUD_FINGERPRINT",
  ])
    assert.ok(name in nat.environment, name);
  // 令牌只来自调用方的进程环境，compose 文件里不写字面值。
  assert.match(
    nat.environment.ARMADRA_CLOUD_REGISTRATION_TOKEN,
    /^\$\{ARMADRA_CLOUD_REGISTRATION_TOKEN:-\}$/,
  );
  assert.deepEqual(nat.profiles, ["personal"]);
  assert.ok(compose.volumes["armadra-server-nat-personal"] !== undefined);
});

test("平台服务的 compose 依赖与服务表一致，密钥只来自 dev.env", () => {
  const text = readFileSync(COMPOSE_FILE, "utf8");
  for (const variable of ["PLATFORM_DB_PASSWORD", "ARMADRA_CLOUD_MASTER_KEY"])
    assert.match(text, new RegExp(`\\$\\{${variable}:\\?`), variable);
  assert.equal(
    compose.secrets.personal_relay_password.environment,
    "PERSONAL_RELAY_PASSWORD",
  );
  for (const service of SERVICES) {
    for (const dependency of service.dependsOn ?? []) {
      assert.ok(
        compose.services[dependency],
        `${service.name} -> ${dependency}`,
      );
    }
  }
  // cloud / relay 连的是平台自己的 postgres / redis，不是别处的。
  const cloudEnv = compose.services.cloud.environment;
  assert.match(
    cloudEnv.ARMADRA_CLOUD_DATABASE_URL,
    /@platform-postgres:5432\//,
  );
  assert.equal(cloudEnv.ARMADRA_CLOUD_REDIS_URL, "redis://platform-redis:6379");
  assert.equal(
    compose.services.relay.environment.RELAY_REDIS_URL,
    "redis://platform-redis:6379",
  );
  assert.deepEqual(compose.services["armadra-server-nat"].ports ?? [], []);
});

test("ARMADRA_DEV_STACK_CLOUD_SRC：本地构建叠加文件与目录解析", () => {
  const overlay = parseYaml(readFileSync(CLOUD_SRC_FILE, "utf8"));
  for (const name of ["cloud", "relay", "relay-personal"]) {
    assert.ok(compose.services[name], `${name} is in compose`);
    assert.match(
      overlay.services[name].build.context,
      /ARMADRA_DEV_STACK_CLOUD_SRC/,
    );
    assert.match(
      overlay.services[name].build.dockerfile,
      /^apps\/(cloud|relay)\/Dockerfile$/,
    );
  }
  const fake = mkdtempSync(join(tmpdir(), "cloud-src-"));
  try {
    mkdirSync(join(fake, "apps", "cloud"), { recursive: true });
    writeFileSync(join(fake, "apps", "cloud", "Dockerfile"), "FROM scratch\n");
    assert.equal(resolveCloudSrc({ ARMADRA_DEV_STACK_CLOUD_SRC: fake }), fake);
    assert.throws(
      () => resolveCloudSrc({ ARMADRA_DEV_STACK_CLOUD_SRC: join(fake, "no") }),
      /不是 armadra-cloud 的克隆/,
    );
    // 变量没设时看仓库旁边的 cloud。
    const parent = mkdtempSync(join(tmpdir(), "cloud-sibling-"));
    try {
      const repo = join(parent, "armadra");
      mkdirSync(repo);
      assert.equal(resolveCloudSrc({}, { repoRoot: repo }), null);
      mkdirSync(join(parent, "cloud", "apps", "cloud"), {
        recursive: true,
      });
      writeFileSync(
        join(parent, "cloud", "apps", "cloud", "Dockerfile"),
        "FROM scratch\n",
      );
      const notes = [];
      assert.equal(
        resolveCloudSrc({}, { repoRoot: repo, note: (l) => notes.push(l) }),
        join(parent, "cloud"),
      );
      assert.equal(notes.length, 1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test("根 package.json 的 platform:* 脚本指向 dev-stack 的对应 profile", () => {
  const scripts = JSON.parse(
    readFileSync(join(HERE, "../../package.json"), "utf8"),
  ).scripts;
  assert.match(scripts["platform:up"], /dev-stack\.mjs up --profile platform$/);
  assert.match(
    scripts["platform:down"],
    /dev-stack\.mjs down --profile platform$/,
  );
  assert.match(
    scripts["platform:health"],
    /dev-stack\.mjs health --profile platform$/,
  );
  assert.match(
    scripts["platform:personal"],
    /dev-stack\.mjs up --profile personal$/,
  );
  assert.ok(scripts["platform:e2e"]);
});

test("platform:e2e 的每一条都在 e2e 清单里、档位对得上；预留的没有清单条目", async () => {
  const { PLAN, RESERVED } = await import("./platform-e2e.mjs");
  const { loadManifest } = await import("../ci/e2e.mjs");
  const entries = loadManifest().entries;
  for (const step of PLAN)
    for (const id of step.only) {
      const entry = entries.find((one) => one.id === id);
      assert.ok(entry, `${id} 不在 tools/ci/e2e.d/`);
      assert.equal(entry.tier, step.tier, `${id} 的档位`);
    }
  for (const item of RESERVED)
    assert.ok(
      !entries.some((one) => one.id === item.id),
      `${item.id} 预留着，不该有清单条目`,
    );
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
        "--profile",
        "platform",
        "--profile",
        "personal",
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
          PLATFORM_DB_PASSWORD: "x",
          PERSONAL_RELAY_PASSWORD: "x",
          ARMADRA_CLOUD_MASTER_KEY: "x",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);
