import {
  createCredentialRequestSchema,
  credentialEntrySchema,
  credentialListSchema,
  updateCredentialRequestSchema,
  type CreateCredentialRequest,
  type UpdateCredentialRequest,
} from "@armadra/shared";

import { currentClient } from "./client";

/**
 * 节点凭据（契约 §43.6，形状见 §20.2），经 `credentials.*` procedure。值只进不出：
 * 新建与改值带 `value`，答复只有 `isSet`。
 */
export const credentialsApi = {
  list: async (signal?: AbortSignal) =>
    credentialListSchema.parse(
      await currentClient().credentials.list(undefined, { signal }),
    ),
  create: async (value: CreateCredentialRequest) =>
    credentialEntrySchema.parse(
      await currentClient().credentials.create(
        createCredentialRequestSchema.parse(value),
      ),
    ),
  update: async (ref: string, value: UpdateCredentialRequest) =>
    credentialEntrySchema.parse(
      await currentClient().credentials.update({
        ref,
        ...updateCredentialRequestSchema.parse(value),
      }),
    ),
  remove: async (ref: string): Promise<void> => {
    await currentClient().credentials.remove({ ref });
  },
};

/** react-query 的键：设置页与节点头共用一份。 */
export const CREDENTIALS_QUERY_KEY = ["credentials"] as const;
