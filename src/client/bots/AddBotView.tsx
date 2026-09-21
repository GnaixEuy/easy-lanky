import React, { useState } from "react";
import {
  Breadcrumb,
  Button,
  Card,
  Col,
  Input,
  Radio,
  RadioGroup,
  Row,
  Select,
  Space,
  Typography,
} from "@douyinfe/semi-ui";
import { IconArrowLeft } from "@douyinfe/semi-icons";
import { RobotModelSelect } from "../ModelSettings.js";
import type { Config } from "../../config.js";
import { RegistrationPanel } from "../RegistrationPanel.js";
import { agentLabel, workspaceName } from "./BotList.js";

interface AddBotViewProps {
  config: Config;
  revision: string;
  onBack: () => void;
  onSaved: (newBotId: string) => void;
  onSaveManual: (draft: {
    id: string;
    name: string;
    agentId: string;
    model: string | null;
    projectId: string;
    tenant: "feishu" | "lark";
    appId: string;
    secret: string;
  }) => Promise<boolean>;
}

export function AddBotView({
  config,
  revision,
  onBack,
  onSaved,
  onSaveManual,
}: AddBotViewProps) {
  const [mode, setMode] = useState<"scan" | "manual">("scan");
  const [scanLocked, setScanLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [botId] = useState(() => `bot-${crypto.randomUUID()}`);
  const [name, setName] = useState("");
  const [tenant, setTenant] = useState<"feishu" | "lark">("feishu");
  const [projectId, setProjectId] = useState(config.projects[0]?.id || "");
  const [agentId, setAgentId] = useState(config.agents[0]?.id || "");
  const [model, setModel] = useState("");
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");

  async function handleManualSubmit() {
    if (!name.trim() || !appId.trim() || !secret.trim()) return;
    setBusy(true);
    setError("");
    try {
      const saved = await onSaveManual({
        id: botId,
        name: name.trim(),
        agentId,
        model: model.trim() ? model.trim() : null,
        projectId,
        tenant,
        appId: appId.trim(),
        secret: secret.trim(),
      });
      if (saved) onSaved(botId);
    } catch (e: any) {
      setError(e?.message || "保存机器人失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ width: "100%" }}>
      {/* 顶部导航与面包屑 */}
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
          <Breadcrumb.Item>添加机器人</Breadcrumb.Item>
        </Breadcrumb>

        <Button
          theme="borderless"
          icon={<IconArrowLeft />}
          onClick={onBack}
          size="small"
        >
          返回列表
        </Button>
      </div>

      <Card
        className="feishu-card"
        headerLine={false}
        title={
          <span style={{ fontSize: 16, fontWeight: 600 }}>添加机器人</span>
        }
      >
        <div style={{ marginBottom: 20 }}>
          <RadioGroup
            type="button"
            value={mode}
            disabled={scanLocked || busy}
            onChange={(e) => setMode(e.target.value)}
          >
            <Radio value="scan">扫码创建（推荐）</Radio>
            <Radio value="manual">接入已有应用</Radio>
          </RadioGroup>
        </div>

        <div style={{ maxWidth: 760 }}>
          <Row gutter={24}>
            <Col xs={24} md={12} style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}>
                机器人名称 <span style={{ color: "#f93920" }}>*</span>
              </div>
              <Input
                value={name}
                maxLength={80}
                placeholder="例如：叶翔"
                disabled={busy || scanLocked}
                onChange={(val) => setName(val)}
              />
            </Col>

            <Col xs={24} md={12} style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}>
                平台与租户类型 <span style={{ color: "#f93920" }}>*</span>
              </div>
              <RadioGroup
                type="button"
                value={tenant}
                disabled={busy || scanLocked}
                onChange={(e) => setTenant(e.target.value)}
              >
                <Radio value="feishu">飞书国内版 (feishu.cn)</Radio>
                <Radio value="lark">Lark 国际版 (larksuite.com)</Radio>
              </RadioGroup>
            </Col>

            <Col xs={24} md={12} style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}>
                关联工作区 <span style={{ color: "#f93920" }}>*</span>
              </div>
              <Select
                style={{ width: "100%" }}
                value={projectId}
                disabled={busy || scanLocked}
                onChange={(val) => setProjectId(val as string)}
                optionList={config.projects.map((p) => ({
                  value: p.id,
                  label: `${p.name || p.id} (${p.root})`,
                }))}
              />
            </Col>

            <Col xs={24} md={12} style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}>
                AI 运行时 (Agent) <span style={{ color: "#f93920" }}>*</span>
              </div>
              <Select
                style={{ width: "100%" }}
                value={agentId}
                disabled={busy || scanLocked}
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
                disabled={busy || scanLocked}
                onChange={(val) => setModel(val || "")}
              />
            </Col>

            {mode === "manual" && (
              <>
                <Col xs={24} md={12} style={{ marginBottom: 16 }}>
                  <div
                    style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}
                  >
                    App ID <span style={{ color: "#f93920" }}>*</span>
                  </div>
                  <Input
                    value={appId}
                    placeholder="cli_..."
                    disabled={busy || scanLocked}
                    onChange={(val) => setAppId(val)}
                  />
                </Col>

                <Col xs={24} style={{ marginBottom: 20 }}>
                  <div
                    style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}
                  >
                    App Secret <span style={{ color: "#f93920" }}>*</span>
                  </div>
                  <Input
                    mode="password"
                    autoComplete="new-password"
                    value={secret}
                    placeholder="粘贴应用密钥"
                    disabled={busy || scanLocked}
                    onChange={(val) => setSecret(val)}
                  />
                  <Typography.Text
                    type="tertiary"
                    size="small"
                    style={{ display: "block", marginTop: 4 }}
                  >
                    密钥仅保存在本机，用于长连接建连和飞书鉴权。
                  </Typography.Text>
                </Col>
              </>
            )}
          </Row>

          {mode === "scan" ? (
            <RegistrationPanel
              input={{
                id: botId,
                name: name || "飞书机器人",
                agentId,
                model: model || null,
                projectId,
                tenant,
                revision,
              }}
              onLock={setScanLocked}
              onSaved={(result) => {
                onSaved(botId);
              }}
            />
          ) : (
            <>
              {error && (
                <div style={{ color: "#f93920", marginBottom: 12 }}>
                  {error}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 12,
                }}
              >
                <Button
                  theme="solid"
                  type="primary"
                  loading={busy}
                  disabled={!name.trim() || !appId.trim() || !secret.trim()}
                  onClick={handleManualSubmit}
                >
                  连接并保存
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
