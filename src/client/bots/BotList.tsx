import React, { useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Input,
  Space,
  Tag,
  Typography,
} from "@douyinfe/semi-ui";
import {
  IconSearch,
  IconPlus,
  IconChevronRight,
  IconAlertCircle,
} from "@douyinfe/semi-icons";
import type { Config } from "../../config.js";

export function RobotIcon({ size = 20 }: { size?: number }) {
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

export function agentLabel(cfg: Config, id: string) {
  const agent = cfg.agents.find((a) => a.id === id);
  return agent?.runtime === "codex"
    ? "ChatGPT (Codex)"
    : agent?.runtime === "grok"
      ? "Grok Build"
      : agent?.runtime === "pi"
        ? "Pi Agent"
        : id;
}

export function workspaceName(project?: Config["projects"][number]) {
  if (!project) return "未指定工作区";
  return project.name ? `${project.name} (${project.id})` : project.id;
}

interface BotListProps {
  config: Config;
  connectionState: any;
  onSelectBot: (botId: string, initialTab?: string) => void;
  onAddBot: () => void;
}

export function BotList({
  config,
  connectionState,
  onSelectBot,
  onAddBot,
}: BotListProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const candidates = connectionState?.candidates || [];
  const channels = connectionState?.channels || [];
  const mode = connectionState?.mode;

  // 全局待审批汇总与提示
  const pendingSummary = useMemo(() => {
    if (!candidates.length) return null;
    const botCounts = new Map<string, number>();
    for (const c of candidates) {
      botCounts.set(c.botId, (botCounts.get(c.botId) || 0) + 1);
    }
    return {
      total: candidates.length,
      botCounts,
    };
  }, [candidates]);

  // 机器人过滤
  const filteredBots = useMemo(() => {
    if (!searchQuery.trim()) return config.bots;
    const q = searchQuery.toLowerCase().trim();
    return config.bots.filter((bot) => {
      const name = (bot.name || "").toLowerCase();
      const id = bot.id.toLowerCase();
      const appId = (bot.appId || "").toLowerCase();
      const agent = agentLabel(config, bot.agentId).toLowerCase();
      const project = (bot.projectId || "").toLowerCase();
      return (
        name.includes(q) ||
        id.includes(q) ||
        appId.includes(q) ||
        agent.includes(q) ||
        project.includes(q)
      );
    });
  }, [config, searchQuery]);

  return (
    <div style={{ width: "100%" }}>
      {/* 1. 待处理申请轻量提醒条 (不喧宾夺主) */}
      {pendingSummary && pendingSummary.total > 0 && (
        <Banner
          type="warning"
          style={{
            marginBottom: 16,
            borderRadius: "var(--feishu-radius-card)",
            boxShadow: "0 2px 8px rgba(216, 59, 1, 0.08)",
          }}
          icon={<IconAlertCircle />}
          description={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <span>
                收到 <strong>{pendingSummary.total}</strong>{" "}
                位人员申请使用机器人，点击对应机器人卡片即可快速批准。
              </span>
              <Space>
                {Array.from(pendingSummary.botCounts.entries()).map(
                  ([bId, count]) => {
                    const b = config.bots.find((item) => item.id === bId);
                    return (
                      <Button
                        key={bId}
                        size="small"
                        theme="light"
                        type="warning"
                        onClick={() => onSelectBot(bId, "conversations")}
                      >
                        处理 {b?.name || bId} 的申请 ({count})
                      </Button>
                    );
                  },
                )}
              </Space>
            </div>
          }
        />
      )}

      {/* 2. 顶部工具栏：搜索、统计与添加主按钮 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Input
            prefix={<IconSearch />}
            showClear
            placeholder="搜索机器人名称、ID 或工作区..."
            value={searchQuery}
            onChange={(val) => setSearchQuery(val)}
            style={{ width: 280 }}
          />
          <Typography.Text type="tertiary" size="small">
            共 {config.bots.length} 个机器人
            {mode === "lark" &&
              ` · ${channels.filter((c: any) => c.connection === "connected").length} 个在线连接`}
          </Typography.Text>
        </div>

        <Button
          theme="solid"
          type="primary"
          icon={<IconPlus />}
          onClick={onAddBot}
        >
          添加机器人
        </Button>
      </div>

      {/* 3. 机器人卡片网格 */}
      {filteredBots.length === 0 ? (
        <Card
          className="feishu-card"
          style={{ textAlign: "center", padding: "48px 20px" }}
        >
          <Empty
            title={searchQuery ? "未找到匹配的机器人" : "还没有配置飞书机器人"}
            description={
              searchQuery
                ? "请尝试更换关键词搜索"
                : "扫码创建飞书机器人，或接入已有的飞书开放平台应用。"
            }
          />
          {!searchQuery && (
            <Button
              theme="solid"
              type="primary"
              icon={<IconPlus />}
              style={{ marginTop: 20 }}
              onClick={onAddBot}
            >
              立即添加机器人
            </Button>
          )}
        </Card>
      ) : (
        <div className="robots-grid">
          {filteredBots.map((bot) => {
            const ch = channels.find((c: any) => c.botId === bot.id);
            const isOnline = mode === "lark" && ch?.connection === "connected";
            const isFailed = ch?.connection === "failed";
            const botCandidates = candidates.filter(
              (c: any) => c.botId === bot.id,
            );
            const botBindings = config.bindings.filter(
              (b) => b.botId === bot.id,
            );
            const totalUsers = bot.allowedUsers?.length ?? 0;
            const project = config.projects.find((p) => p.id === bot.projectId);

            return (
              <div
                key={bot.id}
                className="robot-card"
                onClick={() => onSelectBot(bot.id)}
                style={{
                  cursor: "pointer",
                  position: "relative",
                }}
              >
                {/* 待审批 Badge 悬浮角标 */}
                {botCandidates.length > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      top: -6,
                      right: -6,
                      zIndex: 2,
                    }}
                  >
                    <Badge
                      count={`${botCandidates.length} 待审批`}
                      type="warning"
                    />
                  </div>
                )}

                {/* 卡片头部：头像、名称、在线状态与租户 */}
                <div className="robot-card-head">
                  <div className="robot-card-title">
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 10,
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
                      <RobotIcon size={20} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 15,
                          color: "var(--feishu-text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {bot.name || bot.id}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--feishu-text-tertiary)",
                          marginTop: 2,
                        }}
                      >
                        {bot.appId ? `ID: ${bot.appId}` : bot.id}
                      </div>
                    </div>
                  </div>

                  <Space spacing="tight">
                    <Tag
                      color={
                        isOnline
                          ? "green"
                          : isFailed
                            ? "red"
                            : mode === "offline"
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
                          : mode === "offline"
                            ? "本地离线"
                            : "未连接"}
                    </Tag>
                  </Space>
                </div>

                {/* 卡片核心指标展示 */}
                <div className="robot-meta-row" style={{ marginTop: 14 }}>
                  <div className="robot-meta-item">
                    <span className="robot-meta-label">运行时：</span>
                    <Tag color="blue" type="light" size="small">
                      {agentLabel(config, bot.agentId)}
                    </Tag>
                  </div>
                  <div className="robot-meta-item">
                    <span className="robot-meta-label">模型：</span>
                    <span
                      style={{
                        color: "var(--feishu-text-secondary)",
                        fontSize: 13,
                      }}
                    >
                      {bot.model ||
                        config.agents.find((a) => a.id === bot.agentId)
                          ?.model ||
                        "默认"}
                    </span>
                  </div>
                  <div className="robot-meta-item">
                    <span className="robot-meta-label">工作区：</span>
                    <span
                      style={{
                        color: "var(--feishu-text-secondary)",
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {workspaceName(project)}
                    </span>
                  </div>
                  <div className="robot-meta-item">
                    <span className="robot-meta-label">协同授权：</span>
                    <span
                      style={{
                        color:
                          totalUsers > 0
                            ? "var(--semi-color-success)"
                            : "var(--feishu-text-tertiary)",
                        fontSize: 13,
                      }}
                    >
                      {bot.allowAllUsers
                        ? "允许所有人"
                        : totalUsers > 0
                          ? `已授权 ${totalUsers} 人`
                          : "待授权使用"}
                    </span>
                  </div>
                </div>

                {/* 卡片底部操作栏 */}
                <div
                  style={{
                    marginTop: 14,
                    paddingTop: 10,
                    borderTop: "1px solid var(--feishu-border-light)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <Tag size="small" type="ghost">
                    {bot.tenant === "lark" ? "Lark 国际版" : "飞书国内版"}
                  </Tag>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      color: "var(--feishu-primary)",
                      fontSize: 13,
                      fontWeight: 500,
                    }}
                  >
                    <span>进入管理与配置</span>
                    <IconChevronRight size="small" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
