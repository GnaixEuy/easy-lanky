# easy-larky 工程规则

- 本目录是独立 Node/TypeScript 工程与 Git 仓库。先阅读工作区 `../../AGENTS.md`、`../../document/PROJECT_MEMORY.md` 和相关设计。
- 源码在 `src/`，测试在 `tests/`，工程脚本在 `scripts/`。安装、构建、测试及 Git 命令在本目录执行。
- PRD、设计、接口契约、路线图和交接统一维护在工作区 `../../document/`、`../../work-log/`，不建立重复版本。
- 脱敏示例在 `../../env-config/`；本机配置为本目录被忽略的 `easy-larky.local.json`、`.env`。共享产物、SQLite、临时材料分别在 `../../output/`、`../../tmp/`。
- 修改目录或运行方式时更新工作区 ROADMAP、PROJECT_MEMORY 与 HANDOFF。保留其他 session 的未提交工作，不自行 commit/push。
