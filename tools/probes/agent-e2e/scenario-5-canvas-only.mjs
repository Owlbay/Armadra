// 场景 5：画布注入只在画布里生效（设计 canvas-launcher §13.3）。
//
// 注入不在启动行上：`GET /api/agents` 的每行答这台机器上的启动器 `launcher`
// （`<数据目录>/integration/run/<cli>`），行是 `<launcher> <程序> <旗标…>`，启动
// 器只在环境里有 ARMADRA_NODE_ID 时把注入接在调用者的全部参数之后。这里对
// Claude 与 Codex 各跑三遍：
//
//   * 画布内：`<launcher> <程序> … "<prompt>"`，环境带源节点的身份。prompt 是位
//     置参数，注入的旗标落在它后面——两家都得照样接受。Codex 的会话记录里有
//     `[Armadra canvas rules r<N>]` 与完整技能的路径、stderr 有
//     `--dangerously-bypass-hook-trust` 的警告、Hook 打到 core；Claude 的 init
//     里有我们的插件与插件技能、Hook 打到 core。
//   * 画布外重跑同一行：只去掉 ARMADRA_NODE_ID（「shell 历史里重跑」）。没有
//     画布说明、没有插件、Hook 没打到 core。
//   * 行上没有启动器：裸程序，节点身份还在。没有全局安装，所以同样什么都没有。
//
// 「Hook 打到 core」看的是源节点那一行 `agent_status` 的 last_event_at 有没有
// 前进。Codex 用一个只放了 auth.json 的新 CODEX_HOME：三遍跑完里面**没有**
// config.toml——会话级旗标代替了信任记录，数据目录之外一个字节不写。Claude 只能
// 用真实配置目录（钥匙串里的登录只认它），我们对它只经启动器注入、不写它的全
// 局文件；收尾的 fingerprint 守着这一点。
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { note, scenario } from "./lib.mjs";

function run(program, args, options) {
  return new Promise((done) => {
    const child = execFile(
      program,
      args,
      { timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...options },
      (error, stdout, stderr) =>
        done({
          code: error ? (error.code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
    // 两个 CLI 都会等 stdin 上的附加输入：立刻给 EOF。
    child.stdin?.end();
  });
}

/** 临时 CODEX_HOME 里最新的一份会话记录。 */
function newestRollout(codexHome) {
  const files = [];
  const walk = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".jsonl"))
        files.push({ path, at: statSync(path).mtimeMs });
    }
  };
  walk(join(codexHome, "sessions"));
  files.sort((a, b) => b.at - a.at);
  return files[0]?.path;
}

function claudeInit(stdout) {
  for (const line of stdout.split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message.type === "system" && message.subtype === "init")
        return message;
    } catch {}
  }
  return undefined;
}

