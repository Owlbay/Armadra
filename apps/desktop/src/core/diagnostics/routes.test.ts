import { describe, expect, it } from "vitest";

import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import { type RequestIdentity, runAs } from "../identity/gate";
import { RuntimeMetrics } from "../resources/metrics";
import { ClientReports } from "./client-report";
import { scrubContext } from "./crash";
import { RUNTIME_ROUTE, type RuntimeSource, installRoutes } from "./routes";

/**
 * `GET /api/diagnostics/runtime`（契约 §54）：形状只有数字与时间戳，门与 §30
 * 一样（登录即可，匿名 401），资源域没装时 404。
 */

function setup(source: RuntimeSource) {
  const reports = new ClientReports({
    enabled: () => false,
    report: () => {},
    scrub: () => scrubContext({}, "/"),
  });
  const router = new Router();
  installRoutes({ router } as unknown as CoreServer, reports, source);
  return async (who: RequestIdentity | undefined) => {
    const run = () =>
      router.dispatch("GET", RUNTIME_ROUTE, emptyRequest("GET", RUNTIME_ROUTE));
    return (await (who === undefined ? run() : runAs(who, run))) as {
      status: number;
      body: { code?: string } & Record<string, unknown>;
    };
  };
}

const member: RequestIdentity = {
  subject: { principalId: "p1", kind: "member", scopes: [] },
};
const anonymous: RequestIdentity = {
  subject: { principalId: "", kind: "member", scopes: [] },
};

describe(RUNTIME_ROUTE, () => {
  it("答事件循环与采样的数字，只有数字与时间戳", async () => {
    const metrics = new RuntimeMetrics();
    metrics.sampling.noteRound(84.04, Date.parse("2026-10-09T10:00:00.000Z"));
    metrics.sampling.noteRound(212, Date.parse("2026-10-09T10:00:02.000Z"));
    metrics.sampling.noteTimeout("probe");
    metrics.sampling.noteOverlap();
    const call = setup(() => metrics.report(2_000));
    const answer = await call(member);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      eventLoop: { windowMs: 60_000, p50Ms: 0, p99Ms: 0, maxMs: 0 },
      sampling: {
        intervalMs: 2_000,
        inFlight: false,
        rounds: 2,
        lastRoundMs: 212,
        maxRoundMs: 212,
        overlapsSkipped: 1,
        timeouts: { ps: 0, tmux: 0, probe: 1 },
        lastRoundAt: "2026-10-09T10:00:02.000Z",
      },
    });
    // 本机 owner（桌面壳，没有请求身份）同样答得出。
    expect((await call(undefined)).status).toBe(200);
  });

  it("匿名 401；资源域没装 404", async () => {
    expect(
      (await setup(() => new RuntimeMetrics().report(2_000))(anonymous)).status,
    ).toBe(401);
    const missing = await setup(() => undefined)(member);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("not_found");
  });
});
