import { BotPermissions } from "./PermissionReadiness.js";
import React, { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
} from "@douyinfe/semi-ui";
import {
  IconSearch,
  IconCheckCircleStroked,
  IconAlertCircle,
  IconUser,
  IconComment,
} from "@douyinfe/semi-icons";
import { api, explain } from "./api.js";
import type { Config } from "../config.js";

export function ConnectionPanel({
  config,
  changed,
}: {
  config: Config;
  changed: () => Promise<void>;
}) {
  const [state, setState] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [peopleSearch, setPeopleSearch] = useState("");
  const [people, setPeople] = useState<
    { botId: string; userId: string; name?: string }[]
  >([]);

  const peopleKey = JSON.stringify(
    config.bindings.map((b) => [b.botId, b.allowedUsers]),
  );

  useEffect(() => {
    let alive = true;
    void api("/api/access/users")
      .then((result) => {
        if (alive) setPeople(result.users);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [peopleKey]);

  function revoke(bindingId: string, userId: string, name: string) {
    Modal.confirm({
      title: `停用 ${name} 在此会话的访问权限？`,
      content:
        "立即从本控制台的授权名单移除，保留任务历史和其他人的权限。不会更改飞书全员可用范围，也不影响机器人向该联系人发送消息。",
      okButtonProps: { type: "danger" },
      onOk: async () => {
        setBusy(true);
        setError("");
        try {
          const current = await api("/api/config");
          await api("/api/conversations/revoke", {
            bindingId,
            userId,
            revision: current.revision,
          });
          await changed();
          await refresh();
          setNotice(`已成功停用 ${name} 的会话使用权限。`);
        } catch (e) {
          setError(explain(e));
          throw e;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function refresh() {
    setState(await api("/api/connection"));
  }

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const next = await api("/api/connection");
        if (alive) setState(next);
      } catch (e) {
        if (alive) setError(explain(e));
      }
    };
    void poll();
    const timer = setInterval(() => {
      if (!document.hidden) void poll();
    }, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  async function connect() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/connection/connect", {});
      await changed();
      await refresh();
      setNotice("已触发长连接上线，请在飞书发送消息验证。");
    } catch (e) {
      setError(explain(e));
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  function authorize(c: any) {
    Modal.confirm({
      title: "批准此人在该会话使用机器人？",
      content:
        "允许机器人回复该会话。新会话默认只读工作目录，不开放给群内其他人。已有会话保留原来的目录和文件权限。确认后请在飞书重新发送消息，之前的消息不会自动重复执行。",
      onOk: async () => {
        setBusy(true);
        setError("");
        try {
          const current = await api("/api/config");
          await api("/api/conversations/authorize", {
            id: c.id,
            revision: current.revision,
          });
          await changed();
          await refresh();
          setNotice("授权已生效，请在飞书发送任务体验。");
        } catch (e) {
          setError(explain(e));
          throw e;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  // 整理授权使用人员列表
  const authorizedUsers = useMemo(() => {
    return config.bindings.flatMap((b) =>
      b.allowedUsers.map((userId) => {
        const name =
          people.find((p) => p.botId === b.botId && p.userId === userId)
            ?.name || userId;
        const botName =
          config.bots.find((bot) => bot.id === b.botId)?.name || b.botId;
        const projectName =
          config.projects.find((p) => p.id === b.projectId)?.name ||
          b.projectId;
        return {
          bindingId: b.id,
          userId,
          name,
          botId: b.botId,
          botName,
          projectId: b.projectId,
          projectName,
          chatId: b.chatId,
          threadId: b.threadId,
        };
      }),
    );
  }, [config.bindings, config.bots, config.projects, people]);

  const filteredUsers = useMemo(() => {
    if (!peopleSearch.trim()) return authorizedUsers;
    const q = peopleSearch.toLowerCase();
    return authorizedUsers.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.userId.toLowerCase().includes(q) ||
        u.botName.toLowerCase().includes(q) ||
        u.projectName.toLowerCase().includes(q),
    );
  }, [authorizedUsers, peopleSearch]);

  const totalBots = config.bots.length;
  const connectedBots = config.bots.filter((b) => {
    const ch = state?.channels?.find((c: any) => c.botId === b.id);
    return state?.mode === "lark" && ch?.connection === "connected";
  }).length;

  return (
    <Card
      className="feishu-card"
      headerLine={false}
      title={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 17, fontWeight: 600 }}>
            飞书长连接与协作授权
          </span>
          <Badge dot type={state?.mode === "lark" ? "success" : "warning"} />
          <span style={{ fontSize: 13, color: "var(--feishu-text-secondary)" }}>
            {state?.mode === "lark"
              ? `在线服务中 (${connectedBots}/${totalBots} 机器人通道已连接)`
              : "本地离线模式"}
          </span>
        </div>
      }
      headerExtraContent={
        <Button
          theme="solid"
          type="primary"
          loading={busy || state?.busy}
          disabled={!config.bots.length}
          onClick={() => void connect()}
        >
          应用设置并上线
        </Button>
      }
    >
      <Space vertical align="start" style={{ width: "100%" }} spacing="loose">
        {error && (
          <Banner type="danger" description={error} style={{ width: "100%" }} />
        )}
        {notice && (
          <Banner
            type="success"
            closeIcon
            description={notice}
            style={{ width: "100%" }}
            onClose={() => setNotice("")}
          />
        )}

        {/* 1. 机器人长连接通道状态网格 */}
        <div style={{ width: "100%" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            机器人连接通道
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 12,
              width: "100%",
            }}
          >
            {config.bots.map((bot) => {
              const channel = state?.channels?.find(
                (c: any) => c.botId === bot.id,
              );
              const online =
                state?.mode === "lark" && channel?.connection === "connected";
              const bound = config.bindings.some(
                (b) =>
                  b.botId === bot.id && b.allowSend && b.allowedUsers.length,
              );
              return (
                <div
                  key={bot.id}
                  style={{
                    padding: "12px 14px",
                    borderRadius: "var(--feishu-radius-card)",
                    background: online ? "#f8fafc" : "#fafafa",
                    border: online
                      ? "1px solid #b3ccff"
                      : "1px solid var(--feishu-border-light)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 14 }}>
                      {bot.name || bot.id}
                    </span>
                    <Tag
                      color={
                        online && bound
                          ? "green"
                          : online
                            ? "blue"
                            : channel?.connection === "failed"
                              ? "red"
                              : "orange"
                      }
                      type="light"
                      size="small"
                    >
                      {channel?.connection === "failed"
                        ? "连接失败"
                        : !online
                          ? "未连接"
                          : bound
                            ? "在线 · 可聊天"
                            : "在线 · 待授权"}
                    </Tag>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--feishu-text-tertiary)",
                    }}
                  >
                    {channel?.lastRawAt
                      ? `最近原生事件：${new Date(channel.lastRawAt).toLocaleTimeString()}`
                      : "等待飞书消息心跳..."}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 2. 待授权候选人通知流 (Action Required) */}
        {state?.candidates && state.candidates.length > 0 && (
          <div style={{ width: "100%" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: "#d83b01" }}>
                待处理会话授权申请 ({state.candidates.length})
              </span>
              <Tag color="orange" type="solid" size="small">
                待审批
              </Tag>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                width: "100%",
              }}
            >
              {state.candidates.map((c: any) => (
                <div
                  key={c.id}
                  style={{
                    padding: "14px 16px",
                    borderRadius: "var(--feishu-radius-card)",
                    border: "1px solid #ffcca5",
                    background: "#fff9f5",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <IconComment style={{ color: "#d83b01" }} />
                      <span
                        style={{
                          fontWeight: 600,
                          color: "#9e3800",
                          fontSize: 14,
                        }}
                      >
                        {config.bots.find((b) => b.id === c.botId)?.name ||
                          "机器人"}
                      </span>
                      <Tag size="small" color="orange" type="light">
                        {c.chatType === "p2p" ? "私聊会话" : "群聊会话"}
                      </Tag>
                    </div>
                    <Button
                      theme="solid"
                      type="warning"
                      size="small"
                      loading={busy}
                      onClick={() => authorize(c)}
                    >
                      批准此人在此会话使用
                    </Button>
                  </div>

                  <div
                    style={{
                      background: "#ffffff",
                      padding: "8px 12px",
                      borderRadius: 6,
                      fontSize: 13,
                      color: "var(--feishu-text-primary)",
                      border: "1px solid #ffe0cc",
                      lineHeight: 1.5,
                    }}
                  >
                    “{c.preview}”
                  </div>

                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--feishu-text-secondary)",
                      display: "flex",
                      gap: 16,
                      flexWrap: "wrap",
                    }}
                  >
                    <span>
                      发送人 ID：<code>{c.senderId}</code>
                    </span>
                    <span>
                      会话 ID：
                      <code>
                        {c.chatId}
                        {c.threadId ? ` / ${c.threadId}` : ""}
                      </code>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 3. 已授权使用人员面板 */}
        <Card
          headerLine={false}
          style={{
            width: "100%",
            borderRadius: "var(--feishu-radius-card)",
            background: "#ffffff",
            border: "1px solid var(--feishu-border-light)",
          }}
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <IconUser style={{ color: "var(--feishu-primary)" }} />
              <span style={{ fontSize: 15, fontWeight: 600 }}>
                已授权使用人员
              </span>
              <Tag color="blue" size="small" type="light">
                {authorizedUsers.length} 人
              </Tag>
            </div>
          }
          headerExtraContent={
            <Input
              prefix={<IconSearch />}
              placeholder="搜索人员、机器人或工作区"
              value={peopleSearch}
              onChange={setPeopleSearch}
              size="small"
              showClear
              style={{ width: 220 }}
            />
          }
        >
          <Space
            vertical
            align="start"
            style={{ width: "100%" }}
            spacing="medium"
          >
            <Typography.Paragraph
              type="secondary"
              style={{ fontSize: 12, margin: 0 }}
            >
              飞书应用的全员可用仅支持用户查找到该机器人；只有在下方列表中的人员才能向机器人派发任务。新增人员请先私聊机器人发送消息，再在上方确认批准。
            </Typography.Paragraph>

            {!authorizedUsers.length ? (
              <Empty
                title="暂无授权使用人员"
                description="请在飞书客户端私聊机器人发送任意测试消息，然后在此面板批准即可。"
              />
            ) : !filteredUsers.length ? (
              <Empty title="未找到匹配的使用人员" />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                  gap: 12,
                  width: "100%",
                }}
              >
                {filteredUsers.map((u) => (
                  <div
                    key={`${u.bindingId}:${u.userId}`}
                    style={{
                      padding: "12px 14px",
                      borderRadius: "var(--feishu-radius-card)",
                      border: "1px solid var(--feishu-border-light)",
                      background: "#fafbfc",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      transition: "box-shadow 0.2s ease",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 16,
                            background:
                              "linear-gradient(135deg, #3370ff 0%, #2055d5 100%)",
                            color: "#ffffff",
                            display: "grid",
                            placeItems: "center",
                            fontWeight: 600,
                            fontSize: 14,
                          }}
                        >
                          {u.name.slice(0, 1).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>
                            {u.name}
                          </div>
                          <Typography.Text type="tertiary" size="small">
                            {u.userId.slice(0, 16)}...
                          </Typography.Text>
                        </div>
                      </div>
                      <Button
                        theme="borderless"
                        type="danger"
                        size="small"
                        disabled={busy || state?.busy}
                        onClick={() => revoke(u.bindingId, u.userId, u.name)}
                      >
                        停用权限
                      </Button>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 6,
                        fontSize: 12,
                      }}
                    >
                      <Tag color="blue" size="small" type="light">
                        机器人：{u.botName}
                      </Tag>
                      <Tag color="green" size="small" type="light">
                        工作区：{u.projectName}
                      </Tag>
                    </div>

                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--feishu-text-tertiary)",
                      }}
                    >
                      会话 ID：{u.chatId}
                      {u.threadId ? ` / ${u.threadId}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Space>
        </Card>

        {/* 4. 机器人的接口权限与组织通讯录范围检查 */}
        {config.bots.map((bot) => (
          <BotPermissions key={bot.id} bot={bot} />
        ))}

        {/* 5. 常见长连接事件排查引导 */}
        {state?.mode === "lark" && !state.lastInbound && (
          <Banner
            type="info"
            style={{ width: "100%" }}
            description={
              <Space vertical align="start">
                <span>
                  长连接已建立，尚未收到消息。若已在飞书发消息但界面无变化，请检查应用的消息事件订阅（im.message.receive_v1）与长连接配置。
                </span>
                {config.bots.map((bot) => (
                  <a
                    key={bot.id}
                    href={`${bot.tenant === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn"}/app/${bot.appId}/event`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      color: "var(--feishu-primary)",
                      textDecoration: "none",
                      fontWeight: 500,
                    }}
                  >
                    {bot.name || bot.id}：打开开放平台事件订阅设置 ↗
                  </a>
                ))}
              </Space>
            }
          />
        )}

        {state?.lastInbound && (
          <Typography.Text type="tertiary" size="small">
            最近收信时间：{new Date(state.lastInbound.at).toLocaleTimeString()}{" "}
            ·{" "}
            {(
              {
                accepted: "已进入 Agent 任务",
                unbound_target: "等待会话授权",
                user_not_authorized: "发送人尚未授权",
                not_directed: "群消息未 @机器人",
                duplicate: "重复消息已忽略",
                untrusted_tenant: "企业身份不匹配",
              } as Record<string, string>
            )[state.lastInbound.status] || state.lastInbound.status}
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
}
