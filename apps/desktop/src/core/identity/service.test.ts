import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import { IdentityError } from "./errors";
import {
  ACCESS_TTL_MS,
  BOOTSTRAP_TTL_MS,
  IdentityService,
  devicePlatform,
  SESSION_TTL_MS,
} from "./service";
import { allScopes, scope } from "./scopes";
import { IdentityStore } from "./store";
import { tempDir } from "../testing/temp-dir";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const ORIGIN = "http://127.0.0.1:1420";
const INSTANCE = "0123456789abcdef0123456789abcdef";

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) {
    try {
      close();
    } catch {
      // Already closed.
    }
  }
});

function fixture(start = 1_700_000_000_000) {
  const directory = tempDir("armadra-identity-");
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  let now = start;
  const store = new IdentityStore(opened.database);
  const service = new IdentityService(store, INSTANCE, () => now);
  const hostId = store.hostId();
  return {
    service,
    store,
    hostId,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

function pair(fix: ReturnType<typeof fixture>, name = "本机桌面") {
  const ticket = fix.service.issueBootstrap({
    hostId: fix.hostId,
    instanceId: INSTANCE,
    origin: ORIGIN,
    deviceName: name,
    scopes: allScopes(),
  });
  return {
    ticket,
    credentials: fix.service.consumeBootstrap({
      ticket: ticket.ticket,
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
    }),
  };
}

function kind(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof IdentityError ? error.kind : "other";
  }
  return "none";
}

describe("the host identity", () => {
  it("is a stable 32-hex value the second read agrees with", () => {
    const fix = fixture();
    expect(fix.hostId).toMatch(/^[0-9a-f]{32}$/);
    expect(fix.store.hostId()).toBe(fix.hostId);
  });

  it("refuses an instance id that is not one", () => {
    const fix = fixture();
    expect(() => new IdentityService(fix.store, "nope")).toThrow(IdentityError);
  });
});

describe("issuing a bootstrap ticket", () => {
  it("answers a two-minute one-time ticket", () => {
    const fix = fixture();
    const ticket = fix.service.issueBootstrap({
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
      deviceName: "本机桌面",
      scopes: allScopes(),
    });
    expect(ticket.ticket).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    expect(ticket.expiresAtMs).toBe(fix.at() + BOOTSTRAP_TTL_MS);
  });

  it("refuses another host, another instance, a bad origin or a bad name", () => {
    const fix = fixture();
    const base = {
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
      deviceName: "本机桌面",
      scopes: allScopes(),
    };
    expect(
      kind(() =>
        fix.service.issueBootstrap({ ...base, hostId: "f".repeat(32) }),
      ),
    ).toBe("invalid");
    expect(
      kind(() =>
        fix.service.issueBootstrap({ ...base, instanceId: "a".repeat(32) }),
      ),
    ).toBe("invalid");
    expect(
      kind(() =>
        fix.service.issueBootstrap({ ...base, origin: "http://evil.example" }),
      ),
    ).toBe("invalid");
    expect(
      kind(() => fix.service.issueBootstrap({ ...base, deviceName: " x" })),
    ).toBe("invalid");
    expect(
      kind(() => fix.service.issueBootstrap({ ...base, scopes: [] })),
    ).toBe("invalid");
  });
});

describe("trading a ticket for a session", () => {
  it("creates the owner, the device and the session", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    expect(credentials.principal.hostId).toBe(fix.hostId);
    expect(credentials.principal.role).toBe("owner");
    expect(credentials.principal.deviceEpoch).toBe(1);
    expect(credentials.principal.deviceName).toBe("本机桌面");
    expect(credentials.accessExpiresAtMs).toBe(fix.at() + ACCESS_TTL_MS);
    expect(credentials.expiresAtMs).toBe(fix.at() + SESSION_TTL_MS);
    expect(credentials.accessToken).not.toBe(credentials.refreshToken);
  });

  it("refuses the second attempt with the same ticket", () => {
    const fix = fixture();
    const { ticket } = pair(fix);
    expect(
      kind(() =>
        fix.service.consumeBootstrap({
          ticket: ticket.ticket,
          hostId: fix.hostId,
          instanceId: INSTANCE,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
  });

  it("refuses a ticket past its two minutes", () => {
    const fix = fixture();
    const ticket = fix.service.issueBootstrap({
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
      deviceName: "本机桌面",
      scopes: allScopes(),
    });
    fix.advance(BOOTSTRAP_TTL_MS);
    expect(
      kind(() =>
        fix.service.consumeBootstrap({
          ticket: ticket.ticket,
          hostId: fix.hostId,
          instanceId: INSTANCE,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
  });

  it("refuses a ticket spent from another origin", () => {
    const fix = fixture();
    const ticket = fix.service.issueBootstrap({
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
      deviceName: "本机桌面",
      scopes: allScopes(),
    });
    expect(
      kind(() =>
        fix.service.consumeBootstrap({
          ticket: ticket.ticket,
          hostId: fix.hostId,
          instanceId: INSTANCE,
          origin: "http://127.0.0.1:1421",
        }),
      ),
    ).toBe("unauthenticated");
  });

  it("refuses a forged ticket whose id is real", () => {
    const fix = fixture();
    const ticket = fix.service.issueBootstrap({
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
      deviceName: "本机桌面",
      scopes: allScopes(),
    });
    const forged = `${ticket.ticket.slice(0, 33)}${"A".repeat(43)}`;
    expect(
      kind(() =>
        fix.service.consumeBootstrap({
          ticket: forged,
          hostId: fix.hostId,
          instanceId: INSTANCE,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
  });
});

describe("using a session", () => {
  it("authenticates the access token it issued", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    const principal = fix.service.authenticate({
      accessToken: credentials.accessToken,
      hostId: fix.hostId,
      origin: ORIGIN,
    });
    expect(principal.sessionId).toBe(credentials.principal.sessionId);
  });

  it("refuses a refresh token presented as an access token", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    expect(
      kind(() =>
        fix.service.authenticate({
          accessToken: credentials.refreshToken,
          hostId: fix.hostId,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
  });

  it("refuses once the access token has aged out", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    fix.advance(ACCESS_TTL_MS);
    expect(
      kind(() =>
        fix.service.authenticate({
          accessToken: credentials.accessToken,
          hostId: fix.hostId,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
  });

  it("refuses the same token from another origin", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    expect(
      kind(() =>
        fix.service.authenticate({
          accessToken: credentials.accessToken,
          hostId: fix.hostId,
          origin: "http://localhost:1420",
        }),
      ),
    ).toBe("unauthenticated");
  });

  it("denies a scope the session was never granted", () => {
    const fix = fixture();
    const ticket = fix.service.issueBootstrap({
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
      deviceName: "只读",
      scopes: [scope("canvas:read")],
    });
    const credentials = fix.service.consumeBootstrap({
      ticket: ticket.ticket,
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
    });
    expect(
      kind(() =>
        fix.service.authenticate({
          accessToken: credentials.accessToken,
          hostId: fix.hostId,
          origin: ORIGIN,
          requiredScopes: [scope("canvas:write")],
        }),
      ),
    ).toBe("permission");
  });

  it("rejects a mutation whose CSRF token is wrong", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    expect(
      kind(() =>
        fix.service.authenticate({
          accessToken: credentials.accessToken,
          hostId: fix.hostId,
          origin: ORIGIN,
          requireCsrf: true,
          csrfToken: "A".repeat(43),
        }),
      ),
    ).toBe("permission");
  });
});

describe("rotating a session", () => {
  it("replaces all three secrets and keeps the absolute deadline", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    fix.advance(60_000);
    const rotated = fix.service.refresh({
      refreshToken: credentials.refreshToken,
      csrfToken: credentials.csrfToken,
      hostId: fix.hostId,
      origin: ORIGIN,
    });
    expect(rotated.accessToken).not.toBe(credentials.accessToken);
    expect(rotated.refreshToken).not.toBe(credentials.refreshToken);
    expect(rotated.csrfToken).not.toBe(credentials.csrfToken);
    expect(rotated.expiresAtMs).toBe(credentials.expiresAtMs);
    expect(rotated.accessExpiresAtMs).toBe(fix.at() + ACCESS_TTL_MS);
  });

  it("refuses a spent refresh token rather than retrying it", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    fix.service.refresh({
      refreshToken: credentials.refreshToken,
      csrfToken: credentials.csrfToken,
      hostId: fix.hostId,
      origin: ORIGIN,
    });
    expect(
      kind(() =>
        fix.service.refresh({
          refreshToken: credentials.refreshToken,
          csrfToken: credentials.csrfToken,
          hostId: fix.hostId,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
  });

  it("never extends the access token past the absolute deadline", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    fix.advance(SESSION_TTL_MS - 60_000);
    const rotated = fix.service.refresh({
      refreshToken: credentials.refreshToken,
      csrfToken: credentials.csrfToken,
      hostId: fix.hostId,
      origin: ORIGIN,
    });
    expect(rotated.accessExpiresAtMs).toBe(credentials.expiresAtMs);
  });

  it("recovers a lost CSRF from the refresh credential alone", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    const renewed = fix.service.renewCsrf({
      refreshToken: credentials.refreshToken,
      hostId: fix.hostId,
      origin: ORIGIN,
    });
    expect(renewed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rotated = fix.service.refresh({
      refreshToken: credentials.refreshToken,
      csrfToken: renewed,
      hostId: fix.hostId,
      origin: ORIGIN,
    });
    expect(rotated.principal.deviceId).toBe(credentials.principal.deviceId);
  });

  it("checks the bound CSRF by default and only skips it when told the transport is Bearer", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    // Cookie 会话（缺省）：缺 CSRF、或 CSRF 不是这把会话的，都拒。
    for (const csrfToken of ["", "A".repeat(43)]) {
      expect(
        kind(() =>
          fix.service.refresh({
            refreshToken: credentials.refreshToken,
            csrfToken,
            hostId: fix.hostId,
            origin: ORIGIN,
          }),
        ),
      ).toBe("unauthenticated");
    }
    // Bearer 传输（契约 §17.4）：不核 CSRF，刷新票本身照核。
    const rotated = fix.service.refresh({
      refreshToken: credentials.refreshToken,
      csrfToken: "",
      hostId: fix.hostId,
      origin: ORIGIN,
      requireCsrf: false,
    });
    expect(rotated.principal.deviceId).toBe(credentials.principal.deviceId);
    expect(
      kind(() =>
        fix.service.refresh({
          refreshToken: credentials.refreshToken,
          csrfToken: "",
          hostId: fix.hostId,
          origin: ORIGIN,
          requireCsrf: false,
        }),
      ),
    ).toBe("unauthenticated");
    expect(
      kind(() =>
        fix.service.logoutRefresh({
          refreshToken: rotated.refreshToken,
          csrfToken: "",
          hostId: fix.hostId,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
    fix.service.logoutRefresh({
      refreshToken: rotated.refreshToken,
      csrfToken: "",
      hostId: fix.hostId,
      origin: ORIGIN,
      requireCsrf: false,
    });
    expect(
      kind(() =>
        fix.service.authenticate({
          accessToken: rotated.accessToken,
          hostId: fix.hostId,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
  });
});

describe("re-checking a long-lived stream's session (security review L1)", () => {
  it("follows the session across a refresh, not the access token it began with", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    const session = {
      sessionId: credentials.principal.sessionId,
      hostId: fix.hostId,
      origin: ORIGIN,
    };
    expect(fix.service.sessionAccess(session).accessExpiresAtMs).toBe(
      credentials.accessExpiresAtMs,
    );
    // The access token's fifteen minutes run out with no refresh: refused.
    fix.advance(ACCESS_TTL_MS);
    expect(kind(() => fix.service.sessionAccess(session))).toBe(
      "unauthenticated",
    );
    // The page refreshes: the old access token is dead, the session is not.
    const rotated = fix.service.refresh({
      refreshToken: credentials.refreshToken,
      csrfToken: credentials.csrfToken,
      hostId: fix.hostId,
      origin: ORIGIN,
    });
    expect(
      kind(() =>
        fix.service.authenticate({
          accessToken: credentials.accessToken,
          hostId: fix.hostId,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
    expect(fix.service.sessionAccess(session).accessExpiresAtMs).toBe(
      rotated.accessExpiresAtMs,
    );
    // Logged out: refused, whatever the clock says.
    fix.service.logoutRefresh({
      refreshToken: rotated.refreshToken,
      csrfToken: rotated.csrfToken,
      hostId: fix.hostId,
      origin: ORIGIN,
    });
    expect(kind(() => fix.service.sessionAccess(session))).toBe(
      "unauthenticated",
    );
  });

  it("refuses another origin or host", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    const sessionId = credentials.principal.sessionId;
    expect(
      kind(() =>
        fix.service.sessionAccess({
          sessionId,
          hostId: fix.hostId,
          origin: "http://127.0.0.1:9",
        }),
      ),
    ).toBe("unauthenticated");
    expect(
      kind(() =>
        fix.service.sessionAccess({ sessionId, hostId: "x", origin: ORIGIN }),
      ),
    ).toBe("unauthenticated");
  });
});

describe("logging out and revoking", () => {
  it("revokes its own session and refuses it afterwards", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    fix.service.logoutRefresh({
      refreshToken: credentials.refreshToken,
      csrfToken: credentials.csrfToken,
      hostId: fix.hostId,
      origin: ORIGIN,
    });
    expect(
      kind(() =>
        fix.service.authenticate({
          accessToken: credentials.accessToken,
          hostId: fix.hostId,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
  });

  it("gives an unknown credential no receipt", () => {
    const fix = fixture();
    pair(fix);
    expect(
      kind(() =>
        fix.service.logoutRefresh({
          refreshToken: `${"a".repeat(32)}.${"A".repeat(43)}`,
          csrfToken: "A".repeat(43),
          hostId: fix.hostId,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
  });

  it("revokes a device and invalidates every session it signed", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    fix.service.revokeDevice(
      {
        accessToken: credentials.accessToken,
        hostId: fix.hostId,
        origin: ORIGIN,
        requireCsrf: true,
        csrfToken: credentials.csrfToken,
      },
      credentials.principal.deviceId,
      1,
    );
    expect(
      kind(() =>
        fix.service.authenticate({
          accessToken: credentials.accessToken,
          hostId: fix.hostId,
          origin: ORIGIN,
        }),
      ),
    ).toBe("unauthenticated");
  });

  it("treats a repeat of the successful revoke as a no-op", () => {
    const fix = fixture();
    const first = pair(fix).credentials;
    const second = pair(fix, "第二台").credentials;
    const actor = {
      accessToken: second.accessToken,
      hostId: fix.hostId,
      origin: ORIGIN,
      requireCsrf: true,
      csrfToken: second.csrfToken,
    };
    fix.service.revokeDevice(actor, first.principal.deviceId, 1);
    expect(() =>
      fix.service.revokeDevice(actor, first.principal.deviceId, 1),
    ).not.toThrow();
    expect(() =>
      fix.service.revokeDevice(actor, first.principal.deviceId, 2),
    ).not.toThrow();
    expect(
      kind(() => fix.service.revokeDevice(actor, first.principal.deviceId, 4)),
    ).toBe("conflict");
  });

  it("refuses a stale epoch on a live device", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    expect(
      kind(() =>
        fix.service.revokeDevice(
          {
            accessToken: credentials.accessToken,
            hostId: fix.hostId,
            origin: ORIGIN,
            requireCsrf: true,
            csrfToken: credentials.csrfToken,
          },
          credentials.principal.deviceId,
          7,
        ),
      ),
    ).toBe("conflict");
  });

  it("lets a device log out its own session without identity:manage", () => {
    const fix = fixture();
    const ticket = fix.service.issueBootstrap({
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
      deviceName: "只读",
      scopes: [scope("canvas:read")],
    });
    const credentials = fix.service.consumeBootstrap({
      ticket: ticket.ticket,
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
    });
    expect(() =>
      fix.service.revokeSession(
        {
          accessToken: credentials.accessToken,
          hostId: fix.hostId,
          origin: ORIGIN,
        },
        credentials.principal.sessionId,
      ),
    ).not.toThrow();
  });

  it("refuses to revoke another session without identity:manage", () => {
    const fix = fixture();
    const other = pair(fix).credentials;
    const ticket = fix.service.issueBootstrap({
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
      deviceName: "只读",
      scopes: [scope("canvas:read")],
    });
    const limited = fix.service.consumeBootstrap({
      ticket: ticket.ticket,
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
    });
    expect(
      kind(() =>
        fix.service.revokeSession(
          {
            accessToken: limited.accessToken,
            hostId: fix.hostId,
            origin: ORIGIN,
          },
          other.principal.sessionId,
        ),
      ),
    ).toBe("permission");
  });
});

describe("listing devices", () => {
  it("pages and reports whether there is more", () => {
    const fix = fixture();
    const first = pair(fix).credentials;
    pair(fix, "第二台");
    const actor = {
      accessToken: first.accessToken,
      hostId: fix.hostId,
      origin: ORIGIN,
    };
    const page = fix.service.listDevices(actor, "", 1);
    expect(page.devices).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const rest = fix.service.listDevices(actor, page.nextId, 50);
    expect(rest.devices).toHaveLength(1);
    expect(rest.hasMore).toBe(false);
  });

  it("refuses a limit outside its range", () => {
    const fix = fixture();
    const { credentials } = pair(fix);
    const actor = {
      accessToken: credentials.accessToken,
      hostId: fix.hostId,
      origin: ORIGIN,
    };
    expect(kind(() => fix.service.listDevices(actor, "", 0))).toBe("invalid");
    expect(kind(() => fix.service.listDevices(actor, "", 201))).toBe("invalid");
  });

  it("denies a session without identity:read", () => {
    const fix = fixture();
    const ticket = fix.service.issueBootstrap({
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
      deviceName: "只读",
      scopes: [scope("canvas:read")],
    });
    const credentials = fix.service.consumeBootstrap({
      ticket: ticket.ticket,
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin: ORIGIN,
    });
    expect(
      kind(() =>
        fix.service.listDevices({
          accessToken: credentials.accessToken,
          hostId: fix.hostId,
          origin: ORIGIN,
        }),
      ),
    ).toBe("permission");
  });
});

describe("devicePlatform", () => {
  it("UA 归成平台：移动端先判，认得出浏览器而说不出系统的是 web", () => {
    const cases: [string, string][] = [
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
        "ios",
      ],
      [
        "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15",
        "ios",
      ],
      [
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0",
        "android",
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0",
        "windows",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Electron/38.0",
        "macos",
      ],
      [
        "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
        "linux",
      ],
      ["Mozilla/5.0 (X11; CrOS x86_64 15359.58.0) Chrome/126.0", "linux"],
      ["Mozilla/5.0 Chrome/126.0", "web"],
      ["armadra-test/1.0", "unknown"],
      ["", "unknown"],
    ];
    for (const [ua, platform] of cases) {
      expect(devicePlatform(ua), ua).toBe(platform);
    }
  });
});

/**
 * 桌面壳的页面与托盘每次启动都配一次对，来源是每次都不同的回环端口。设备列表
 * 不能因此越积越多：回环明文来源的票复用同一台本机设备，只多一条会话。
 */
describe("本机设备复用", () => {
  function pairAt(
    fix: ReturnType<typeof fixture>,
    origin: string,
    name = "本机桌面",
  ) {
    const ticket = fix.service.issueBootstrap({
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin,
      deviceName: name,
      scopes: allScopes(),
    });
    return fix.service.consumeBootstrap({
      ticket: ticket.ticket,
      hostId: fix.hostId,
      instanceId: INSTANCE,
      origin,
    });
  }

  const listed = (fix: ReturnType<typeof fixture>) =>
    fix.store.transaction((tx) => tx.devices("", 200));

  it("页面与托盘反复配对（每次端口都不同）只有一台设备，旧会话照样能用", () => {
    const fix = fixture();
    const first = pairAt(fix, "http://127.0.0.1:50001");
    for (let port = 50002; port < 50012; port += 1) {
      pairAt(fix, `http://127.0.0.1:${port}`);
    }
    const tray = pairAt(fix, "http://127.0.0.1:43120");
    expect(listed(fix)).toHaveLength(1);
    expect(tray.principal.deviceId).toBe(first.principal.deviceId);
    expect(
      fix.service.authenticate({
        accessToken: first.accessToken,
        hostId: fix.hostId,
        origin: "http://127.0.0.1:50001",
      }).deviceId,
    ).toBe(first.principal.deviceId);
  });

  it("经 Gateway 配对的设备（HTTPS 来源）每台都是新的，也不会被本机配对认领", () => {
    const fix = fixture();
    const phone = pairAt(fix, "https://192.168.1.8:8443", "本机桌面");
    const desktop = pairAt(fix, "http://127.0.0.1:50001");
    const another = pairAt(fix, "https://192.168.1.8:8443", "本机桌面");
    expect(desktop.principal.deviceId).not.toBe(phone.principal.deviceId);
    expect(another.principal.deviceId).not.toBe(phone.principal.deviceId);
    expect(listed(fix)).toHaveLength(3);
  });

  it("撤销过的本机设备不复用；换了名字的是另一台", () => {
    const fix = fixture();
    const first = pairAt(fix, "http://127.0.0.1:50001");
    fix.store.transaction((tx) =>
      tx.revokeDevice(first.principal.deviceId, 1, fix.at()),
    );
    const next = pairAt(fix, "http://127.0.0.1:50002");
    expect(next.principal.deviceId).not.toBe(first.principal.deviceId);
    const english = pairAt(fix, "http://127.0.0.1:50003", "This desktop");
    expect(english.principal.deviceId).not.toBe(next.principal.deviceId);
    expect(pairAt(fix, "http://127.0.0.1:50004").principal.deviceId).toBe(
      next.principal.deviceId,
    );
  });
});
