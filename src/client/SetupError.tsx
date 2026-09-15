import React from "react";
import { explain } from "./api.js";

export function SetupError({
  error,
  appId,
  tenant,
  onClose,
}: {
  error: unknown;
  appId?: string;
  tenant?: "feishu" | "lark";
  onClose?: () => void;
}) {
  const code = error instanceof Error ? error.message : "";
  const permission =
    code === "lark_tenant_permission_required" ||
    code === "lark_permission_required";
  let url: URL | undefined;
  if (permission && appId && /^[A-Za-z0-9_-]{1,200}$/.test(appId)) {
    url = new URL(
      `/app/${appId}/auth`,
      tenant === "lark"
        ? "https://open.larksuite.com"
        : "https://open.feishu.cn",
    );
    if (code === "lark_tenant_permission_required")
      url.searchParams.set("q", "tenant:tenant:readonly");
    url.searchParams.set("token_type", "tenant");
  }
  return (
    <div role="alert" className="setup-error-banner semi-banner-danger">
      <div className="setup-error-content">
        <span className="setup-error-msg">{explain(error)}</span>
        {url && (
          <a
            href={url.href}
            target="_blank"
            rel="noreferrer"
            className="setup-error-link"
          >
            打开此应用权限页 ↗
          </a>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          aria-label="关闭提示"
          className="setup-error-close"
          onClick={onClose}
        >
          ✕
        </button>
      )}
    </div>
  );
}
