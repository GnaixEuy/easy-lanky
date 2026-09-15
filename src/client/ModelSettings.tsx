import React, { useEffect, useState } from "react";
import { Select, Typography } from "@douyinfe/semi-ui";
import type { Config } from "../config.js";
import type { ModelCatalogResult } from "../local-options.js";
import { api } from "./api.js";

export function RobotModelSelect({
  agent,
  value,
  disabled,
  onChange,
}: {
  agent?: Config["agents"][number];
  value: string | null;
  disabled: boolean;
  onChange: (model: string | null) => void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalogResult>();
  useEffect(() => {
    let alive = true;
    setCatalog(undefined);
    if (agent)
      void api<ModelCatalogResult>("/api/models", { agentId: agent.id })
        .catch(() => ({ models: [], source: "unavailable" as const }))
        .then((result) => {
          if (alive) setCatalog(result);
        });
    return () => {
      alive = false;
    };
  }, [agent?.id, agent?.runtime, agent?.executable]);

  const models = [...(catalog?.models ?? [])];
  if (value && !models.some((m) => m.value === value))
    models.unshift({ value, label: value });
  const invalid =
    !!value && !/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,199}$/.test(value);

  const options = [
    {
      value: "",
      label: agent?.model
        ? `使用 Agent 默认（${agent.model}）`
        : "跟随 CLI 默认",
    },
    ...models.map((m) => ({ value: m.value, label: m.label || m.value })),
  ];

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}>
        机器人模型
      </div>
      <Select
        aria-label="机器人模型"
        value={value ?? ""}
        filter
        allowCreate
        style={{ width: "100%" }}
        disabled={disabled || !agent}
        loading={!!agent && !catalog}
        placeholder="选择或输入模型 ID"
        optionList={options}
        onChange={(next) =>
          onChange(typeof next === "string" ? next.trim() || null : null)
        }
      />
      {invalid && (
        <div style={{ color: "#f93920", fontSize: 12, marginTop: 4 }}>
          请输入有效的模型 ID。
        </div>
      )}
      <Typography.Text
        type="tertiary"
        size="small"
        style={{ display: "block", marginTop: 4, lineHeight: 1.4 }}
      >
        仅对这个机器人生效。
        {catalog?.source === "unavailable"
          ? "未读取到模型列表，可手动输入模型 ID。"
          : "可搜索选择或输入模型 ID，实际可用性取决于账号。"}
      </Typography.Text>
    </div>
  );
}
