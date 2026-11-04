# Windows 原生适配

## 目标与授权

Windows x64 原生运行 Shepherdr，连接同机同一普通用户运行的 herdr-core，交付安全生命周期及普通 agent 任务闭环。用户于 2026-11-03 批准对话中的 P0–P4 方案并要求开始执行，随后明确同意初始化 OpenSpec 并创建本 change。方案批准已生效，不再请求相同实施许可。

## 范围内

- P0：隔离 core 二进制与 session 的手工可行性探针，验证协议、真实能力和生命周期。
- P1：Windows CLI、端点选择、私有状态、operator、锁、日志、优雅停止。
- P2：普通 agent 启动、hooks、聊天、状态、普通任务；修正实际执行路径中的 shell/PATH/引用。
- P3：worktree/includes、review helper、附件及产物的路径和私有文件检查。
- P4：分阶段 Windows CI、平台回归覆盖、Windows 文档及明确功能限制。

## 范围外

Windows 本机 Autopilot（保持明确拒绝）、ARM64、登录自启与系统服务；SSH machines、语音、共享浏览器、plan approval、用量读取的 Windows 支持承诺。不得移除原有平台能力。不得更改 README 设计、真实用户状态、PATH、账户信任、Tailscale 映射、部署、版本、tag 或发布。

## 假设与未知项

上游官方资料确认 Windows x64 发布、命名管道、ConPTY 与 hc connect；本机缺少 hc，实际兼容性仍需探针。上游 issue #70 涉及 shell 内 agent 状态，不直接视为本应用直接启动路径的已证实缺陷。真实 agent 未安装/未登录时记录 UNVERIFIED，不注入账号或修改信任。

## 质量与检查

实施风险 profile: critical，原因是身份、凭据与本地控制通道变更。本机仅运行 bun run typecheck，不跑测试套件、浏览器测试或构建。隔离手工探针和共享浏览器人工检查可以执行；测试与构建由 GitHub Actions 执行。未获得 push/PR 或工作流触发许可时，只准备 CI，不宣称远端执行通过。

## 验收标准

以 specs/windows-runtime/spec.md 的 AC-WIN-01 至 AC-WIN-08 为准。每片记录代码证据、执行命令与结果、NOT RUN/UNVERIFIED 原因；完整交付后安排一次独立审查。任何需要新增 Windows ACL 原生依赖或扩大受支持功能的决策必须给出证据及边界。
