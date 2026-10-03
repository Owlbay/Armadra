import * as React from "react";
import type { OAuthBinding } from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { ConfirmRemove, SecuritySection, useDateTime } from "./parts";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

export interface BindableProvider {
  readonly id: string;
  readonly kind: "github" | "oidc";
}

/**
 * 第三方账号（契约 §18.5）：已绑定的列一行 · [解绑]；还没绑的可用提供方各一个
 * 「绑定」按钮，点了整页跳去授权，回来落在 `#oauth=bound`。没有可用提供方也
 * 没有绑定时整块不出现。
 */
export function OAuthBindings({
  bindings,
  providers,
  busy,
  onBind,
  onUnbind,
}: {
  bindings: readonly OAuthBinding[] | undefined;
  providers: readonly BindableProvider[];
  /** 正在跳转的提供方 id，或正在解绑的 `credentialId`。 */
  busy: string | null;
  onBind(provider: BindableProvider): void;
  onUnbind(binding: OAuthBinding): void;
}) {
  const t = useT();
  const date = useDateTime("date");
  const [confirm, setConfirm] = React.useState<OAuthBinding | null>(null);
  if (bindings === undefined) return null;
  const bound = new Set(bindings.map((binding) => binding.providerId));
  const open = providers.filter((provider) => !bound.has(provider.id));
  if (bindings.length === 0 && open.length === 0) return null;
  const name = (binding: OAuthBinding) =>
    binding.providerId
      ? providerName(binding.providerId, binding.kind)
      : t("security.oauth.removed");

  return (
    <SecuritySection title={t("security.oauth")}>
      {bindings.length > 0 && (
        <div className="rounded-lg border border-border/70 bg-card px-2">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("security.name")}</TableHead>
                <TableHead>{t("security.created")}</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">{t("security.oauth.unlink")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.map((binding) => (
                <TableRow key={binding.credentialId}>
                  <TableCell className="font-medium">{name(binding)}</TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {date(binding.createdAtMs)}
                  </TableCell>
                  <TableCell className="text-right">
                    {busy === binding.credentialId ? (
                      <Spinner
                        className="ml-auto"
                        aria-label={t("security.oauth.unlink")}
                      />
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={busy !== null}
                        aria-label={t("security.oauth.unlinkNamed", {
                          name: name(binding),
                        })}
                        onClick={() => setConfirm(binding)}
                      >
                        {t("security.oauth.unlink")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {open.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {open.map((provider) => (
            <Button
              key={provider.id}
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => onBind(provider)}
            >
              {busy === provider.id && (
                <Spinner
                  aria-label={t("security.oauth.link", {
                    name: providerName(provider.id, provider.kind),
                  })}
                />
              )}
              {t("security.oauth.link", {
                name: providerName(provider.id, provider.kind),
              })}
            </Button>
          ))}
        </div>
      )}
      <ConfirmRemove
        open={confirm !== null}
        title={t("security.oauth.unlink")}
        subject={confirm ? name(confirm) : ""}
        action={t("security.oauth.unlink")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const binding = confirm;
          setConfirm(null);
          if (binding) onUnbind(binding);
        }}
      />
    </SecuritySection>
  );
}

/** GitHub 用品牌名；通用 OIDC 用设置里的提供方 id。 */
export function providerName(id: string, kind: "github" | "oidc"): string {
  return kind === "github" ? "GitHub" : id;
}
