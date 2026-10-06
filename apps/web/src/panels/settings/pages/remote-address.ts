/**
 * 添加远程服务时地址栏的规范化（契约 §33.8）：没写协议按 `https://`；写了
 * `http://` 而不是回环地址就在提交前拒绝，不静默改写。其余的校验在 core。
 */
export type AddressCheck =
  | { readonly ok: true; readonly address: string }
  | {
      readonly ok: false;
      readonly error: "error.addressPlaintextLoopbackOnly";
    };

function loopback(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    name === "localhost" || name === "::1" || /^127(\.\d{1,3}){3}$/.test(name)
  );
}

export function checkAddress(raw: string): AddressCheck {
  const text = raw.trim();
  if (text === "") return { ok: true, address: "" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return { ok: true, address: `https://${text}` };
  }
  if (/^http:\/\//i.test(text)) {
    let host = "";
    try {
      host = new URL(text).hostname;
    } catch {
      return { ok: true, address: text };
    }
    if (!loopback(host)) {
      return { ok: false, error: "error.addressPlaintextLoopbackOnly" };
    }
  }
  return { ok: true, address: text };
}
