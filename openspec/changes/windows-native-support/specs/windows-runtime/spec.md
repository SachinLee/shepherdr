# Windows 原生运行要求

## ADDED Requirements

### Requirement: Windows CLI 与安全生命周期

系统 SHALL 在 Windows x64、同一普通用户运行下提供原生 CLI 和安全启动、停止、状态查询。

#### Scenario: AC-WIN-01 安装路径
- **WHEN** 安装路径含空格或中文，用户从 Windows 命令行调用 CLI
- **THEN** 参数完整传递，命令可运行，无隐含 POSIX shell 前置要求。

#### Scenario: AC-WIN-02 core 兼容性
- **WHEN** 指定 core session 或端点并启动
- **THEN** 连接所选 core，校验 generation 和所需方法；不兼容时返回可操作错误，不连接其他会话。

#### Scenario: AC-WIN-03 生命周期
- **WHEN** 用户重复启动、查询状态、停止或在异常退出后重启
- **THEN** 启动幂等、状态只读、停止执行 drain 和清理、不重复创建任务；停止应用保留 core 和 agent；不终止身份未核对的进程。

### Requirement: Windows 私有身份与路径

系统 SHALL 在 Windows 使用可验证的账户和访问控制保护状态、凭据与本地控制通道，不能用跳过 POSIX 检查冒充保护。

#### Scenario: AC-WIN-04 私有状态
- **WHEN** home、凭据或 operator 存在宽松 ACL、链接、junction、端点替换或身份不匹配
- **THEN** 拒绝不安全访问并解释原因；位于用户 profile 下或拥有随机管道名本身不足以授权；无法确认保护时拒绝。

### Requirement: 普通任务

系统 SHALL 在 Windows 支持已验收的原生 agent 与普通任务、仓库和文件路径。

#### Scenario: AC-WIN-05 agent 闭环
- **WHEN** 启动一个宣称支持的原生 agent 并提交无害任务
- **THEN** 启动、消息、hooks、状态更新、任务结束和应用重连均有真实证据；缺少账号或程序时记录未验证，不以 fake 代替。

#### Scenario: AC-WIN-06 文件与仓库
- **WHEN** 使用普通 worktree、includes、review helper、附件或产物，路径含空格、中文、反斜杠或不同盘符
- **THEN** 合法操作成功，越界、危险链接及不安全文件被拒绝；保留现有 Linux/macOS 行为。

### Requirement: 能力限制与验证

#### Scenario: AC-WIN-07 本机隔离
- **WHEN** 在 Windows 本机请求 Autopilot
- **THEN** 明确说明本机不支持，不启动无隔离 fallback，也不自动使用 WSL。

#### Scenario: AC-WIN-08 支持证据
- **WHEN** 声明 Windows 首版完成
- **THEN** 所需 Windows CI 与原有平台检查通过，文档分别列出支持、未验证和不支持；本机只执行 typecheck，测试和构建交给 CI，真实设备或 agent 证据不由 fixture 代替。
