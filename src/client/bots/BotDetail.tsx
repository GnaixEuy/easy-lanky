import React, { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Breadcrumb,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Modal,
  Radio,
  RadioGroup,
  Row,
  Select,
  Space,
  Switch,
  Tabs,
  TabPane,
  Tag,
  Typography,
} from "@douyinfe/semi-ui";
import {
  IconArrowLeft,
  IconCheckCircleStroked,
  IconAlertCircle,
  IconUser,
  IconComment,
  IconDelete,
  IconFolder,
  IconCopy,
  IconSearch,
} from "@douyinfe/semi-icons";
import { RobotModelSelect } from "../ModelSettings.js";
import type { Config, Bot, Binding } from "../../config.js";
import { BotPermissions } from "../PermissionReadiness.js";
import { RobotIcon, agentLabel, workspaceName } from "./BotList.js";
import { api, explain } from "../api.js";

interface BotDetailProps {
  bot: Bot;
  config: Config;
  connectionState: any;
  onBack: () => void;
  onSaveBot: (draft: {
    id: string;
    name: string;
    agentId: string;
    model: string | null;
    projectId: string;
    tenant: "feishu" | "lark";
    appId: string;
    secret: string;
  }) => Promise<boolean>;
  onDeleteBot: (botId: string) => Promise<void>;
  onAuthorizeCandidate: (candidate: any) => Promise<void>;
  onRevokeUser: (botId: string, userId: string, name: string) => Promise<void>;
  onSetEveryone: (botId: string, enabled: boolean) => Promise<void>;
  onReconnect: () => Promise<void>;
  pendingRestart: boolean;
  onApplyRestart: () => Promise<void>;
  initialTab?: string;
}