export default async function run5(ctx) {
  const { api, codexHome, data, project, scratch, source, status } = ctx;
  const s = scenario("5-canvas-only");
  try {
    const rows = await api("/api/agents");
    const runDir = join(data, "integration", "run");
    const row = (id) => rows.find((entry) => entry.id === id);
    for (const id of ["claude", "codex"]) {
      s.check(
        `${id} 的行答数据目录里的启动器，不再答 launchWords / launchArgs`,
        row(id)?.launcher === join(runDir, id) &&
          row(id)?.launchWords === undefined &&
          row(id)?.launchArgs === undefined,
        row(id)?.launcher,
      );
    }
    const claudeLauncher = row("claude")?.launcher;
    const codexLauncher = row("codex")?.launcher;
    const claudeProgram = row("claude")?.resolvedPath || "claude";
    const codexProgram = row("codex")?.resolvedPath || "codex";

    const claudeState = await api("/api/agents/claude/integration");
    const codexState = await api("/api/agents/codex/integration");
    s.check(
      "Claude 的启动器追加 --settings / --plugin-dir / --append-system-prompt-file",
      ["--settings", "--plugin-dir", "--append-system-prompt-file"].every(
        (flag) => claudeState.launchArgs.includes(flag),
      ),
      claudeState.launchArgs,
    );
    const codexHooks = codexState.launchArgs.filter((arg) =>
      arg.startsWith("hooks."),
    );
    s.check(
      "Codex 的启动器追加 --dangerously-bypass-hook-trust、八个 -c hooks.*、developer_instructions、关升级检查",
      codexState.launchArgs[0] === "--dangerously-bypass-hook-trust" &&
        codexHooks.length === 8 &&
        codexState.launchArgs.includes("check_for_update_on_startup=false") &&
        codexState.launchArgs.some((arg) =>
          arg.startsWith("developer_instructions="),
        ),
      {
        hooks: codexHooks.map((arg) => arg.slice(0, arg.indexOf("="))),
        warning: codexState.launcherWarning,
      },
    );
    s.check(
      "集成状态不再列全局写入",
      claudeState.globalWrites.length === 0 &&
        codexState.globalWrites.length === 0,
    );
    const record = JSON.parse(
      readFileSync(join(data, "integration", "global-migration.json"), "utf8"),
    );
    s.check(
      "迁移记录是 version 3：启动只动数据目录，不碰任何 CLI 的配置",
      record.version === 3 &&
        Object.keys(record.agents ?? {}).length === 0 &&
        record.sessionTrust === undefined,
      record,
    );

    // 共用的环境：画布内带源节点的身份，画布外只少这一个变量。
    const inside = { ...process.env };
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "TMUX"])
      delete inside[name];
    inside.ARMADRA_NODE_ID = source.id;
    inside.ARMADRA_ENDPOINT_FILE = join(data, "hook-endpoint.env");
    const outside = { ...inside };
    delete outside.ARMADRA_NODE_ID;
    const lastEvent = () => status(source.id)?.last_event_at ?? null;
    const prompt = "Reply with just OK.";

    /* ------------------------------- Codex -------------------------------- */

    // 新的 CODEX_HOME，只有登录：看跑完之后有没有冒出 config.toml。
    const freshHome = join(scratch, "codex-home-5");
    mkdirSync(freshHome, { recursive: true });
    copyFileSync(join(codexHome, "auth.json"), join(freshHome, "auth.json"));
    const codexEnv = (env) => {
      const next = { ...env, CODEX_HOME: freshHome };
      delete next.CLAUDE_CONFIG_DIR;
      return next;
    };
    // prompt 是位置参数，启动器的注入接在它后面。
    const codexLine = [codexProgram, "exec", "--skip-git-repo-check", prompt];

    let before = lastEvent();
    const codexIn = await run(codexLauncher, codexLine, {
      cwd: project,
      env: codexEnv(inside),
    });
    const inRollout = newestRollout(freshHome);
    const inText = inRollout ? readFileSync(inRollout, "utf8") : "";
    s.check(
      "画布内：Codex 跑完一轮（注入的旗标在 prompt 之后）",
      codexIn.code === 0,
      codexIn.stderr.slice(-300),
    );
    s.check(
      "画布内：Codex 的会话里有带修订标记的画布规则与完整技能的路径",
      /\[Armadra canvas rules r\d+\]/.test(inText) &&
        inText.includes(join("integration", "codex", "skills", "armadra")),
      inRollout,
    );
    s.check(
      "画布内：Codex 打出 --dangerously-bypass-hook-trust 的警告",
      codexIn.stderr.includes("`--dangerously-bypass-hook-trust` is enabled"),
    );
    s.check("画布内：Codex 的 Hook 打到了 core", lastEvent() !== before, {
      before,
      after: lastEvent(),
    });

    const codexOutside = async (label, program, args, env) => {
      before = lastEvent();
      const answer = await run(program, args, {
        cwd: project,
        env: codexEnv(env),
      });
      const rollout = newestRollout(freshHome);
      const text = rollout ? readFileSync(rollout, "utf8") : "";
      s.check(
        `${label}：Codex 跑完一轮`,
        answer.code === 0,
        answer.stderr.slice(-300),
      );
      s.check(
        `${label}：Codex 的会话里没有画布规则，也没有 armadra 技能`,
        rollout !== inRollout &&
          text !== "" &&
          !text.includes("Armadra canvas rules") &&
          !text.includes("skills/armadra"),
        rollout,
      );
      s.check(
        `${label}：没有 --dangerously-bypass-hook-trust`,
        !answer.stderr.includes("--dangerously-bypass-hook-trust"),
      );
      s.check(`${label}：Codex 的 Hook 没有打到 core`, lastEvent() === before, {
        before,
        after: lastEvent(),
      });
      return rollout;
    };
    await codexOutside("画布外重跑同一行", codexLauncher, codexLine, outside);
    await codexOutside(
      "行上没有启动器",
      codexLine[0],
      codexLine.slice(1),
      inside,
    );
    s.check(
      "新的 CODEX_HOME 里没有生成 config.toml",
      !existsSync(join(freshHome, "config.toml")),
    );
    s.check(
      "共用的临时 CODEX_HOME 的 config.toml 里没有会话信任记录",
      !readFileSync(join(codexHome, "config.toml"), "utf8").includes(
        "<session-flags>",
      ),
    );

    /* ------------------------------- Claude ------------------------------- */

    // 真实配置目录：钥匙串里的登录只认它。
    const claudeEnv = (env) => {
      const next = { ...env };
      delete next.CLAUDE_CONFIG_DIR;
      return next;
    };
    const legacySkill = existsSync(
      join(homedir(), ".claude/skills/armadra/SKILL.md"),
    );
    if (legacySkill)
      note(
        "真实 ~/.claude/skills/armadra 仍在：旧版的全局安装，升级后真实应用第一次启动会备份并清掉；探针不碰它",
      );
    const claudeLine = [
      claudeProgram,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "1",
      prompt,
    ];
    const ours = (init) => ({
      plugin: (init?.plugins ?? []).some((plugin) =>
        String(plugin.name ?? plugin).includes("armadra"),
      ),
      skill: (init?.skills ?? []).includes("armadra:armadra"),
    });

    before = lastEvent();
    const claudeIn = await run(claudeLauncher, claudeLine, {
      cwd: project,
      env: claudeEnv(inside),
    });
    const inInit = claudeInit(claudeIn.stdout);
    s.check(
      "画布内：Claude 加载了我们的插件与插件技能（注入的旗标在 prompt 之后）",
      inInit !== undefined && ours(inInit).plugin && ours(inInit).skill,
      {
        plugins: inInit?.plugins,
        skills: inInit?.skills?.filter((name) => name.includes("armadra")),
        stderr: claudeIn.stderr.slice(-300),
      },
    );
    s.check("画布内：Claude 的 Hook 打到了 core", lastEvent() !== before, {
      before,
      after: lastEvent(),
    });

    const claudeOutside = async (label, program, args, env) => {
      before = lastEvent();
      const answer = await run(program, args, {
        cwd: project,
        env: claudeEnv(env),
      });
      const init = claudeInit(answer.stdout);
      s.check(
        `${label}：Claude 起来了`,
        init !== undefined,
        answer.stderr.slice(-300),
      );
      s.check(
        `${label}：Claude 没有我们的插件与插件技能`,
        init !== undefined && !ours(init).plugin && !ours(init).skill,
        {
          plugins: init?.plugins,
          skills: init?.skills?.filter((name) => name.includes("armadra")),
          legacyGlobalSkill: legacySkill,
        },
      );
      s.check(
        `${label}：Claude 的 Hook 没有打到 core`,
        lastEvent() === before,
        {
          before,
          after: lastEvent(),
        },
      );
    };
    await claudeOutside(
      "画布外重跑同一行",
      claudeLauncher,
      claudeLine,
      outside,
    );
    await claudeOutside(
      "行上没有启动器",
      claudeLine[0],
      claudeLine.slice(1),
      inside,
    );
  } catch (error) {
    s.fail(error);
  }
  s.finish();
}
