import React, { useState } from "react";
import { Banner, Button, Card, Space, Typography } from "@douyinfe/semi-ui";
import type { PermissionStatus } from "../permissions.js";
import type { Bot } from "../config.js";
import { api, explain } from "./api.js";

export function PermissionReadiness({
  status,
  tenant,
  appId,
}: {
  status?: PermissionStatus;
  tenant: "feishu" | "lark";
  appId: string;
}) {
  const domain =
    tenant === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const directory = status?.directory;
  const availability = status?.availability;
  const full =
    status?.status === "granted" &&
    directory?.allDepartments &&
    !directory.truncated &&
    availability?.allMembers;
  return (
    <Space vertical align="start" style={{ width: "100%" }} spacing="medium">
      <Banner
        type={full ? "success" : "info"}
        description={
          full
            ? "飞书侧权限与全员范围已就绪，使用人员由本控制台授权。"
            : "接入目标：完整能力权限、全员可用、全组织通讯录。三项分别核验，具体谁能使用机器人由本控制台管理。"
        }
      />
      {status && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 13,
          }}
        >
          <Typography.Text>
            接口权限：
            {status.status === "granted"
              ? "项目权限已授予"
              : `仍需核验 ${status.missing.length} 项权限`}
          </Typography.Text>
          <Typography.Text>
            应用可用范围：
            {availability?.status !== "checked"
              ? "尚未核验"
              : availability.allMembers
                ? "全员可用"
                : "部分人员可用，请改为全员"}
          </Typography.Text>
          <Typography.Text>
            通讯录范围：
            {directory?.status !== "checked"
              ? "尚未核验"
              : directory.allDepartments && !directory.truncated
                ? "全组织"
                : `当前覆盖 ${directory?.users ?? 0} 位直接授权用户、${directory?.departments ?? 0} 个部门，请设置全组织范围`}
          </Typography.Text>
        </div>
      )}
      <Space wrap spacing="medium">
        <a
          href={`${domain}/app/${encodeURIComponent(appId)}/auth`}
          target="_blank"
          rel="noreferrer"
          style={{
            color: "var(--feishu-primary)",
            textDecoration: "none",
            fontWeight: 500,
          }}
        >
          设置接口权限和通讯录范围 ↗
        </a>
        <a
          href={
            tenant === "lark"
              ? "https://www.larksuite.com/admin"
              : "https://www.feishu.cn/admin"
          }
          target="_blank"
          rel="noreferrer"
          style={{
            color: "var(--feishu-primary)",
            textDecoration: "none",
            fontWeight: 500,
          }}
        >
          管理后台设置全员可用 ↗
        </a>
      </Space>
      <Typography.Text type="tertiary" size="small">
        管理后台 → 应用管理 → 当前机器人 →
        可用范围选择全员。通讯录权限选择全部成员或全组织。扫码接口不支持直接设置这两项，保存后重新核验。
      </Typography.Text>
    </Space>
  );
}

export function BotPermissions({ bot }: { bot: Bot }) {
  const [status, setStatus] = useState<PermissionStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Card
      headerLine={false}
      style={{
        borderRadius: "var(--feishu-radius-card)",
        border: "1px solid var(--feishu-border-light)",
        marginTop: 12,
      }}
      title={`${bot.name || bot.id} · 飞书侧权限`}
      headerExtraContent={
        <Button
          size="small"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              setStatus(await api(`/api/robots/${bot.id}/permissions`));
            } catch (e) {
              setError(explain(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          核验权限与范围
        </Button>
      }
    >
      {error && (
        <Banner
          type="danger"
          description={error}
          style={{ marginBottom: 12 }}
        />
      )}
      <PermissionReadiness
        status={status}
        tenant={bot.tenant}
        appId={bot.appId}
      />
    </Card>
  );
}
