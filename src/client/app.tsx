import { RobotModelSelect } from "./ModelSettings.js";
import {
  WorkspaceSettings,
  WorkspaceSelect,
  workspaceName,
} from "./WorkspaceSettings.js";
import { ConnectionPanel } from "./ConnectionPanel.js";
import { SetupError } from "./SetupError.js";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Empty,
  Input,
  Layout,
  Nav,
  Radio,
  RadioGroup,
  Row,
  Col,
  Select,
  Space,
  Spin,
  Tag,
  TextArea,
  Typography,
} from "@douyinfe/semi-ui";
import {
  IconFolder,
  IconActivity,
  IconPlus,
  IconArrowLeft,
  IconSearch,
} from "@douyinfe/semi-icons";

export function RobotIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: "middle" }}
    >
      <rect x="3" y="11" width="18" height="10" rx="3" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <line x1="8" y1="16" x2="8.01" y2="16" />
      <line x1="16" y1="16" x2="16.01" y2="16" />
    </svg>
  );
}
import "./client.css";
import type { Config, Bot } from "../config.js";
import type { RobotInput } from "../bot-setup.js";
import { RegistrationPanel } from "./RegistrationPanel.js";
import { api, ApiError, connectFromLink } from "./api.js";

type Configuration = {
  config: Config;
  revision: string;
  pendingRestart: boolean;
};
type RobotDraft = Omit<RobotInput, "revision">;
type View = "robots" | "projects" | "diagnostics";
const draftKey = "easy-larky-robot-draft";
const pendingKey = "easy-larky-pending";
const names: Record<string, string> = {
  robots: "机器人",
  projects: "工作区",
  diagnostics: "运行状态",
};
const states: Record<string, string> = {
  queued: "等待执行",
  running: "执行中",
  waiting: "等待协作",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  interrupted: "执行中断",
};
const active = new Set(["queued", "running", "waiting"]);

function stored<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function agentLabel(cfg: Config, id: string) {
  const agent = cfg.agents.find((a) => a.id === id);
  return agent?.runtime === "codex"
    ? "ChatGPT (Codex)"
    : agent?.runtime === "grok"
      ? "Grok Build"
      : agent?.runtime === "pi"
        ? "Pi Agent"
        : id;
}

