# easy-larky 工程

本目录是本地 Agent Host 的独立代码仓库。产品介绍见[工作区 README](../../README.md)，实际进度见[ROADMAP](../../document/ROADMAP.md)，使用方式见[RUNBOOK](../../document/RUNBOOK.md)。

```sh
npm ci
npm run build
npm test
# 首次使用才初始化；已有配置不覆盖
node scripts/init-local.mjs
npm start -- start --offline
```

配置示例位于 `../../env-config/`，运行状态与验收产物位于 `../../output/`。真实 Lark 验收仍须遵守工作区的身份和发信授权边界。

Host 启动后，在另一个同目录终端执行 `npm start -- console` 打开配置工作台。采用 React + Semi Design，入口为机器人、工作目录、运行状态；运行诊断提供本地测试任务。保存新配置后按 RUNBOOK 重启 Host。
