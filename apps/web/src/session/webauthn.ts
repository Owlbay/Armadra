/**
 * 浏览器 WebAuthn 与 core 之间的 JSON（契约 §18.2）。
 *
 * core 发的是 `PublicKeyCredential{Creation,Request}OptionsJSON`，要的是
 * `PublicKeyCredential.toJSON()`。新浏览器有 `parse…FromJSON` 与 `toJSON`；
 * 没有的（Safari 17、Firefox 118 之前）按同一份规范手工转 base64url。
 */

type Json = Record<string, unknown>;

/** 这个页面能不能用 passkey：要安全上下文与 WebAuthn。 */
export function webauthnAvailable(): boolean {
  return (
    globalThis.isSecureContext === true &&
    typeof globalThis.PublicKeyCredential === "function" &&
    typeof globalThis.navigator?.credentials?.create === "function"
  );
}

/** 用户在系统对话框里取消或超时：不是错误，不提示。 */
export function webauthnCancelled(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  );
}

export async function createCredential(options: Json): Promise<Json> {
  const publicKey = parseCreation(options);
  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!credential) throw new DOMException("No credential", "NotAllowedError");
  return credentialJson(credential);
}

export async function getAssertion(options: Json): Promise<Json> {
  const publicKey = parseRequest(options);
  const credential = (await navigator.credentials.get({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!credential) throw new DOMException("No credential", "NotAllowedError");
  return credentialJson(credential);
}

/* --------------------------------- 转换 ---------------------------------- */

interface NativeJson {
  parseCreationOptionsFromJSON?: (
    value: Json,
  ) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (
    value: Json,
  ) => PublicKeyCredentialRequestOptions;
}

function parseCreation(options: Json): PublicKeyCredentialCreationOptions {
  const native = globalThis.PublicKeyCredential as unknown as NativeJson;
  if (typeof native.parseCreationOptionsFromJSON === "function") {
    return native.parseCreationOptionsFromJSON(options);
  }
  const user = options.user as Json;
  return {
    ...(options as unknown as PublicKeyCredentialCreationOptions),
    challenge: fromBase64url(String(options.challenge)),
    user: {
      ...(user as unknown as PublicKeyCredentialUserEntity),
      id: fromBase64url(String(user.id)),
    },
    excludeCredentials: descriptors(options.excludeCredentials),
  };
}

function parseRequest(options: Json): PublicKeyCredentialRequestOptions {
  const native = globalThis.PublicKeyCredential as unknown as NativeJson;
  if (typeof native.parseRequestOptionsFromJSON === "function") {
    return native.parseRequestOptionsFromJSON(options);
  }
  return {
    ...(options as unknown as PublicKeyCredentialRequestOptions),
    challenge: fromBase64url(String(options.challenge)),
    allowCredentials: descriptors(options.allowCredentials),
  };
}

function descriptors(value: unknown): PublicKeyCredentialDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: Json) => ({
    ...(item as unknown as PublicKeyCredentialDescriptor),
    id: fromBase64url(String(item.id)),
  }));
}

function credentialJson(credential: PublicKeyCredential): Json {
  const withJson = credential as PublicKeyCredential & { toJSON?: () => Json };
  if (typeof withJson.toJSON === "function") return withJson.toJSON();
  const response = credential.response as AuthenticatorResponse &
    Partial<AuthenticatorAttestationResponse & AuthenticatorAssertionResponse>;
  const body: Json = {
    clientDataJSON: toBase64url(response.clientDataJSON),
  };
  if (response.attestationObject) {
    body.attestationObject = toBase64url(response.attestationObject);
    body.transports = response.getTransports?.() ?? [];
  }
  if (response.authenticatorData) {
    body.authenticatorData = toBase64url(response.authenticatorData);
    body.signature = toBase64url(response.signature as ArrayBuffer);
    if (response.userHandle) body.userHandle = toBase64url(response.userHandle);
  }
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: body,
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(credential.authenticatorAttachment
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
  };
}

export function fromBase64url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function toBase64url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
