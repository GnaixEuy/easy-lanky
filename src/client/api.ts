export class ApiError extends Error {
  constructor(
    public status: number,
    code: string,
  ) {
    super(code);
  }
}
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${sessionStorage.getItem("easy-larky-session") || ""}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(
      path === "/api/connection/connect" ||
        path === "/api/robots" ||
        path.startsWith("/api/registrations")
        ? 45000
        : 10000,
    ),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error);
  return data;
}
export function explain(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return (
    (
      {
        connection_busy: "正在应用设置和连接飞书，请稍后重试。",
        connection_not_ready: "请先上线机器人，再授权会话。",
        conversation_expired: "待授权消息已过期，请在飞书重新发送一条消息。",
        lark_connection_failed:
          "飞书连接失败。请检查网络、应用凭据，以及开放平台的消息事件订阅和长连接配置，再点击上线重试。",
        no_bots_configured: "请先添加机器人。",
        lark_scope_query_failed:
          "无法查询应用权限，请检查应用是否已安装或稍后重试。",
        registration_app_mismatch:
          "授权返回的应用与当前机器人不一致，已停止连接。",
        registration_authorization_expired:
          "权限确认已过期，可重新打开权限确认。",
        registration_authorization_denied:
          "已拒绝本次权限补充，现有应用凭据保留。",
        registration_authorization_cancelled:
          "已取消权限确认，现有应用凭据保留。",
        registration_unavailable: "暂时无法连接飞书创建服务，请稍后重试。",
        registration_not_found: "创建会话不存在，请重新获取二维码。",
        registration_busy: "正在处理创建结果，请稍后重试。",
        registration_limit: "等待创建的机器人较多，请先完成或取消已有二维码。",
        registration_already_created:
          "应用已在飞书创建，取消等待不会删除应用。请返回机器人设置完成保存。",
        registration_new_robot_required:
          "此机器人已配置，请添加新的机器人再扫码。",
        registration_not_ready: "尚未收到应用创建结果。",
        unauthorized: "连接已过期，请重新运行 npm start -- console。",
        ticket_expired: "连接链接已失效，请重新运行 npm start -- console。",
        invalid_request: "请检查必填项和输入格式。",
        invalid_local_scope: "目录或 Agent 已变化，请重新读取配置。",
        lark_secret_required: "请填写 App Secret。",
        lark_credentials_rejected:
          "无法验证应用，请检查 App ID、App Secret 和网络连接。",
        lark_bot_unavailable:
          "无法读取机器人信息，请在开放平台启用机器人能力。",
        lark_tenant_unavailable:
          "无法读取应用所属企业，请稍后重试或检查应用状态。",
        lark_tenant_permission_required:
          "应用缺少“获取企业信息”权限（tenant:tenant:readonly）。请在应用权限页开通，并按后台提示发布生效后重试。",
        lark_permission_required:
          "应用权限不足，请在开放平台检查此应用的权限配置。",
        lark_network_unavailable:
          "无法连接飞书服务，请检查网络后重试。已填内容保留。",
        lark_response_invalid: "飞书服务返回了无法识别的结果，请稍后重试。",
        bot_replacement_requires_review:
          "此机器人已关联会话。更换应用请添加新机器人。",
        config_revision_conflict:
          "配置已被其他操作修改。请重新读取配置，再合并本次修改。",
        config_change_requires_review:
          "仍有未完成任务或待核对的消息，请在运行状态中处理后保存。",
        config_restart_required: "配置已保存，请点击“应用设置并上线”后再试。",
        directory_unavailable: "无法浏览此目录，请检查路径及访问权限。",
        invalid_binding: "工作区仍被机器人或会话使用，请先调整关联后再删除。",
        agent_project_required: "请至少保留一个 Agent。",
        project_root_unavailable: "无法访问目录，请填写本机已存在的目录。",
        project_root_not_directory: "所填路径不是目录。",
        bots_must_use_distinct_apps: "每个机器人需要使用不同的 App ID。",
        duplicate_config_id: "配置标识重复，请重新读取配置。",
        queue_full: "任务队列已满，请稍后重试。",
        message_id_conflict: "同一请求的内容发生冲突，请核对原任务。",
      } as Record<string, string>
    )[code] || "操作未完成，请检查本地服务后重试。"
  );
}
export async function connectFromLink() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
  history.replaceState(null, "", location.pathname);
  if (ticket) {
    const data = await api("/api/session", { ticket });
    sessionStorage.setItem("easy-larky-session", data.token);
  }
}
