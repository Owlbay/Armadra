import {
  clientSourceSchema,
  mountInputSchema,
  remoteAddInputSchema,
  remoteAddOutputSchema,
  remoteDevicePollOutputSchema,
  remoteServiceSchema,
  remoteSessionOutputSchema,
  remoteSourceSummarySchema,
  remoteSourcesOutputSchema,
  serviceIdInputSchema,
  sourceIdInputSchema,
  sourcesAddDirectInputSchema,
  sourcesListOutputSchema,
  sourcesSessionInputSchema,
  sourcesSessionOutputSchema,
  sourcesUpdateInputSchema,
} from "@armadra/platform-protocol/core-api";
import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `sources.*`（契约 §33）：这台 core 作为「客户端宿主」记住的别的源，以及它
 * 登记过 / 能登录的远程服务。全部 owner 专用：读 `settings:read`，写
 * `settings:write`。
 *
 * 出入参就是协议包 `@armadra/platform-protocol/core-api` 的那一组 schema 对象
 * （cloud 仓与这里同一份，不另抄）；长度、地址、指纹这些语义检查在 core 的域里。
 * 凭据只在 core 的 SecretStore，答案里只有 `hasCredentials`——刷新令牌、口令从不
 * 出现在任何出参里。
 */

export {
  clientSourceSchema,
  remoteAddInputSchema,
  remoteServiceSchema,
  remoteSourceSummarySchema,
};
export const sourceSessionSchema = sourcesSessionOutputSchema;

const empty = z.object({});

const read = (path: string, method: "GET" | "POST" = "GET") =>
  meta({
    scope: "settings:read",
    since: "1.3",
    contract: "§33.1",
    legacy: { method, path },
  });

const write = (
  section: "§33.1" | "§33.2" | "§33.6",
  method: "POST" | "PUT" | "DELETE",
  path: string,
) =>
  meta({
    scope: "settings:write",
    since: "1.3",
    contract: section,
    legacy: { method, path },
  });

const denied = errors.pick("unauthenticated", "forbidden");

export const sources = {
  list: oc
    .input(empty.optional())
    .output(sourcesListOutputSchema)
    .errors(denied)
    .meta(read("/api/sources")),
  /** core 代页面完成配对（`POST <origin>/api/identity/pair`），存刷新令牌。 */
  addDirect: oc
    .input(sourcesAddDirectInputSchema)
    .output(clientSourceSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "conflict",
        "source_unreachable",
        "source_unauthorized",
        "fingerprint_mismatch",
      ),
    })
    .meta(write("§33.1", "POST", "/api/sources/direct")),
  update: oc
    .input(sourcesUpdateInputSchema)
    .output(clientSourceSchema)
    .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
    .meta(write("§33.1", "PUT", "/api/sources/{sourceId}")),
  /** 删行 + 删 SecretStore；`local` 行答 `conflict`。 */
  remove: oc
    .input(sourceIdInputSchema)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found", "conflict") })
    .meta(write("§33.1", "DELETE", "/api/sources/{sourceId}")),
  /** 只删凭据，保留行（「断开」）。 */
  forget: oc
    .input(sourceIdInputSchema)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found", "conflict") })
    .meta(write("§33.1", "POST", "/api/sources/{sourceId}/forget")),
  /** 用刷新令牌换一对新令牌（旋转写回），答访问令牌与该走的地址。 */
  session: oc
    .input(sourcesSessionInputSchema)
    .output(sourceSessionSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "conflict",
        "source_unauthorized",
        "source_unreachable",
      ),
    })
    .meta(write("§33.1", "POST", "/api/sources/{sourceId}/session")),
  remoteAdd: oc
    .input(remoteAddInputSchema)
    .output(remoteAddOutputSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "credentials_invalid",
        "account_locked",
        "rate_limited",
        "fingerprint_mismatch",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(write("§33.2", "POST", "/api/sources/remotes")),
  remoteDevicePoll: oc
    .input(serviceIdInputSchema)
    .output(remoteDevicePollOutputSchema)
    .errors({ ...denied, ...errors.pick("not_found", "not_implemented") })
    .meta(write("§33.2", "POST", "/api/sources/remotes/{serviceId}/poll")),
  /** 删远程服务：尽力登出，删行与凭据。 */
  remoteRemove: oc
    .input(serviceIdInputSchema)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found") })
    .meta(write("§33.2", "DELETE", "/api/sources/remotes/{serviceId}")),
  remoteSources: oc
    .input(serviceIdInputSchema)
    .output(remoteSourcesOutputSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "source_unauthorized",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(
      meta({
        scope: "settings:read",
        since: "1.3",
        contract: "§33.2",
        legacy: {
          method: "GET",
          path: "/api/sources/remotes/{serviceId}/sources",
        },
      }),
    ),
  /** 取断言 → 经 `relayBaseUrl` `cloud/login` → 存刷新令牌；建 `relayed` 行。 */
  mount: oc
    .input(mountInputSchema)
    .output(clientSourceSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "conflict",
        "source_offline",
        "source_unauthorized",
        "source_unreachable",
        "cloud_account_unlinked",
        "not_implemented",
      ),
    })
    .meta(write("§33.2", "POST", "/api/sources/remotes/{serviceId}/mount")),
  /** 页面要直接调远程服务（分享、链接）时用的访问令牌。 */
  remoteSession: oc
    .input(serviceIdInputSchema)
    .output(remoteSessionOutputSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "source_unauthorized",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(write("§33.2", "POST", "/api/sources/remotes/{serviceId}/session")),
  /** 登出远程服务：尽力 `auth.logout`，删凭据，留行（契约 §33.6）。 */
  remoteLogout: oc
    .input(serviceIdInputSchema)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found") })
    .meta(write("§33.6", "POST", "/api/sources/remotes/{serviceId}/logout")),
};

export type ClientSource = z.infer<typeof clientSourceSchema>;
export type RemoteService = z.infer<typeof remoteServiceSchema>;
export type RemoteSourceSummary = z.infer<typeof remoteSourceSummarySchema>;
export type SourceSession = z.infer<typeof sourceSessionSchema>;
export type RemoteAddInput = z.infer<typeof remoteAddInputSchema>;
