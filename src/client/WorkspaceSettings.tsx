import React, { useEffect, useRef, useState } from "react";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "@douyinfe/semi-ui";
import { IconFolder, IconPlus, IconSearch } from "@douyinfe/semi-icons";
import type { Config } from "../config.js";
import { api, explain } from "./api.js";

type Project = Config["projects"][number];

export function workspaceName(p?: Project) {
  return (
    p?.name ||
    p?.root.split(/[\\/]/).filter(Boolean).at(-1) ||
    p?.id ||
    "未选择工作区"
  );
}

export function WorkspaceSelect({
  projects,
  value,
  onChange,
  label = "工作区",
  disabled,
}: {
  projects: Project[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const options = projects.map((p) => ({
    value: p.id,
    label: (
      <div
        style={{ display: "flex", flexDirection: "column", padding: "2px 0" }}
      >
        <span style={{ fontWeight: 500 }}>{workspaceName(p)}</span>
        <span style={{ fontSize: 12, color: "var(--feishu-text-tertiary)" }}>
          {p.root}
        </span>
      </div>
    ),
  }));

  return (
    <Select
      aria-label={label}
      value={value || undefined}
      onChange={(val) => onChange(typeof val === "string" ? val : "")}
      disabled={disabled}
      filter
      style={{ width: "100%" }}
      placeholder="搜索工作区名称或路径"
      emptyContent="没有匹配的工作区，请到工作区页面添加"
      optionList={options}
      renderSelectedItem={(option: any) =>
        workspaceName(projects.find((p) => p.id === option?.value))
      }
    />
  );
}

type Directory = {
  path: string;
  parent: string;
  home: string;
  entries: { name: string; path: string }[];
  truncated: boolean;
};

export function FolderBrowser({
  initial,
  onSelect,
  onClose,
}: {
  initial: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<Directory | null>(null);
  const [location, setLocation] = useState(initial);
  const [hidden, setHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  async function browse(root: string, showHidden = hidden) {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setData(null);
    try {
      const result = await api<Directory>("/api/directories", {
        path: root,
        hidden: showHidden,
      });
      if (request !== generation.current) return;
      setData(result);
      setLocation(result.path);
      setQuery("");
    } catch (e) {
      if (request === generation.current) setError(explain(e));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }

  useEffect(() => {
    void browse(initial);
    return () => {
      generation.current++;
    };
  }, []);

  return (
    <Modal
      title="选择本机文件夹"
      visible
      onCancel={onClose}
      style={{ width: 640, maxWidth: "calc(100vw - 32px)" }}
      okText="选择当前文件夹"
      onOk={() => {
        if (data) onSelect(data.path);
      }}
      okButtonProps={{ disabled: busy || !data }}
    >
      <Space vertical align="start" style={{ width: "100%" }} spacing="medium">
        <Input
          aria-label="浏览路径"
          value={location}
          onChange={setLocation}
          onEnterPress={() => void browse(location)}
          placeholder="输入路径，支持 ~/"
          suffix={
            <Button
              theme="borderless"
              icon={<IconSearch />}
              loading={busy}
              onClick={() => void browse(location)}
            >
              前往
            </Button>
          }
        />
        <Space wrap>
          <Button onClick={() => void browse("")} disabled={busy} size="small">
            个人目录
          </Button>
          <Button
            onClick={() => data && void browse(data.parent)}
            disabled={busy || !data || data.parent === data.path}
            size="small"
          >
            上一级
          </Button>
          <Checkbox
            checked={hidden}
            disabled={busy}
            onChange={(e) => {
              const v = !!e.target.checked;
              setHidden(v);
              void browse(data?.path || location, v);
            }}
          >
            显示隐藏目录
          </Checkbox>
        </Space>
        {error && (
          <Banner type="danger" description={error} style={{ width: "100%" }} />
        )}
        <Input
          prefix={<IconSearch />}
          aria-label="筛选文件夹"
          placeholder="筛选当前目录下的文件夹"
          value={query}
          onChange={setQuery}
          showClear
        />
        <Spin spinning={busy} style={{ width: "100%" }}>
          <div
            style={{
              maxHeight: 260,
              overflow: "auto",
              minHeight: 120,
              border: "1px solid var(--feishu-border-light)",
              borderRadius: 6,
              padding: "4px 8px",
            }}
          >
            <List
              size="small"
              dataSource={(data?.entries || []).filter((e) =>
                e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
              )}
              emptyContent={
                <Empty
                  title={
                    busy
                      ? "正在读取文件夹"
                      : "没有子文件夹，可直接选择当前文件夹"
                  }
                />
              }
              renderItem={(entry) => (
                <List.Item
                  key={entry.path}
                  style={{ padding: "6px 4px", cursor: "pointer" }}
                  onClick={() => void browse(entry.path)}
                >
                  <Space align="center">
                    <IconFolder style={{ color: "var(--feishu-primary)" }} />
                    <span style={{ fontSize: 13 }}>{entry.name}</span>
                  </Space>
                </List.Item>
              )}
            />
          </div>
        </Spin>
        {data?.truncated && (
          <Banner
            type="info"
            description="目录较多，仅显示前 500 项；可在上方输入完整路径前往。"
          />
        )}
        {data && (
          <Typography.Text type="tertiary" size="small">
            将选择：{data.path}
          </Typography.Text>
        )}
      </Space>
    </Modal>
  );
}

export function WorkspaceSettings({
  config,
  busy,
  onSave,
}: {
  config: Config;
  busy: boolean;
  onSave: (cfg: Config) => Promise<boolean>;
}) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Project | null>(null);
  const [browser, setBrowser] = useState(false);
  const [formError, setFormError] = useState("");

  const edit = (p?: Project) => {
    setFormError("");
    setDraft(
      p
        ? { ...p }
        : {
            id: `project-${crypto.randomUUID().slice(0, 8)}`,
            name: "",
            root: "",
          },
    );
  };

  const references = (id: string) => {
    const bots = config.bots.filter(
      (b) =>
        b.projectId === id ||
        config.bindings.some((s) => s.botId === b.id && s.projectId === id),
    );
    return bots.map((b) => b.name || b.id);
  };

  function remove(p: Project) {
    Modal.confirm({
      title: `删除工作区“${workspaceName(p)}”？`,
      content: "只移除工作区配置，磁盘文件和历史任务记录会保留。",
      okText: "删除工作区",
      okButtonProps: { type: "danger" },
      onOk: async () => {
        if (
          !(await onSave({
            ...config,
            projects: config.projects.filter((x) => x.id !== p.id),
          }))
        )
          throw new Error("save_failed");
      },
    });
  }

  async function saveDraft() {
    if (!draft) return;
    if (!draft.name?.trim() || !draft.root.trim()) {
      setFormError("请填写工作区名称，并选择或输入目录路径。");
      return;
    }
    const projects = config.projects.some((p) => p.id === draft.id)
      ? config.projects.map((p) => (p.id === draft.id ? draft : p))
      : [...config.projects, draft];
    if (await onSave({ ...config, projects })) setDraft(null);
    else
      setFormError(
        "保存未完成。请检查路径及页面上的错误提示；已填内容已保留。",
      );
  }

  return (
    <Space vertical align="start" style={{ width: "100%" }} spacing="loose">
      <div style={{ display: "flex", gap: 12, width: "100%", maxWidth: 640 }}>
        <Input
          prefix={<IconSearch />}
          aria-label="搜索工作区"
          placeholder="搜索工作区名称或路径"
          value={search}
          onChange={setSearch}
          showClear
          style={{ flex: 1 }}
        />
        <Button
          theme="solid"
          type="primary"
          icon={<IconPlus />}
          disabled={busy}
          onClick={() => edit()}
        >
          添加工作区
        </Button>
      </div>

      {!config.projects.length && (
        <Empty title="还没有工作区，添加一个本机文件夹开始使用" />
      )}

      {!!config.projects.length &&
        !config.projects.some((p) =>
          `${workspaceName(p)} ${p.root}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        ) && <Empty title="没有匹配的工作区" />}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          gap: 16,
          width: "100%",
        }}
      >
        {config.projects
          .filter((p) =>
            `${workspaceName(p)} ${p.root}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((p) => {
            const used = references(p.id);
            const bound =
              used.length > 0 ||
              config.bindings.some((b) => b.projectId === p.id);
            return (
              <Card
                key={p.id}
                className="feishu-card"
                headerLine={false}
                title={
                  <Space align="center">
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
                      <IconFolder />
                    </div>
                    <span style={{ fontSize: 15, fontWeight: 600 }}>
                      {workspaceName(p)}
                    </span>
                  </Space>
                }
                headerExtraContent={
                  <Space>
                    <Button
                      theme="borderless"
                      disabled={busy}
                      onClick={() => edit({ ...p, name: workspaceName(p) })}
                    >
                      编辑
                    </Button>
                    <Button
                      theme="borderless"
                      type="danger"
                      disabled={busy || bound}
                      onClick={() => remove(p)}
                    >
                      删除
                    </Button>
                  </Space>
                }
              >
                <Space
                  vertical
                  align="start"
                  style={{ width: "100%" }}
                  spacing="medium"
                >
                  <Typography.Text
                    copyable
                    style={{
                      fontSize: 13,
                      color: "var(--feishu-text-secondary)",
                      wordBreak: "break-all",
                    }}
                  >
                    {p.root}
                  </Typography.Text>
                  <Space wrap>
                    {used.length ? (
                      used.map((name) => (
                        <Tag key={name} color="blue" type="light">
                          {name}
                        </Tag>
                      ))
                    ) : (
                      <Tag color="grey" type="light">
                        未被机器人使用
                      </Tag>
                    )}
                  </Space>
                  {bound && (
                    <Typography.Text type="tertiary" size="small">
                      删除前，请先在机器人设置中切换工作区并调整关联会话。
                    </Typography.Text>
                  )}
                </Space>
              </Card>
            );
          })}
      </div>

      {draft && (
        <Modal
          title={
            config.projects.some((p) => p.id === draft.id)
              ? "编辑工作区"
              : "添加工作区"
          }
          visible
          onCancel={() => {
            if (!busy) setDraft(null);
          }}
          footer={
            <Space>
              <Button disabled={busy} onClick={() => setDraft(null)}>
                取消
              </Button>
              <Button
                theme="solid"
                type="primary"
                loading={busy}
                onClick={() => void saveDraft()}
              >
                保存工作区
              </Button>
            </Space>
          }
          style={{ maxWidth: "calc(100vw - 32px)", width: 520 }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {formError && <Banner type="danger" description={formError} />}
            <div>
              <div style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}>
                工作区名称 <span style={{ color: "#f93920" }}>*</span>
              </div>
              <Input
                aria-label="工作区名称"
                value={draft.name}
                maxLength={80}
                onChange={(name) => setDraft({ ...draft, name })}
                placeholder="例如：飞书机器人项目"
                disabled={busy}
              />
            </div>
            <div>
              <div style={{ marginBottom: 6, fontWeight: 500, fontSize: 14 }}>
                目录路径 <span style={{ color: "#f93920" }}>*</span>
              </div>
              <Input
                aria-label="工作区路径"
                value={draft.root}
                onChange={(root) => setDraft({ ...draft, root })}
                placeholder="选择或输入本机文件夹"
                disabled={busy}
              />
              <Button
                style={{ marginTop: 8 }}
                icon={<IconFolder />}
                disabled={busy}
                onClick={() => {
                  setBrowser(true);
                }}
              >
                浏览文件夹
              </Button>
              <Typography.Text
                type="tertiary"
                size="small"
                style={{ display: "block", marginTop: 4 }}
              >
                支持粘贴绝对路径或 ~/ 路径。目录需已存在。
              </Typography.Text>
            </div>
          </div>
          {browser && (
            <FolderBrowser
              initial={draft.root}
              onClose={() => setBrowser(false)}
              onSelect={(root) => {
                setDraft({
                  ...draft,
                  root,
                  name: draft.name || workspaceName({ ...draft, root }),
                });
                setBrowser(false);
              }}
            />
          )}
        </Modal>
      )}
    </Space>
  );
}