function App() {
  const [view, setView] = useState<View>("robots");
  const [state, setState] = useState<any>(null);
  const [configuration, setConfiguration] = useState<Configuration | null>(
    null,
  );
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [registrations, setRegistrations] = useState<any[]>([]);
  const [scanMode, setScanMode] = useState(true);
  const [scanLocked, setScanLocked] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [robot, setRobot] = useState<RobotDraft | null>(() => {
    const draft = stored<RobotDraft>(draftKey);
    return draft && typeof draft.id === "string"
      ? { ...draft, secret: "" }
      : null;
  });
  const loaded = useRef(false);
  const alive = useRef(true);

  async function reloadConfiguration() {
    const data = await api<Configuration>("/api/config");
    const pending = await api<any[]>("/api/registrations");
    if (alive.current) {
      setConfiguration(data);
      setRegistrations(pending);
    }
  }

  async function refresh() {
    if (!sessionStorage.getItem("easy-larky-session")) return;
    try {
      const next = await api("/api/state");
      if (!alive.current) return;
      setState(next);
      setConnected(true);
      if (!loaded.current) {
        await reloadConfiguration();
        loaded.current = true;
      }
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status === 401) {
        sessionStorage.removeItem("easy-larky-session");
        setConnected(false);
        loaded.current = false;
      }
      setError(e);
    }
  }

  useEffect(() => {
    alive.current = true;
    const connect = async () => {
      try {
        await connectFromLink();
        await refresh();
      } catch (e) {
        if (alive.current) setError(e);
      }
    };
    void connect();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2500);
    window.addEventListener("hashchange", connect);
    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener("hashchange", connect);
    };
  }, []);

  function remember(next: RobotDraft) {
    const { secret, ...plain } = next;
    sessionStorage.setItem(draftKey, JSON.stringify(plain));
    setRobot(next);
  }

  function edit(bot?: Bot) {
    const cfg = configuration!.config;
    remember({
      id: bot?.id ?? `bot-${crypto.randomUUID()}`,
      name: bot?.name ?? bot?.id ?? "",
      agentId: bot?.agentId ?? cfg.agents[0]?.id ?? "",
      model: bot?.model ?? null,
      projectId:
        bot?.projectId ??
        cfg.bindings.find((b) => b.botId === bot?.id)?.projectId ??
        cfg.projects[0]?.id ??
        "",
      tenant: bot?.tenant ?? "feishu",
      appId: bot?.appId ?? "",
      secret: "",
    });
    setError(null);
    setNotice("");
    setConnecting(false);
  }

  async function saveRobot() {
    if (!robot || !configuration || busy) return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = await api("/api/robots", {
        ...robot,
        revision: configuration.revision,
      });
      if (result.registration) {
        setConnecting(true);
        return;
      }
      setConfiguration(result);
      setRobot(null);
      sessionStorage.removeItem(draftKey);
      setNotice(
        result.pendingRestart
          ? "机器人已保存。点击“应用设置并上线”，再授权使用会话。"
          : "机器人设置已保存。",
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig(cfg: Config) {
    if (!configuration || busy) return false;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = await api<Configuration>("/api/config", {
        config: cfg,
        revision: configuration.revision,
      });
      setConfiguration(result);
      setNotice(
        result.pendingRestart
          ? "设置已保存，点击“应用设置并上线”使其生效。"
          : "设置已保存。",
      );
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <main className="connect-page">
        <Card className="connect-card" headerLine={false}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: "linear-gradient(135deg, #3370ff 0%, #2055d5 100%)",
                color: "#ffffff",
                display: "grid",
                placeItems: "center",
                fontSize: 26,
                margin: "0 auto 12px",
                boxShadow: "0 4px 12px rgba(51, 112, 255, 0.3)",
              }}
            >
              <RobotIcon size={26} />
            </div>
            <Typography.Title heading={4} style={{ margin: 0 }}>
              连接 easy-larky 本地工作台
            </Typography.Title>
            <Typography.Text
              type="secondary"
              size="small"
              style={{ display: "block", marginTop: 4 }}
            >
              飞书 Agent 本地一体化控制台
            </Typography.Text>
          </div>
          <Typography.Paragraph style={{ fontSize: 14 }}>
            在终端工程目录中运行：
          </Typography.Paragraph>
          <div className="connect-pre">npm start -- console</div>
          <Typography.Paragraph
            type="secondary"
            size="small"
            style={{ marginTop: 12 }}
          >
            浏览器将通过一次性安全链接连接本机服务。服务重启或会话过期后重新运行即可。
          </Typography.Paragraph>
          {!!error && <SetupError error={error} />}
        </Card>
      </main>
    );
  }

  const cfg = configuration?.config;

  const navItems = [
    { itemKey: "robots", text: "机器人", icon: <RobotIcon size={20} /> },
    { itemKey: "projects", text: "工作区", icon: <IconFolder size="large" /> },
    {
      itemKey: "diagnostics",
      text: "运行状态",
      icon: <IconActivity size="large" />,
    },
  ];

  return (
    <div className="workbench">
      <aside className="sidebar-wrapper">
        <Nav
          selectedKeys={[view]}
          onSelect={(data) => {
            if (!busy) {
              setView(data.itemKey as View);
              setError(null);
              setNotice("");
            }
          }}
          header={
            <div className="brand-header">
              <div className="brand-logo">
                <RobotIcon size={20} />
              </div>
              <div className="brand-info">
                <span className="brand-name">easy-larky</span>
                <span className="brand-desc">飞书 Agent 本地工作台</span>
              </div>
            </div>
          }
          items={navItems}
          footer={
            <div className="sidebar-footer">
              <div className="status-badge-bar">
                <Badge
                  dot
                  type={
                    state?.health.mode === "offline" ? "warning" : "success"
                  }
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: "var(--feishu-text-secondary)",
                    }}
                  >
                    {state?.health.mode === "offline"
                      ? "本地模式"
                      : "Lark 模式"}
                  </span>
                </Badge>
                <Tag size="small" color="green" type="light">
                  已连接
                </Tag>
              </div>
              <Button
                theme="borderless"
                type="tertiary"
                size="small"
                block
                onClick={async () => {
                  try {
                    await api("/api/logout", {});
                  } catch {}
                  sessionStorage.removeItem("easy-larky-session");
                  setConnected(false);
                  loaded.current = false;
                }}
              >
                断开工作台
              </Button>
            </div>
          }
        />
      </aside>

      <main className="main-content">
        <div className="page-heading">
          <div className="page-title-group">
            <h2>{names[view]}</h2>
            <p className="page-subtitle">
              {view === "robots"
                ? "连接飞书应用，设置机器人的模型、Agent 运行时与工作区。"
                : view === "projects"
                  ? "管理本机工作目录，授权机器人进行文件读取与任务落地。"
                  : "查看任务历史、飞书收发记录，执行本地 CLI 诊断测试。"}
            </p>
          </div>
          <div className="page-actions">
            <Tag
              size="large"
              color={state?.health.mode === "offline" ? "orange" : "blue"}
              type="light"
            >
              {state?.health.mode === "offline" ? "本地离线" : "飞书已连接"}
            </Tag>
          </div>
        </div>

        <Space vertical align="start" style={{ width: "100%" }} spacing="loose">
          {!!error && (
            <SetupError
              error={error}
              appId={robot?.appId}
              tenant={robot?.tenant}
              onClose={() => setError(null)}
            />
          )}
          {notice && (
            <Banner
              type="success"
              description={notice}
              style={{ width: "100%" }}
            />
          )}

          {!cfg ? (
            <div
              style={{ textAlign: "center", width: "100%", padding: "60px 0" }}
            >
              <Spin size="large" />
            </div>
          ) : view === "robots" ? (
            robot ? (
              <Card
                className="robot-editor feishu-card"
                headerLine={false}
                title={
                  <span style={{ fontSize: 16, fontWeight: 600 }}>
                    {cfg.bots.some((b) => b.id === robot.id)
                      ? "机器人设置"
                      : "添加机器人"}
                  </span>
                }
                headerExtraContent={
                  <Button
                    theme="borderless"
                    icon={<IconArrowLeft />}
                    disabled={busy}
                    onClick={() => {
                      setRobot(null);
                      setConnecting(false);
                      void reloadConfiguration();
                    }}
                  >
                    返回
                  </Button>
                }
              >
                {!cfg.bots.some((b) => b.id === robot.id) && (
                  <div style={{ marginBottom: 20 }}>
                    <RadioGroup
                      type="button"
                      value={scanMode ? "scan" : "manual"}
                      disabled={scanLocked}
                      onChange={(e) => setScanMode(e.target.value === "scan")}
                    >
                      <Radio value="scan">扫码创建（推荐）</Radio>
                      <Radio value="manual">接入已有应用</Radio>
                    </RadioGroup>
                  </div>
                )}

                <div
                  className={
                    scanLocked ? "registration-details-hidden" : undefined
                  }
                >
                  <Row gutter={24}>
                    <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                      <div
                        style={{
                          marginBottom: 6,
                          fontWeight: 500,
                          fontSize: 14,
                        }}
                      >
                        机器人名称 <span style={{ color: "#f93920" }}>*</span>
                      </div>
                      <Input
                        aria-label="机器人名称"
                        value={robot.name}
                        maxLength={80}
                        placeholder="例如：叶玥"
                        disabled={busy || scanLocked}
                        onChange={(value) =>
                          remember({ ...robot, name: value })
                        }
                      />
                    </Col>
                    <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                      <div
                        style={{
                          marginBottom: 6,
                          fontWeight: 500,
                          fontSize: 14,
                        }}
                      >
                        使用哪个 Agent
                      </div>
                      <Select
                        aria-label="使用哪个 Agent"
                        value={robot.agentId}
                        style={{ width: "100%" }}
                        disabled={busy || scanLocked}
                        optionList={cfg.agents.map((a) => ({
                          value: a.id,
                          label: agentLabel(cfg, a.id),
                        }))}
                        onChange={(value) =>
                          remember({
                            ...robot,
                            agentId: typeof value === "string" ? value : "",
                            model: null,
                          })
                        }
                      />
                    </Col>
                    <Col xs={24} md={12}>
                      <RobotModelSelect
                        key={robot.agentId}
                        agent={cfg.agents.find((a) => a.id === robot.agentId)}
                        value={robot.model ?? null}
                        disabled={busy || scanLocked}
                        onChange={(model) => remember({ ...robot, model })}
                      />
                    </Col>
                    <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                      <div
                        style={{
                          marginBottom: 6,
                          fontWeight: 500,
                          fontSize: 14,
                        }}
                      >
                        工作区
                      </div>
                      <WorkspaceSelect
                        projects={cfg.projects}
                        value={robot.projectId}
                        disabled={busy || scanLocked}
                        onChange={(value) =>
                          remember({ ...robot, projectId: value })
                        }
                      />
                      <Button
                        theme="borderless"
                        size="small"
                        disabled={busy || scanLocked}
                        onClick={() => setView("projects")}
                        style={{ marginTop: 4, padding: 0 }}
                      >
                        管理 / 添加工作区
                      </Button>
                    </Col>
                    <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                      <div
                        style={{
                          marginBottom: 6,
                          fontWeight: 500,
                          fontSize: 14,
                        }}
                      >
                        平台
                      </div>
                      <Select
                        aria-label="平台"
                        value={robot.tenant}
                        style={{ width: "100%" }}
                        disabled={busy || scanLocked}
                        optionList={[
                          { value: "feishu", label: "飞书" },
                          { value: "lark", label: "Lark (国际版)" },
                        ]}
                        onChange={(value) =>
                          remember({
                            ...robot,
                            tenant: (value as "feishu" | "lark") || "feishu",
                          })
                        }
                      />
                    </Col>
                  </Row>

                  {!connecting &&
                    (!scanMode || cfg.bots.some((b) => b.id === robot.id)) && (
                      <div
                        style={{
                          marginTop: 12,
                          borderTop: "1px solid var(--feishu-border-light)",
                          paddingTop: 16,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 16,
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>连接飞书应用</span>
                          <span>·</span>
                          <a
                            href={
                              robot.tenant === "lark"
                                ? "https://open.larksuite.com/app"
                                : "https://open.feishu.cn/app"
                            }
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              color: "var(--feishu-primary)",
                              textDecoration: "none",
                              fontSize: 13,
                            }}
                          >
                            打开{robot.tenant === "lark" ? " Lark " : "飞书"}
                            开放平台 ↗
                          </a>
                        </div>
                        <div style={{ marginBottom: 16 }}>
                          <div
                            style={{
                              marginBottom: 6,
                              fontWeight: 500,
                              fontSize: 14,
                            }}
                          >
                            App ID <span style={{ color: "#f93920" }}>*</span>
                          </div>
                          <Input
                            aria-label="App ID"
                            value={robot.appId}
                            placeholder="cli_…"
                            disabled={busy}
                            onChange={(value) =>
                              remember({ ...robot, appId: value })
                            }
                          />
                        </div>
                        <div style={{ marginBottom: 16 }}>
                          <div
                            style={{
                              marginBottom: 6,
                              fontWeight: 500,
                              fontSize: 14,
                            }}
                          >
                            App Secret{" "}
                            {!cfg.bots.some((b) => b.id === robot.id) && (
                              <span style={{ color: "#f93920" }}>*</span>
                            )}
                          </div>
                          <Input
                            mode="password"
                            aria-label="App Secret"
                            autoComplete="new-password"
                            value={robot.secret}
                            placeholder={
                              cfg.bots.some((b) => b.id === robot.id)
                                ? "已保存在本机，更换时再输入"
                                : "粘贴应用密钥"
                            }
                            disabled={busy}
                            onChange={(value) =>
                              setRobot({ ...robot, secret: value })
                            }
                          />
                          <Typography.Text
                            type="tertiary"
                            size="small"
                            style={{ display: "block", marginTop: 4 }}
                          >
                            仅保存在本机；等待权限审批时也会安全保留，方便继续接入。
                          </Typography.Text>
                        </div>
                        <div className="form-actions">
                          <Typography.Text type="tertiary" size="small">
                            自动检查并申请本项目缺少的权限。不会向群或联系人发送测试消息。
                          </Typography.Text>
                          <Button
                            theme="solid"
                            type="primary"
                            loading={busy}
                            disabled={
                              !robot.name.trim() ||
                              !robot.appId.trim() ||
                              (!cfg.bots.some((b) => b.id === robot.id) &&
                                !robot.secret)
                            }
                            onClick={() => void saveRobot()}
                          >
                            {cfg.bots.some((b) => b.id === robot.id)
                              ? "保存设置"
                              : "连接并保存"}
                          </Button>
                        </div>
                      </div>
                    )}
                </div>

                {(connecting ||
                  (scanMode && !cfg.bots.some((b) => b.id === robot.id))) && (
                  <RegistrationPanel
                    input={{
                      id: robot.id,
                      name: robot.name,
                      agentId: robot.agentId,
                      model: robot.model,
                      projectId: robot.projectId,
                      tenant: robot.tenant,
                      revision: configuration!.revision,
                    }}
                    onLock={setScanLocked}
                    onSaved={(result) => {
                      setConfiguration(result);
                      setRobot(null);
                      setScanLocked(false);
                      setConnecting(false);
                      sessionStorage.removeItem(draftKey);
                      setNotice(
                        "机器人已保存。点击“应用设置并上线”，再授权使用会话。",
                      );
                    }}
                  />
                )}
              </Card>
            ) : (
              <>
                <ConnectionPanel
                  config={cfg}
                  changed={async () => {
                    await reloadConfiguration();
                    await refresh();
                  }}
                />

                {!cfg.bots.length ? (
                  <Card
                    className="feishu-card"
                    style={{ textAlign: "center", padding: "40px 20px" }}
                  >
                    <Empty
                      title="还没有配置机器人"
                      description="扫码创建飞书机器人，或接入已有的飞书开放平台应用。"
                    />
                    <Button
                      theme="solid"
                      type="primary"
                      icon={<IconPlus />}
                      style={{ marginTop: 20 }}
                      onClick={() => edit()}
                    >
                      添加机器人
                    </Button>
                  </Card>
                ) : (
                  <>
                    <div className="robots-grid">
                      {cfg.bots.map((bot) => (
                        <div key={bot.id} className="robot-card">
                          <div className="robot-card-head">
                            <div className="robot-card-title">
                              <div
                                style={{
                                  width: 32,
                                  height: 32,
                                  borderRadius: 8,
                                  background: "var(--feishu-primary-light)",
                                  color: "var(--feishu-primary)",
                                  display: "grid",
                                  placeItems: "center",
                                }}
                              >
                                <RobotIcon size={18} />
                              </div>
                              <span>{bot.name || bot.id}</span>
                            </div>
                            <Button
                              theme="borderless"
                              size="small"
                              onClick={() => edit(bot)}
                            >
                              设置
                            </Button>
                          </div>

                          <div className="robot-meta-row">
                            <div className="robot-meta-item">
                              <span className="robot-meta-label">运行时：</span>
                              <Tag color="blue" type="light" size="small">
                                {agentLabel(cfg, bot.agentId)}
                              </Tag>
                            </div>
                            <div className="robot-meta-item">
                              <span className="robot-meta-label">模型：</span>
                              <span>
                                {bot.model ||
                                  cfg.agents.find((a) => a.id === bot.agentId)
                                    ?.model ||
                                  "跟随 CLI 默认"}
                              </span>
                            </div>
                            <div className="robot-meta-item">
                              <span className="robot-meta-label">工作区：</span>
                              <span style={{ wordBreak: "break-all" }}>
                                {workspaceName(
                                  cfg.projects.find(
                                    (p) => p.id === bot.projectId,
                                  ),
                                )}
                              </span>
                            </div>
                            <div className="robot-meta-item">
                              <span className="robot-meta-label">会话：</span>
                              <span
                                style={{
                                  color: cfg.bindings.some(
                                    (b) => b.botId === bot.id,
                                  )
                                    ? "var(--semi-color-success)"
                                    : "var(--feishu-text-tertiary)",
                                }}
                              >
                                {cfg.bindings.some((b) => b.botId === bot.id)
                                  ? "已配置使用会话"
                                  : "等待会话授权"}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <Space wrap>
                      <Button
                        theme="solid"
                        type="primary"
                        icon={<IconPlus />}
                        onClick={() => edit()}
                      >
                        添加机器人
                      </Button>
                      {registrations
                        .filter(
                          (j) => j.status === "pending" || j.status === "ready",
                        )
                        .map((j) => (
                          <Button
                            key={j.id}
                            onClick={() => {
                              setScanMode(j.intent !== "connect");
                              setConnecting(true);
                              remember({
                                id: j.botId,
                                name: j.name,
                                agentId: j.agentId,
                                model: j.model,
                                projectId: j.projectId,
                                tenant: j.tenant,
                                appId: j.appId || "",
                                secret: "",
                              });
                            }}
                          >
                            继续连接：{j.name}
                          </Button>
                        ))}
                      {stored<RobotDraft>(draftKey) && (
                        <Button
                          theme="borderless"
                          onClick={() =>
                            setRobot({
                              ...stored<RobotDraft>(draftKey)!,
                              secret: "",
                            })
                          }
                        >
                          继续未保存的草稿
                        </Button>
                      )}
                    </Space>
                  </>
                )}

                {configuration?.pendingRestart && (
                  <Banner
                    type="info"
                    style={{ width: "100%" }}
                    description="设置已保存，点击“应用设置并上线”使其生效。"
                  />
                )}
                <div style={{ marginTop: 8 }}>
                  <Button
                    size="small"
                    theme="borderless"
                    onClick={() =>
                      void reloadConfiguration().catch((e) => setError(e))
                    }
                  >
                    重新读取配置
                  </Button>
                </div>
              </>
            )
          ) : view === "projects" ? (
            <WorkspaceSettings config={cfg} busy={busy} onSave={saveConfig} />
          ) : (
            <Diagnostics state={state} refresh={refresh} />
          )}
        </Space>
      </main>
    </div>
  );
}

type LocalTask = {
  requestId: string;
  agentId: string;
  projectId: string;
  prompt: string;
  allowWrites: boolean;
};

function Diagnostics({
  state,
  refresh,
}: {
  state: any;
  refresh: () => Promise<void>;
}) {
  const pending = stored<LocalTask>(pendingKey);
  const [task, setTask] = useState<LocalTask>(
    pending || {
      requestId: crypto.randomUUID(),
      agentId: state.agents[0]?.id || "",
      projectId: state.projects[0]?.id || "",
      prompt: "",
      allowWrites: false,
    },
  );
  const [uncertain, setUncertain] = useState(!!pending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let valid = true;
    void api(`/api/runs/${selected}`)
      .then((data) => {
        if (valid) setDetail(data);
      })
      .catch((e) => {
        if (valid) setError(e);
      });
    return () => {
      valid = false;
    };
  }, [selected, state]);

  async function submit() {
    if (busy || !task.prompt.trim()) return;
    setBusy(true);
    setError(null);
    const request = stored<LocalTask>(pendingKey) || task;
    sessionStorage.setItem(pendingKey, JSON.stringify(request));
    setUncertain(true);
    try {
      const result = await api("/api/runs", request);
      sessionStorage.removeItem(pendingKey);
      setUncertain(false);
      setSelected(result.runId);
      setTask({
        ...task,
        requestId: crypto.randomUUID(),
        prompt: "",
        allowWrites: false,
      });
      await refresh();
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status < 500 &&
        e.message !== "message_id_conflict"
      ) {
        sessionStorage.removeItem(pendingKey);
        setUncertain(false);
      }
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const runs = state.runs.filter(
    (r: any) =>
      (r.title + " " + r.id).toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "active" && active.has(r.state)) ||
        r.state === filter),
  );

  const promptTemplates = [
    {
      label: "查看目录结构",
      prompt: "请列出当前工作区的一级目录和核心文件，并简要说明其用途。",
    },
    {
      label: "检查 Git 状态",
      prompt: "检查当前项目的 git status，总结未提交的修改或未追踪的新文件。",
    },
    {
      label: "运行单元测试",
      prompt: "执行项目当前的测试套件，并告诉我测试是否全部通过。",
    },
    {
      label: "飞书插件打招呼",
      prompt: "你好！请向团队介绍你自己以及你可以协助完成哪些本地开发工作。",
    },
  ];

  return (
    <Space vertical align="start" style={{ width: "100%" }} spacing="loose">
      {!!error && <SetupError error={error} />}
      <div className="diagnostics-grid">
        <Card
          className="feishu-card"
          headerLine={false}
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>任务记录</span>
              <Tag size="small" color="blue" type="light">
                {runs.length}
              </Tag>
            </div>
          }
          headerExtraContent={
            <Button
              theme="borderless"
              size="small"
              onClick={() => setSelected(null)}
            >
              + 本地接入测试
            </Button>
          }
        >
          <Space
            vertical
            align="start"
            style={{ width: "100%" }}
            spacing="medium"
          >
            <Input
              prefix={<IconSearch />}
              aria-label="搜索任务"
              placeholder="搜索任务标题或 ID"
              value={query}
              onChange={setQuery}
              showClear
            />
            <Select
              aria-label="筛选状态"
              value={filter}
              style={{ width: "100%" }}
              onChange={(val) =>
                setFilter(typeof val === "string" ? val : "all")
              }
              optionList={[
                { value: "all", label: "全部状态" },
                { value: "active", label: "正在进行" },
                { value: "completed", label: "已完成" },
                { value: "failed", label: "执行失败" },
                { value: "cancelled", label: "已取消" },
              ]}
            />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                width: "100%",
                maxHeight: 560,
                overflow: "auto",
              }}
            >
              {runs.length ? (
                runs.map((run: any) => (
                  <button
                    key={run.id}
                    type="button"
                    className={`run-item-btn ${selected === run.id ? "active" : ""}`}
                    onClick={() => setSelected(run.id)}
                  >
                    <div className="run-item-title">{run.title}</div>
                    <div className="run-item-sub">
                      <Tag
                        size="small"
                        color={
                          run.state === "completed"
                            ? "green"
                            : run.state === "failed"
                              ? "red"
                              : run.state === "cancelled"
                                ? "grey"
                                : "blue"
                        }
                        type="light"
                        style={{ marginRight: 6 }}
                      >
                        {states[run.state] || run.state}
                      </Tag>
                      <span>{run.agentId}</span> ·{" "}
                      <span>
                        {run.source === "local" ? "本地 CLI" : "飞书消息"}
                      </span>
                    </div>
                  </button>
                ))
              ) : (
                <Empty title="没有匹配的任务记录" />
              )}
            </div>
          </Space>
        </Card>

        {selected ? (
          <Card
            className="feishu-card"
            headerLine={false}
            title={
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 16, fontWeight: 600 }}>
                  任务执行结果
                </span>
                {detail && (
                  <Tag
                    color={
                      detail.run.state === "completed"
                        ? "green"
                        : detail.run.state === "failed"
                          ? "red"
                          : "blue"
                    }
                    type="light"
                  >
                    {states[detail.run.state] || detail.run.state}
                  </Tag>
                )}
              </div>
            }
            headerExtraContent={
              <Button
                theme="borderless"
                size="small"
                onClick={() => setSelected(null)}
              >
                新建测试
              </Button>
            }
          >
            {!detail ? (
              <div style={{ textAlign: "center", padding: 60 }}>
                <Spin size="large" />
              </div>
            ) : (
              <Space
                vertical
                align="start"
                style={{ width: "100%" }}
                spacing="loose"
              >
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: "var(--feishu-text-primary)",
                    lineHeight: 1.4,
                    background: "#f8f9fa",
                    padding: "10px 14px",
                    borderRadius: 8,
                    border: "1px solid var(--feishu-border-light)",
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                >
                  {detail.run.prompt}
                </div>

                <Descriptions
                  row
                  data={[
                    { key: "任务编号", value: detail.run.id },
                    {
                      key: "执行渠道",
                      value: detail.run.local
                        ? "本地测试 (CLI Adapter)"
                        : "飞书长连接协作消息",
                    },
                  ]}
                />

                <div style={{ width: "100%" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 8,
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      模型输出 / 执行结果：
                    </span>
                    <Button
                      theme="borderless"
                      size="small"
                      onClick={() => {
                        const content =
                          detail.run.error || detail.run.result || "";
                        void navigator.clipboard.writeText(content);
                      }}
                    >
                      复制结果
                    </Button>
                  </div>
                  <pre
                    className="result-text"
                    style={{
                      borderLeft: detail.run.error
                        ? "3px solid #f93920"
                        : "3px solid #3370ff",
                      background: detail.run.error ? "#fff5f5" : "#f8f9fa",
                    }}
                  >
                    {detail.run.error || detail.run.result || "暂无输出"}
                  </pre>
                </div>

                <details style={{ width: "100%", fontSize: 13 }}>
                  <summary
                    style={{
                      cursor: "pointer",
                      color: "var(--feishu-primary)",
                      fontWeight: 500,
                      padding: "4px 0",
                    }}
                  >
                    查看底层 Session 与分步投递凭据 ↗
                  </summary>
                  <pre
                    className="result-text"
                    style={{ marginTop: 8, fontSize: 12 }}
                  >
                    {JSON.stringify(
                      {
                        providerSessionId: detail.run.providerSessionId,
                        deliveries: detail.deliveries,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>

                {detail.run.local && active.has(detail.run.state) && (
                  <Button
                    theme="solid"
                    type="danger"
                    loading={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api(`/api/runs/${selected}/cancel`, {});
                        await refresh();
                      } catch (e) {
                        setError(e);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    停止任务
                  </Button>
                )}
              </Space>
            )}
          </Card>
        ) : (
          <Card
            className="feishu-card"
            headerLine={false}
            title={
              <span style={{ fontSize: 16, fontWeight: 600 }}>
                本地接入测试
              </span>
            }
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 16,
                }}
              >
                <div>
                  <div
                    style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}
                  >
                    测试 Agent
                  </div>
                  <Select
                    aria-label="测试 Agent"
                    value={task.agentId}
                    style={{ width: "100%" }}
                    optionList={state.agents.map((a: any) => ({
                      value: a.id,
                      label: a.id,
                    }))}
                    onChange={(val) =>
                      setTask({
                        ...task,
                        agentId: typeof val === "string" ? val : "",
                      })
                    }
                  />
                </div>
                <div>
                  <div
                    style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}
                  >
                    测试工作区
                  </div>
                  <WorkspaceSelect
                    projects={state.projects}
                    value={task.projectId}
                    label="测试工作区"
                    onChange={(value) => setTask({ ...task, projectId: value })}
                  />
                </div>
              </div>

              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontWeight: 500, fontSize: 14 }}>
                    任务提示词 (Prompt)
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--feishu-text-tertiary)",
                    }}
                  >
                    快捷填入：
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  {promptTemplates.map((t) => (
                    <Tag
                      key={t.label}
                      type="light"
                      color="blue"
                      style={{ cursor: "pointer" }}
                      onClick={() => setTask({ ...task, prompt: t.prompt })}
                    >
                      {t.label}
                    </Tag>
                  ))}
                </div>
                <TextArea
                  aria-label="任务目标"
                  value={task.prompt}
                  maxLength={12000}
                  rows={6}
                  placeholder="输入测试提示词，将在指定工作区内调用对应 Agent 执行"
                  onChange={(val) => setTask({ ...task, prompt: val })}
                />
              </div>

              <div>
                <Checkbox
                  checked={task.allowWrites}
                  onChange={(e) =>
                    setTask({ ...task, allowWrites: !!e.target.checked })
                  }
                >
                  允许在所选工作区目录内修改或创建文件
                </Checkbox>
              </div>

              <Typography.Text type="tertiary" size="small">
                本地 CLI
                调试任务，不向任何飞书联系人发信。默认只读，停止任务不会撤销已写入的修改。
              </Typography.Text>

              {uncertain && (
                <Banner
                  type="info"
                  description="上次提交尚未确认。重试使用同一请求编号，避免重复执行。"
                />
              )}

              <Button
                theme="solid"
                type="primary"
                loading={busy}
                disabled={!task.prompt.trim()}
                onClick={submit}
              >
                {uncertain ? "核对并重试" : "开始本地执行"}
              </Button>
            </div>
          </Card>
        )}
      </div>
    </Space>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