export function BotDetail({
  bot,
  config,
  connectionState,
  onBack,
  onSaveBot,
  onDeleteBot,
  onAuthorizeCandidate,
  onRevokeUser,
  onSetEveryone,
  onReconnect,
  pendingRestart,
  onApplyRestart,
  initialTab = "config",
}: BotDetailProps) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 表单草稿状态
  const [name, setName] = useState(bot.name || "");
  const [agentId, setAgentId] = useState(bot.agentId);
  const [model, setModel] = useState(bot.model || "");
  const [projectId, setProjectId] = useState(bot.projectId || "");
  const [tenant, setTenant] = useState<"feishu" | "lark">(bot.tenant);
  const [appId, setAppId] = useState(bot.appId);
  const [secret, setSecret] = useState("");

  // 用户与人员列表
  const [people, setPeople] = useState<
    { botId: string; userId: string; name?: string }[]
  >([]);
  const [userSearch, setUserSearch] = useState("");

  useEffect(() => {
    setName(bot.name || "");
    setAgentId(bot.agentId);
    setModel(bot.model || "");
    setProjectId(bot.projectId || "");
    setTenant(bot.tenant);
    setAppId(bot.appId);
    setSecret("");
    setError("");
    setNotice("");
  }, [bot]);

  useEffect(() => {
    let alive = true;
    void api("/api/access/users")
      .then((res) => {
        if (alive && res?.users) setPeople(res.users);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bot.id, bot.allowedUsers]);

  // 当前机器人的长连接通道状态
  const channel = connectionState?.channels?.find(
    (c: any) => c.botId === bot.id,
  );
  const isOnline =
    connectionState?.mode === "lark" && channel?.connection === "connected";
  const isFailed = channel?.connection === "failed";

  // 当前机器人的待审批会话
  const botCandidates = useMemo(() => {
    return (
      connectionState?.candidates?.filter((c: any) => c.botId === bot.id) || []
    );
  }, [connectionState?.candidates, bot.id]);

  const authorizedUsers = useMemo(
    () =>
      (bot.allowedUsers ?? []).map((userId) => ({
        userId,
        name:
          people.find((p) => p.botId === bot.id && p.userId === userId)?.name ||
          userId,
      })),
    [bot.allowedUsers, bot.id, people],
  );
  const filteredUsers = authorizedUsers.filter((u) =>
    `${u.name} ${u.userId}`
      .toLowerCase()
      .includes(userSearch.trim().toLowerCase()),
  );

  // 保存机器人设置
  async function handleSave() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await onSaveBot({
        id: bot.id,
        name: name.trim(),
        agentId,
        model: model.trim() ? model.trim() : null,
        projectId,
        tenant,
        appId: appId.trim(),
        secret: secret.trim(),
      });
      if (saved) setNotice("机器人设置已保存成功。");
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  // 删除机器人
  function confirmDelete() {
    Modal.confirm({
      title: `确定移除机器人「${bot.name || bot.id}」？`,
      content:
        "移除后将同时清理与该机器人关联的所有会话授权。本地代码和工作区文件不受影响。",
      okButtonProps: { type: "danger" },
      onOk: async () => {
        setBusy(true);
        try {
          await onDeleteBot(bot.id);
          onBack();
        } catch (e) {
          setError(explain(e));
        } finally {
          setBusy(false);
        }
      },
    });
  }

  return (
    <div style={{ width: "100%" }}>
      {/* 1. 顶部面包屑与导航 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <Breadcrumb>
          <Breadcrumb.Item
            onClick={onBack}
            style={{ cursor: "pointer", color: "var(--feishu-primary)" }}
          >
            机器人列表
          </Breadcrumb.Item>
          <Breadcrumb.Item>{bot.name || bot.id}</Breadcrumb.Item>
        </Breadcrumb>

        <Space>
          <Button
            theme="borderless"
            icon={<IconArrowLeft />}
            onClick={onBack}
            size="small"
          >
            返回列表
          </Button>
          {pendingRestart && (
            <Button
              theme="solid"
              type="warning"
              size="small"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onApplyRestart();
                  setNotice("设置已成功应用并重新上线。");
                } catch (e) {
                  setError(explain(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              应用设置并上线
            </Button>
          )}
          <Button
            theme="borderless"
            type="danger"
            size="small"
            icon={<IconDelete />}
            onClick={confirmDelete}
            disabled={busy}
          >
            删除机器人
          </Button>
        </Space>
      </div>

      {/* 2. 机器人头部身份横幅卡片 */}
      <Card
        className="feishu-card"
        style={{ marginBottom: 16 }}
        headerLine={false}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: isOnline
                  ? "rgba(51, 112, 255, 0.12)"
                  : "rgba(143, 149, 158, 0.12)",
                color: isOnline
                  ? "var(--feishu-primary)"
                  : "var(--feishu-text-tertiary)",
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              <RobotIcon size={26} />
            </div>

            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 18,
                    fontWeight: 600,
                    color: "var(--feishu-text-primary)",
                  }}
                >
                  {bot.name || bot.id}
                </span>
                <Tag
                  color={
                    isOnline
                      ? "green"
                      : isFailed
                        ? "red"
                        : connectionState?.mode === "offline"
                          ? "orange"
                          : "grey"
                  }
                  type="light"
                  size="small"
                >
                  {isOnline
                    ? "通道已连接"
                    : isFailed
                      ? "通道异常"
                      : connectionState?.mode === "offline"
                        ? "本地离线"
                        : "未连接"}
                </Tag>
                <Tag size="small" type="ghost">
                  {bot.tenant === "lark" ? "Lark 国际版" : "飞书国内版"}
                </Tag>
              </div>

              <div
                style={{
                  fontSize: 13,
                  color: "var(--feishu-text-secondary)",
                  marginTop: 4,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <span>
                  App ID: <code>{bot.appId}</code>
                </span>
                <span>·</span>
                <span>运行时: {agentLabel(config, bot.agentId)}</span>
                <span>·</span>
                <span>
                  默认工作区:{" "}
                  {workspaceName(
                    config.projects.find((p) => p.id === bot.projectId),
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* 提示与错误反馈 */}
      {error && (
        <Banner
          type="danger"
          description={error}
          style={{ marginBottom: 16 }}
          onClose={() => setError("")}
        />
      )}
      {notice && (
        <Banner
          type="success"
          description={notice}
          style={{ marginBottom: 16 }}
          onClose={() => setNotice("")}
        />
      )}

      {/* 3. 分层 Tabs 容器 */}
      <Card className="feishu-card" headerLine={false}>
        <Tabs
          type="line"
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key)}
        >
          {/* Tab 1: 核心配置 */}
          <TabPane tab="⚙️ 基本与运行时配置" itemKey="config">
            <div style={{ maxWidth: 760, paddingTop: 12 }}>
              <Row gutter={24}>
                <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                  <div
                    style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}
                  >
                    机器人名称 <span style={{ color: "#f93920" }}>*</span>
                  </div>
                  <Input
                    value={name}
                    maxLength={80}
                    placeholder="例如：叶翔"
                    disabled={busy}
                    onChange={(val) => setName(val)}
                  />
                </Col>

                <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                  <div
                    style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}
                  >
                    平台与租户类型 <span style={{ color: "#f93920" }}>*</span>
                  </div>
                  <RadioGroup
                    type="button"
                    value={tenant}
                    disabled={busy}
                    onChange={(e) => setTenant(e.target.value)}
                  >
                    <Radio value="feishu">飞书国内版 (feishu.cn)</Radio>
                    <Radio value="lark">Lark 国际版 (larksuite.com)</Radio>
                  </RadioGroup>
                </Col>

                <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                  <div
                    style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}
                  >
                    默认关联工作区 <span style={{ color: "#f93920" }}>*</span>
                  </div>
                  <Select
                    style={{ width: "100%" }}
                    value={projectId}
                    disabled={busy}
                    onChange={(val) => setProjectId(val as string)}
                    optionList={config.projects.map((p) => ({
                      value: p.id,
                      label: `${p.name || p.id} (${p.root})`,
                    }))}
                  />
                  <Typography.Text
                    type="tertiary"
                    size="small"
                    style={{ display: "block", marginTop: 4 }}
                  >
                    机器人接收到任务时默认使用的本机工作目录。
                  </Typography.Text>
                </Col>

                <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                  <div
                    style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}
                  >
                    AI 运行时引擎 (Agent){" "}
                    <span style={{ color: "#f93920" }}>*</span>
                  </div>
                  <Select
                    style={{ width: "100%" }}
                    value={agentId}
                    disabled={busy}
                    onChange={(val) => {
                      setAgentId(val as string);
                      setModel("");
                    }}
                    optionList={config.agents.map((a) => ({
                      value: a.id,
                      label: `${agentLabel(config, a.id)} (${a.id})`,
                    }))}
                  />
                </Col>

                <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                  <RobotModelSelect
                    agent={config.agents.find((a) => a.id === agentId)}
                    value={model || null}
                    disabled={busy}
                    onChange={(val) => setModel(val || "")}
                  />
                </Col>

                <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                  <div
                    style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}
                  >
                    App ID <span style={{ color: "#f93920" }}>*</span>
                  </div>
                  <Input
                    value={appId}
                    placeholder="cli_..."
                    disabled={busy}
                    onChange={(val) => setAppId(val)}
                  />
                </Col>

                <Col xs={24} style={{ marginBottom: 20 }}>
                  <div
                    style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}
                  >
                    App Secret
                  </div>
                  <Input
                    mode="password"
                    autoComplete="new-password"
                    value={secret}
                    placeholder="已安全保存在本机，若需更换密钥再输入新密钥"
                    disabled={busy}
                    onChange={(val) => setSecret(val)}
                  />
                  <Typography.Text
                    type="tertiary"
                    size="small"
                    style={{ display: "block", marginTop: 4 }}
                  >
                    仅保存在本机；密钥用于建立长连接信道与拉取飞书事件。
                  </Typography.Text>
                </Col>
              </Row>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 12,
                  marginTop: 12,
                }}
              >
                <Button
                  theme="solid"
                  type="primary"
                  loading={busy}
                  disabled={!name.trim() || !appId.trim()}
                  onClick={handleSave}
                >
                  保存设置
                </Button>
              </div>
            </div>
          </TabPane>

          {/* Tab 2: 人员授权 */}
          <TabPane
            tab={
              <span>
                👥 人员授权
                {botCandidates.length > 0 && (
                  <Badge
                    count={botCandidates.length}
                    type="warning"
                    style={{ marginLeft: 6 }}
                  />
                )}
              </span>
            }
            itemKey="conversations"
          >
            <Space
              vertical
              align="start"
              spacing="loose"
              style={{ width: "100%", paddingTop: 16 }}
            >
              <Space>
                <Switch
                  aria-label="允许所有人"
                  checked={bot.allowAllUsers === true}
                  disabled={busy}
                  onChange={async (enabled) => {
                    setBusy(true);
                    setError("");
                    try {
                      await onSetEveryone(bot.id, enabled);
                    } catch (e) {
                      setError(explain(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                <Typography.Text strong>允许所有人</Typography.Text>
              </Space>
              <Typography.Text type="tertiary">
                {bot.allowAllUsers
                  ? "任何能向机器人发消息的人均可使用，无需逐人授权。群聊中请 @ 机器人。"
                  : "按人员授权一次，私聊和群聊通用。群聊中请 @ 机器人。"}
              </Typography.Text>
              {!bot.allowAllUsers && (
                <>
                  <Typography.Title heading={5}>
                    待授权人员 ({botCandidates.length})
                  </Typography.Title>
                  {botCandidates.length === 0 ? (
                    <Typography.Text type="tertiary">
                      暂无申请。未授权人员向机器人发送消息后，会在这里列出。
                    </Typography.Text>
                  ) : (
                    botCandidates.map((candidate: any) => (
                      <Space
                        key={candidate.id}
                        style={{
                          width: "100%",
                          justifyContent: "space-between",
                        }}
                      >
                        <Typography.Text>
                          {candidate.senderName || candidate.senderId}
                        </Typography.Text>
                        <Button
                          loading={busy}
                          onClick={async () => {
                            setBusy(true);
                            setError("");
                            try {
                              await onAuthorizeCandidate(candidate);
                            } catch (e) {
                              setError(explain(e));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          授权此人
                        </Button>
                      </Space>
                    ))
                  )}
                  <Typography.Title heading={5}>
                    已授权人员 ({authorizedUsers.length})
                  </Typography.Title>
                  {!!authorizedUsers.length && (
                    <Input
                      prefix={<IconSearch />}
                      placeholder="搜索姓名或 ID..."
                      showClear
                      value={userSearch}
                      onChange={setUserSearch}
                    />
                  )}
                  {!authorizedUsers.length && (
                    <Typography.Text type="tertiary">
                      尚未授权任何人员。
                    </Typography.Text>
                  )}
                  {filteredUsers.map((user) => (
                    <div
                      key={user.userId}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        width: "100%",
                        padding: "12px 16px",
                        background: "var(--feishu-bg)",
                        borderRadius: 8,
                      }}
                    >
                      <div>
                        <Typography.Text strong>{user.name}</Typography.Text>
                        <div>
                          <Typography.Text type="tertiary" size="small">
                            {user.userId}
                          </Typography.Text>
                        </div>
                      </div>
                      <Button
                        theme="borderless"
                        type="danger"
                        loading={busy}
                        onClick={async () => {
                          setBusy(true);
                          setError("");
                          try {
                            await onRevokeUser(bot.id, user.userId, user.name);
                          } catch (e) {
                            setError(explain(e));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        移除授权
                      </Button>
                    </div>
                  ))}
                </>
              )}
            </Space>
          </TabPane>

          {/* Tab 3: 飞书侧权限与可用范围 */}
          <TabPane tab="🛡️ 飞书开放平台权限" itemKey="permissions">
            <div style={{ paddingTop: 12 }}>
              <BotPermissions bot={bot} />
            </div>
          </TabPane>

          {/* Tab 4: 通道与连接状态 */}
          <TabPane tab="📡 通道与连接状态" itemKey="channel">
            <div style={{ paddingTop: 12, maxWidth: 680 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "16px",
                  borderRadius: "var(--feishu-radius-card)",
                  background: "var(--feishu-bg)",
                  border: "1px solid var(--feishu-border-light)",
                  marginBottom: 16,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      marginBottom: 4,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span>长连接运行状态:</span>
                    <Tag
                      color={
                        isOnline
                          ? "green"
                          : isFailed
                            ? "red"
                            : connectionState?.mode === "offline"
                              ? "orange"
                              : "grey"
                      }
                      type="light"
                    >
                      {isOnline
                        ? "在线连接就绪"
                        : isFailed
                          ? "连接异常"
                          : connectionState?.mode === "offline"
                            ? "本地离线安全模式"
                            : "未连接"}
                    </Tag>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--feishu-text-tertiary)",
                    }}
                  >
                    {channel?.lastRawAt
                      ? `最近原生事件: ${new Date(channel.lastRawAt).toLocaleTimeString()}`
                      : "等待飞书信道事件..."}
                  </div>
                </div>

                <Button
                  theme="light"
                  type="primary"
                  loading={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onReconnect();
                      setNotice("已发起信道重连指令。");
                    } catch (e) {
                      setError(explain(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  触发重连
                </Button>
              </div>

              {connectionState?.lastInbound && (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--feishu-text-secondary)",
                    padding: "8px 12px",
                  }}
                >
                  最近消息收信:{" "}
                  {new Date(
                    connectionState.lastInbound.at,
                  ).toLocaleTimeString()}{" "}
                  · 状态: {connectionState.lastInbound.status}
                </div>
              )}
            </div>
          </TabPane>
        </Tabs>
      </Card>
    </div>
  );
}
