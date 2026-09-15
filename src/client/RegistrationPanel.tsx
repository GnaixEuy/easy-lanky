import { PermissionReadiness } from "./PermissionReadiness.js";
import { SetupError } from "./SetupError.js";
import React, { useEffect, useRef, useState } from "react";
import {
  Banner,
  Button,
  Collapse,
  Space,
  Steps,
  Tag,
  Typography,
} from "@douyinfe/semi-ui";
import {
  IconQrCode,
  IconShield,
  IconCheckCircleStroked,
  IconAlertCircle,
} from "@douyinfe/semi-icons";
import { api } from "./api.js";
import type { RobotInput } from "../bot-setup.js";
import { permissionManifest } from "../permissions-manifest.js";
import type { PermissionStatus } from "../permissions.js";

type Snapshot = {
  intent?: "create" | "connect";
  flow?: "create" | "permissions";
  permissions?: PermissionStatus;
  id: string;
  botId: string;
  name: string;
  status: string;
  error?: string;
  expiresAt: number;
  url?: string;
  qr?: string;
  appId?: string;
  tenant?: "feishu" | "lark";
};

export function RegistrationPanel({
  input,
  onSaved,
  onLock,
}: {
  input: Omit<RobotInput, "appId" | "secret">;
  onSaved: (configuration: any) => void;
  onLock: (locked: boolean) => void;
}) {
  const [job, setJob] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  const saved = useRef(onSaved);
  saved.current = onSaved;

  useEffect(() => {
    alive.current = true;
    void api<Snapshot[]>("/api/registrations")
      .then((jobs) => {
        if (alive.current)
          setJob(jobs.find((j) => j.botId === input.id) || null);
      })
      .catch((e) => {
        if (alive.current) setError(e);
      });
    return () => {
      alive.current = false;
      onLock(false);
    };
  }, [input.id]);

  useEffect(() => {
    onLock(job?.status === "pending" || job?.status === "ready");
  }, [job?.status]);

  useEffect(() => {
    if (
      !job ||
      !["pending", "ready"].includes(job.status) ||
      (job.status === "ready" && job.error)
    )
      return;
    let cancelled = false;
    const timer = setTimeout(
      async () => {
        try {
          if (job.status === "pending") {
            const next = await api<Snapshot>(
              `/api/registrations/${job.id}/poll`,
              {},
            );
            if (!cancelled) {
              setJob(next);
              setError(null);
            }
          } else {
            const next = await api(`/api/registrations/${job.id}/finish`, {});
            if (!cancelled) {
              if (next.configuration) saved.current(next.configuration);
              else setJob(next.registration);
            }
          }
        } catch (e) {
          if (!cancelled) {
            setError(e);
            if (job.status === "ready")
              setJob({ ...job, error: "save_failed" });
            else setJob({ ...job });
          }
        }
      },
      job.status === "ready" ? (job.permissions ? 10000 : 0) : 2500,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job]);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setJob(await api("/api/registrations", input));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const currentStep = !job
    ? 0
    : job.status === "pending"
      ? 1
      : job.status === "ready"
        ? 2
        : 0;

  return (
    <Space vertical align="start" style={{ width: "100%" }} spacing="loose">
      {/* 扫码创建向导步骤条 */}
      <div style={{ width: "100%", padding: "8px 0 16px" }}>
        <Steps current={currentStep} size="small">
          <Steps.Step title="填写信息" description="确定名称与工作区" />
          <Steps.Step
            title={job?.flow === "permissions" ? "扫码补全权限" : "扫码授权"}
            description={
              job?.status === "pending" ? "等待飞书扫码" : "获取二维码"
            }
          />
          <Steps.Step title="权限就绪并上线" description="自动保存生效" />
        </Steps>
      </div>

      {job && ["pending", "ready"].includes(job.status) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>{input.name}</span>
          <Tag color="blue" size="small" type="light">
            {input.agentId}
          </Tag>
          <Tag color="green" size="small" type="light">
            {input.tenant === "lark" ? "Lark" : "飞书"}
          </Tag>
        </div>
      )}

      <Typography.Paragraph
        type="secondary"
        style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}
      >
        {job?.flow === "permissions"
          ? "按平台预置权限和项目完整权限清单补申请，飞书会展示新增项。应用可用范围与通讯录范围另行核验，具体使用人员由本控制台授权管理。"
          : "默认申请平台预置权限和项目完整权限清单。请将应用设为全员可用、通讯录设为全组织；谁能使用机器人由本控制台授权。"}
      </Typography.Paragraph>

      {job?.appId && (
        <PermissionReadiness
          status={job.permissions}
          tenant={job.tenant ?? input.tenant}
          appId={job.appId}
        />
      )}

      <Collapse
        style={{ width: "100%", borderRadius: "var(--feishu-radius-card)" }}
      >
        <Collapse.Panel
          header={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <IconShield style={{ color: "var(--feishu-primary)" }} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                查看本项目明确申请的完整权限清单 ({permissionManifest.length}{" "}
                项)
              </span>
            </div>
          }
          itemKey="permissions"
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 10,
            }}
          >
            {permissionManifest.map((item) => (
              <div
                key={item.scope}
                style={{
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: "#f8f9fa",
                  border: "1px solid var(--feishu-border-light)",
                  fontSize: 12,
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    color: "var(--feishu-text-primary)",
                  }}
                >
                  {item.name}
                </div>
                <div
                  style={{
                    color: "var(--feishu-text-secondary)",
                    margin: "2px 0",
                  }}
                >
                  {item.purpose}
                </div>
                <div
                  style={{
                    color: "var(--feishu-text-tertiary)",
                    fontFamily: "monospace",
                  }}
                >
                  {item.scope}
                </div>
              </div>
            ))}
          </div>
        </Collapse.Panel>
      </Collapse>

      {!!(error || (job?.status === "ready" && job.error)) && (
        <SetupError
          error={error || new Error(job!.error)}
          appId={job?.appId}
          tenant={job?.tenant ?? input.tenant}
        />
      )}

      {job?.status === "pending" ? (
        <div
          style={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 16,
            padding: "24px 16px",
            background: "#f9fafb",
            borderRadius: "var(--feishu-radius-card)",
            border: "1px solid var(--feishu-border)",
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "var(--feishu-text-primary)",
            }}
          >
            请使用飞书移动端扫描下方二维码
          </div>
          <div className="registration-qr">
            <img
              src={job.qr}
              width={240}
              height={240}
              alt={
                job.flow === "permissions"
                  ? "用飞书确认补充机器人权限"
                  : "用飞书扫描二维码创建机器人"
              }
              style={{
                borderRadius: 12,
                border: "2px solid #3370ff",
                boxShadow: "0 6px 16px rgba(51, 112, 255, 0.12)",
              }}
            />
            <div
              style={{
                marginTop: 12,
                fontSize: 13,
                color: "var(--feishu-text-secondary)",
              }}
            >
              {job.flow === "permissions"
                ? "等待飞书确认补充权限"
                : "等待扫码创建个人代理"}{" "}
              ·{" "}
              <span>
                有效期至 {new Date(job.expiresAt).toLocaleTimeString()}
              </span>
            </div>
            <div style={{ marginTop: 6 }}>
              <a
                href={job.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  color: "var(--feishu-primary)",
                  textDecoration: "none",
                  fontWeight: 500,
                  fontSize: 13,
                }}
              >
                无法扫码？在飞书官方网页打开授权 ↗
              </a>
            </div>
          </div>

          {job.error && (
            <Banner
              type="warning"
              description="暂时无法查询确认结果，正在后台平滑重试..."
            />
          )}

          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Button
              theme="borderless"
              type="tertiary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setJob(await api(`/api/registrations/${job.id}/cancel`, {}));
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              取消等待
            </Button>
            <Typography.Text type="tertiary" size="small">
              取消等待不会删除已经在飞书确认创建的应用。
            </Typography.Text>
          </div>
        </div>
      ) : job?.status === "ready" ? (
        <Space
          vertical
          align="start"
          style={{ width: "100%" }}
          spacing="medium"
        >
          <Banner
            type={job.error ? "warning" : "info"}
            description={
              job.error
                ? "应用凭据已成功保存在本机。请处理提示后继续，无需重新输入密钥。"
                : job.permissions
                  ? permissionNotice(job.permissions)
                  : "正在核查应用权限并验证机器人可用性..."
            }
          />
          {job.permissions?.directory && (
            <Banner
              type="info"
              description={
                job.permissions.directory.status === "checked"
                  ? `通讯录授权范围：${job.permissions.directory.users} 位直接授权用户、${job.permissions.directory.departments} 个部门、${job.permissions.directory.groups} 个用户组${job.permissions.directory.allDepartments ? "（包含根部门）" : ""}。`
                  : "接口权限已授予，但通讯录可见范围未核实，请在飞书开放平台核对。"
              }
            />
          )}
          {job.permissions?.missing.length ? (
            <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
              仍缺少权限：{job.permissions.missing.join("、")}
            </Typography.Paragraph>
          ) : null}
          {job.appId &&
            job.permissions &&
            job.permissions.status !== "granted" && (
              <a
                href={`${job.tenant === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn"}/app/${encodeURIComponent(job.appId)}/auth?q=${encodeURIComponent(job.permissions.missing.join(","))}&token_type=tenant`}
                target="_blank"
                rel="noreferrer"
                style={{
                  color: "var(--feishu-primary)",
                  textDecoration: "none",
                  fontWeight: 500,
                }}
              >
                前往飞书开放平台核对权限与审批 ↗
              </a>
            )}
          {job.permissions?.status === "configuration_required" && (
            <Button
              theme="solid"
              type="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setJob(
                    await api(`/api/registrations/${job.id}/authorize`, {}),
                  );
                  setError(null);
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              重新打开权限确认
            </Button>
          )}
          {job.permissions &&
            !["granted", "configuration_required"].includes(
              job.permissions.status,
            ) && (
              <Typography.Text type="tertiary" size="small">
                正在等待管理员审批或版本发布生效，页面会自动持续核查。
              </Typography.Text>
            )}
          {job.error && (
            <Button
              theme="solid"
              type="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const current = await api("/api/config");
                  const result = await api(
                    `/api/registrations/${job.id}/finish`,
                    { revision: current.revision },
                  );
                  if (result.configuration) saved.current(result.configuration);
                  else setJob(result.registration);
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              重新读取配置并完成保存
            </Button>
          )}
        </Space>
      ) : (
        <Space
          vertical
          align="start"
          style={{ width: "100%" }}
          spacing="medium"
        >
          {job && (
            <Banner
              type="warning"
              description={
                job.status === "denied"
                  ? "已在飞书端拒绝创建应用。"
                  : job.status === "expired"
                    ? "二维码已过期，请点击下方按钮重新生成。"
                    : job.status === "cancelled"
                      ? "已取消扫码等待。"
                      : "本次创建未完成，请重试。"
              }
            />
          )}
          <Button
            theme="solid"
            type="primary"
            icon={<IconQrCode />}
            loading={busy}
            disabled={!input.name.trim() || !input.agentId || !input.projectId}
            onClick={begin}
          >
            {job ? "重新获取二维码" : "获取飞书创建二维码"}
          </Button>
        </Space>
      )}
    </Space>
  );
}

function permissionNotice(state: PermissionStatus) {
  return {
    granted: "权限已完全生效，正在自动保存机器人并载入配置...",
    configuration_required:
      "官方确认流程尚未使全部权限生效。可重新打开确认页，或在应用后台核对并发布权限配置。",
    submitted: "权限申请已提交给飞书企业管理员，正在等待批准和生效。",
    pending: "飞书已有此应用的权限申请，正在等待批准。",
    unknown: "申请结果暂未确认，已停止重复提交。请在飞书后台核对审批状态。",
    limited: "飞书权限申请次数已达上限，请在后台处理现有申请。",
    sensitive: "剩余权限需要管理员在后台处理，平台不支持自动申请。",
    external_pending: "此应用还有本项目以外的待审权限，请在后台核对后提交。",
    unverified: "平台未发现可申请的权限，正在重新核验实际授予状态。",
  }[state.status];
}
