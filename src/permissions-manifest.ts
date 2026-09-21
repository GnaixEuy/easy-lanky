// Managed bot tools: messaging plus core document, table, calendar and task scopes.
export const permissionManifest = [
  {
    scope: "contact:user.base:readonly",
    name: "获取用户基本信息",
    purpose: "读取收件人姓名，避免只拿到用户 ID 而无法按姓名查找",
  },
  {
    scope: "contact:department.base:readonly",
    name: "获取部门基础信息",
    purpose: "读取候选收件人的部门名称，区分同名用户",
  },
  {
    scope: "contact:contact.base:readonly",
    name: "获取通讯录基本信息",
    purpose: "按姓名查找机器人可见的收件人，确认后向其发送消息",
  },
  {
    scope: "im:message.reactions:write_only",
    name: "添加和删除消息表情",
    purpose: "用敲键盘表情反馈任务处理中状态",
  },
  {
    scope: "im:message.reactions:read",
    name: "读取消息表情",
    purpose: "恢复后清理机器人自己的处理中表情",
  },
  {
    scope: "tenant:tenant:readonly",
    name: "获取企业信息",
    purpose: "验证机器人所属企业",
  },
  {
    scope: "im:message.p2p_msg:readonly",
    name: "接收私聊消息",
    purpose: "接收用户任务",
  },
  {
    scope: "im:message.group_at_msg:readonly",
    name: "接收群聊 @ 消息",
    purpose: "接收群内定向任务",
  },
  {
    scope: "im:message.group_at_msg.include_bot:readonly",
    name: "接收机器人 @ 消息",
    purpose: "Agent 间定向协作",
  },
  {
    scope: "im:message:send_as_bot",
    name: "以机器人身份发送消息",
    purpose: "回复任务与协作结果",
  },
  {
    scope: "im:message:readonly",
    name: "读取消息",
    purpose: "核对协作消息与上下文",
  },
  { scope: "im:chat:read", name: "读取会话信息", purpose: "识别群聊与话题" },
  {
    scope: "im:chat.members:read",
    name: "读取群成员",
    purpose: "核对协作对象身份",
  },
  {
    scope: "im:chat",
    name: "管理群聊",
    purpose: "覆盖官方 CLI 的建群、群信息和成员管理操作",
  },
  {
    scope: "minutes:minutes",
    name: "访问妙记",
    purpose: "为官方 CLI 的妙记能力申请较完整的应用权限",
  },
  {
    scope: "vc:meeting.meetingevent:read",
    name: "读取会议信息",
    purpose: "查询会议详情、关联纪要和妙记",
  },
  {
    scope: "docx:document:readonly",
    name: "读取云文档",
    purpose: "查询机器人可访问的文档内容",
  },
  {
    scope: "docx:document:write_only",
    name: "编辑云文档",
    purpose: "按确认的操作创建和修改文档",
  },
  {
    scope: "docx:document.block:convert",
    name: "转换文档内容",
    purpose: "官方 CLI 将 Markdown 转为文档内容",
  },
  {
    scope: "drive:drive",
    name: "管理云空间文件",
    purpose: "查询文件以及执行确认的文件操作",
  },
  {
    scope: "wiki:wiki",
    name: "管理知识库",
    purpose: "读取知识库和执行确认的节点操作",
  },
  {
    scope: "sheets:spreadsheet",
    name: "读写电子表格",
    purpose: "查询表格并按预览修改数据",
  },
  {
    scope: "bitable:app",
    name: "读写多维表格",
    purpose: "查询多维表格并按预览修改记录",
  },
  {
    scope: "calendar:calendar",
    name: "管理机器人日历",
    purpose: "查询机器人可访问的日历和执行确认的日程操作",
  },
  {
    scope: "task:task:write",
    name: "读写任务",
    purpose: "查询任务并执行确认的任务变更",
  },
  {
    scope: "task:tasklist:read",
    name: "读取任务清单",
    purpose: "查询机器人可访问的清单",
  },
  {
    scope: "task:tasklist:write",
    name: "编辑任务清单",
    purpose: "按预览创建和修改清单",
  },
] as const;
export const requiredTenantScopes = permissionManifest.map(
  (item) => item.scope,
);
export const requiredTenantEvents = ["im.message.receive_v1"];
