import {
  createCredentialRequestSchema,
  credentialEntrySchema,
  credentialListSchema,
  updateCredentialRequestSchema,
  type CreateCredentialRequest,
  type UpdateCredentialRequest,
} from "@armadra/shared";

import { json, noContentSchema, query, request } from "./request";

/**
 * 节点凭据（契约 §20.2）。值只进不出：新建与改值带 `value`，答复只有 `isSet`。
 */
export const credentialsApi = {
  list: (signal?: AbortSignal) =>
    request("/api/credentials", credentialListSchema, { signal }),
  create: (value: CreateCredentialRequest) =>
    request("/api/credentials", credentialEntrySchema, {
      method: "POST",
      ...json(createCredentialRequestSchema.parse(value)),
    }),
  update: (ref: string, value: UpdateCredentialRequest) =>
    request(`/api/credentials/${query(ref)}`, credentialEntrySchema, {
      method: "PATCH",
      ...json(updateCredentialRequestSchema.parse(value)),
    }),
  remove: (ref: string) =>
    request(`/api/credentials/${query(ref)}`, noContentSchema, {
      method: "DELETE",
    }),
};

/** react-query 的键：设置页与节点头共用一份。 */
export const CREDENTIALS_QUERY_KEY = ["credentials"] as const;
