# Windows 原生运行设计

## 状态与边界

- Active change: openspec/changes/windows-native-support/
- Assigned slice: planning / all accepted ACs
- Phase: planning；profile: critical。需求以 `proposal.md`、`specs/windows-runtime/spec.md` 为准，P0–P4 已获授权。
- 本片仅新增 `design.md`、`tasks.md`。沿用 `artifacts/context.md` 的读取清单，将新增切片上下文直接放在 `tasks.md`，不修改其他记录。
- 基线 commit: `8df9402c63ebd97ae05ed309b0444e2d755cacc6`。本 change 的 `artifacts/verification.md` 已记录主会话基线 typecheck PASS；本规划未运行测试、构建或 typecheck。P0 已返回 core 兼容性结果，主会话复核及来源见 `artifacts/verification.md:26`；本规划消费该 canonical 记录与主会话补充，不重复探针。
- 仅承诺 Windows x64、同机同一普通账户的 core 与普通 agent/任务。保留 Linux/macOS、public plugin 契约、`--core-socket`、旧凭据读取格式。Windows 本机 Autopilot 明确拒绝；其余范围外功能不得借本次适配扩展承诺。

## 依据与选定规范

已读取本 change 的 proposal、spec、context、verification，以及 `AGENTS.md`、`docs/develop.md`、`docs/core/start.md`、manifest、TypeScript 配置、相关实现与测试。`openspec/specs/` 只有 `.gitkeep`；在项目文档和项目 spec 路径未发现独立 ADR，本设计承载本次技术决策。

选用 `project-standards/references/common.md`，没有适用于本项目的额外 TypeScript 专项参考。项目事实：Bun、TypeScript 5.9.3 strict、ESM、`bun:sqlite`，CI 固定 Bun 1.4.2，P0 与本机基线为 1.4.4；1.4.2 的 Windows 兼容性仍 UNVERIFIED，保持现有 pin，不因 P0 升级。无现成 Windows ACL 依赖。要求最小闭合修改、保留接口与数据格式、边界校验、限量 I/O、不记录秘密、不做无证据重试。项目覆盖通用验证默认：本机仅允许 `bun run typecheck`，测试与构建只交给 CI；编写测试，但不能把预期 RED/GREEN 写成实际结果。禁止更改生成物、README 设计、真实 home、账户/信任、全局 PATH、部署和发布。

## 决策 D1：Windows 私有文件必须验证 SID、DACL 与实际打开的对象

现状：`server/core/home.ts:11` 的 `inspectHome` 只分类，`server/core/home.ts:22` 的 `prepareHome` 用 mode 0700，`server/core/home.ts:45` 的 `readCredential<T>` 用 uid、mode、`O_NOFOLLOW` 与 `fstatSync`；这些不是 Windows ACL 证明。`server/core/store.ts:15` 的 `CoreStore` 在私有 home 中打开 SQLite 后 chmod，不能以 Windows chmod 代替保护。

首选新增一个窄的 Windows 保护接缝：`server/core/windows-security.ts` 调用随代码分发的 `helper/core-windows.ps1`。使用系统 Windows PowerShell 的 .NET 安全 API；只有句柄级 ACL、reparse、文件身份及管道身份所必需的 Windows API 通过脚本内固定 `Add-Type` 声明调用。不引入 npm ACL 包、FFI 或独立二进制。此机制的可用性由 T1 的隔离安全用例证明；脚本策略、API 或文件系统能力不足时给出可操作错误并拒绝，不修改 ExecutionPolicy、不申请提权、不装依赖。

保护不变量：

1. 当前账户从访问令牌取得 SID，比较原始 SID，不解析本地化账户名或 `icacls` 文本。新建本应用目录时在创建时设置受保护 DACL，继承项只授权当前 SID 与 `S-1-5-18`（SYSTEM）；新文件继承这一保护并再次验证。已有目录或文件只验证，不自动收紧、迁移或修复权限。
2. 验证 owner 为当前 SID，DACL 存在且可解释，当前 SID 有操作所需权限，其他主体没有读取秘密或写入/删除/替换的授权。宽松 inherited allow、未知 ACE、无法取得 DACL、异常 owner 均拒绝。不能仅靠 deny 抵消宽松 allow 后判定私有。OS 管理员/SYSTEM 可接管机器是现有信任边界，不承诺抵御已提升权限的管理员。
3. 检查路径链和可替换父目录，拒绝私有状态中的 symlink、junction 及其他 reparse point；验证外部普通账户不能通过祖先的写入或 delete-child 权限替换安全根。不能把 profile 路径、`realpath` 相等或路径前缀当成 ACL。未证明可用语义的网络共享或文件系统拒绝作为私有 home。
4. 凭据与私有配置的读取使用 `CreateFileW` 的 reparse 控制，在持有的句柄上验证 owner/DACL、对象类型、volume/file identity、link count、最终路径及大小，再由同一持有者读取；不把“已验证路径”返回 Bun 后重新打开。读取期间禁用共享写入/删除；父目录验证及必要的持有句柄避免中途改名。文件替换、hardlink、属性变化、共享冲突都拒绝。写入使用受保护父目录中的独占新文件与受控发布，不覆盖未知对象。
5. SQLite、vault、installation/core/run/lock/log 等也属于保护范围。SQLite 的原生打开保留在 Bun：打开前验证现存文件与目录链，依赖经验证且不可被其他普通账户修改的父目录；明确同 SID 进程属于可信账户边界。不能宣称先 `Get-Acl` 再任意 Bun 打开能防住可写父目录竞态。vault 的 Windows I/O 复用保护接缝，POSIX 分支及格式保留。
6. `status` 只验证和读取；目录不存在不创建，权限不明不写入，既有 legacy home 不迁移。ACL 初始化仅针对用户选择的全新本应用目录，不触碰真实 profile、provider home 或仓库 ACL。

备选：只跳过 uid/mode、只检查 profile/realpath、只运行 `icacls`、先普通创建再 chmod，均不满足 AC-WIN-04。若固定 PowerShell/.NET 方案不能提供以上句柄语义，T1 报告阻塞与实测证据，交主会话裁决必要原生依赖；不能悄悄降级。

## 决策 D2：同句柄受检 pipe broker，保留原有 remote connect

`server/core/config.ts:21` 至 `server/core/config.ts:29` 对 Unix socket 做 `resolve` 和 100 字节限制；Windows 命名管道必须保持原样。保持选项和环境优先级：显式 `--core-socket` 优先；显式 session 不继承其他 session 的 `HC_SOCKET`；只用所选 session/端点。默认 Windows pipe 的命名规则必须取自 P0 的实际版本/官方入口，不能套用 Unix 目录或猜测 pipe 名。

P0 已验证 hc 0.1.17 / generation 1、Windows x64、Bun 1.4.4：真实仓库 `CoreClient.open(pipe)` 通过原生 `node:net` 完成握手、RPC、subscribe、terminal run/attach/resize 等操作；19 个 REQUIRED 方法全部存在。`CoreClient.endpoint({ binary, session, socket })` 的 `hc connect` 同样成功。当时选择 direct pipe；后续调查发现 Bun 的公开 node:net 接口不能提供实际 Windows pipe 句柄，无法对同一连接核验 DACL/peer。2026-11-03 修订：本机采用固定 PowerShell/.NET broker 持有并转发同一个已验证连接；不能预检后让 Bun 重连。P0 仍只是协议证据，不是 broker 安全或生命周期证据。

Windows 本机保持 `CoreClient.open(string)` 与 `CoreSession` 的 string 端点形状，string 为未经文件路径 resolve 的原始 `\\.\pipe\...`。只在 open 的内部 Windows 分支创建固定 helper 的 Duplex，READY 后才构造和协商现有 framed client；不扩 CoreSession union、不改凭据格式。保留已有 remote `CoreClient.endpoint(...)` / `hc connect`；不把 hc connect 作为本机隐式 fallback，不自动切换 transport 或 session。此修订取代原来的“本机不得引入 subprocess transport”，因为同句柄安全要求优先于减少进程数量。

broker 约束（实现候选，Windows 实证尚待取得）：

1. 使用系统 Windows PowerShell 5.1 / .NET Framework 4.x 与固定脚本，不是“.NET Framework 5.1”。NamedPipeClientStream 使用 Asynchronous、Identification SQOS、None handle inheritance；只接受 canonical 本地 pipe。不依赖 Framework 中不存在的 CurrentUserOnly/FirstPipeInstance 枚举。
2. 从该 stream 的 SafePipeHandle 检查 owner/受保护非空 DACL 与 server PID；GetSecurityInfo 使用 SE_KERNEL_OBJECT=6，不复用文件的 SE_FILE_OBJECT=1。所需 ReadWrite|Synchronize 含 READ_CONTROL，mask 0x0012019B；pipe rights 单独解析，拒绝未知 ACE/flags/masks、foreign grant，不照搬文件 mask。实际 hc DACL 不兼容时拒绝并解释，不重写它。
3. 打开并持有 server process handle，比较 token 的 TokenUser（不是 TokenOwner），核验前后 pipe PID。首版限制双方为同 SID、同 Windows session、非提权 medium-integrity 普通用户；无法查询或其他上下文拒绝。这不是可执行文件认证，也不承诺防恶意同 SID 进程或冻结后续 ACL 变化。
4. 固定 helper 的独立模式在现有 JSON 文件操作入口之前分流。启动控制有界，验证后才输出版本化 READY；其后 stdout 只能为不解码的原始字节，stderr 为有界无秘密诊断。父端须保留 READY 同 chunk 后的数据；C# 二进制复制、有界缓冲和背压，不能经 PowerShell 文本管线转发。
5. 编译/启动与连接分别有 deadline；健康连接无空闲超时，原协议 deadline 保留。任一方向 EOF、验证失败、READY 畸形、子进程异常均关闭并释放连接；不依赖 half-close。父端 dispose 只终止自己创建的 helper，父消失也必须清理；重连仅由 CoreSession 决策，不重放不确定写入。

裁定来源：oracle ses_e5f9820b8ffe4XjLyBXTqLlsUK 对 Microsoft Framework reference source（Pipe.cs、Enums.cs、PipeStream.cs、PipeSecurity.cs）及 GetSecurityInfo、named-pipe rights、GetNamedPipeServerProcessId、TOKEN_INFORMATION_CLASS 官方文档的只读诊断。主会话未将其报告当 OS 实验：Framework 编译、真实 hc DACL、client-side server-PID API 行为、binary fidelity、取消/EOF/父死亡清理均 UNVERIFIED，必须加入 Windows 验证；API 不支持则 fail closed，而非回退裸 node:net。

`server/core/client.ts:19` 的 REQUIRED、现有 generation/minimum/schema 校验保持门禁。`server/core/source.ts:123` 构造和 `server/core/source.ts:188` 恢复均复用选定 pipe；重连只重建观察，不重发不确定写入。官方 core 已有 ConPTY，无自写 PTY 需求。

P0 协议通过不证明 Windows 私有状态、实际 pipe peer/DACL、完整应用或 agent 安全已经通过。D1/D3 的安全验证仍为 T1/T2 实施与启动门禁，无法确认时拒绝；不得据此跳过检查或自行改回 `hc connect`。默认管道命名规则仍须取可靠的官方/实际证据，隔离探针使用的显式 pipe 名不能变成产品默认值。

## 决策 D3：私有 operator 承担认证停止，复用唯一 drain

`server/core/operator.ts:10` 的 Unix socket 和 `server/core/operator.ts:37` 的 chmod 保留在 POSIX；Windows 自己的 operator 不继承官方 core 的 ACL 保证。

Windows 由 D1 的固定 helper 创建并持有本地命名管道：创建时安装当前 SID/SYSTEM 的保护 DACL，拒绝远程客户端，用 first-instance 语义拒绝预占；在接收命令前完成保护确认。helper 与应用仅通过所创建子进程的 stdin/stdout 交换有界请求/响应，不开 HTTP 端口、不使用 shell 命令字符串。客户端通过实际 pipe 句柄验证 owner/DACL/server PID，并先核对 boot 身份后才发送 secret 值或停止命令。`run.json` 仍保留 `operator` 字段，Windows 可增加实际 pipe helper PID；不能误把 helper PID 等同应用 PID，也不能把随机名字当权限。

沿用 operator 的 512 KiB 请求/响应与 64 KiB secret 上限、超时和 source.quiescing 门禁。新增窄的生命周期请求，验证安装身份、boot 和当前运行记录；只允许请求本应用停止，不执行任意命令或 PID 操作。Windows framing 显式定界，不依赖 Unix socket half-close。

`server/core/main.ts:38` 的信号处理提取为同一幂等 shutdown：标记 stopping → `source.drain()` → 关 operator/source/HTTP → 仅删除当前 boot 的 run.json → 正常退出。信号与认证 operator 都调用它。停止回执先确认接收，launcher 等待 drain 完成、对应记录清除与原应用退出；超时报告 finishing，不强杀。保留 core 和 agent，不向未知 PID 发信号。

P0 已证明生命周期差异：`hc server restart` 保留同一 holder/程序；`hc server stop` 会结束 core、holder 和程序，后续 start 的 keep terminal 是新 shell，不能恢复原程序。因此 **Shepherdr stop 只能停止自己的 main/drain**，严禁调用 `hc server stop`、`hc server restart` 或其他 core 生命周期操作来停止应用，也不能把它们用作 drain 超时的 fallback。断开本应用 client/订阅不等于停止 core；正常启动/故障恢复中原有的选定 core 启动职责与应用停止严格区分。

`server/core/launcher.ts:174` 的 POSIX SIGTERM 分支可保留；Windows stop 走私有 operator。启动锁覆盖启动和停止，写锁前验证 home，锁内容/owner/boot 身份核实后才清理死锁；活着但身份未确认时不替换。后台启动保持 argv 数组、独立日志与明确 readiness，日志句柄关闭，验证 Windows detached/unref 的实际行为；不得以“spawn 返回成功”当启动完成。异常退出重启复用已选 core，不能重建现存任务。

## 决策 D4：原生入口和 agent 闭环保持结构化 argv

`bin/shepherdr:1` 是 POSIX shell。新增 `bin/shepherdr.cmd` 与共享 TypeScript 分发入口，覆盖 start/stop/status、human secret 命令、agent mailbox 的既有路由，退出码、stdin 和参数保持一致；POSIX wrapper 也调用该分发入口，避免两套语义。从 CMD 和 PowerShell 验证空格、中文路径及带引号参数，不要求 Git Bash/WSL，不改全局 PATH。

`server/core/agents.ts:22` 的 POSIX quote、`server/core/agents.ts:36` 起的运行时发现以及 launch 生成文件/命令均需按目标机器平台处理。主机与目标机器不可混为一谈；只改变 Windows 本机路径，原有 Linux/macOS/远端行为保留。PATH 使用平台 delimiter，运行 core/agent/helper 用 argv；只有 provider 要求 hook command 字符串时，使用该 provider 在 Windows 的实际 shell 规则并验证，不能统一套 POSIX 单引号。

优先直接启动原生 `.exe`。npm `.cmd`/`.ps1` 只是发现线索：确认实际 launcher 后显式选择可执行程序和参数；未验证 shim 不宣称支持，不设置 ExecutionPolicy、不安装/登录 provider、不改 hook trust。命令不能安全表示时不给自动批准规则；`ownRules`/`ownCommand` 继续收窄，不能为了 Windows 放大匹配。

Claude 最小实现采用官方 hooks reference 的 exec form：`command` 为绝对 `bun.exe`，`args` 单独传绝对 helper 路径，避免 shell 转义。主会话于 2026-11-04 独立读取 https://code.claude.com/docs/en/hooks，确认 `.cmd`/`.bat` 不可用作 Windows exec hook，`onFailure: "block"` 要求至少 v2.1.295。exec form 的引入版本仍 unknown，故暂以调查时官方最新版 v2.1.317 为保守支持下限，必须预检真实 `claude.exe` 的版本；这不是其最早支持版本的结论。权限守卫失败必须阻断；Windows 精确自动批准格式未核实时不生成自动 allow，保留正常审批。Codex 暂时明确拒绝。真实 Claude 启动、消息、权限、hook 状态及重连仍须独立验收。

沿用每 launch 的 mail grant、credential、hooks、native transcript、terminal identity 与 stale-hook 防护。权限 hook 失败继续 deny。真实 agent 缺失或未登录记 `UNVERIFIED`，fixture 只证明协议边界。Windows 本机 Autopilot 在发放 grant、创建 contained state 或 terminal.run 前明确拒绝，并保留 `helper/core-pilot-launch.ts:38` 的 Linux-only 防线；不调用 WSL、不转普通无隔离启动。

## 决策 D5：普通任务所有实际文件接缝一起收口

- worktree/includes/review：`server/core/tasks.ts:424` 调用 includes；`helper/core-worktree-includes.ts:24` 的相对路径和后续私有 stage/open/publication 必须保留边界与不覆盖语义；`helper/core-review.ts:6` 至 `helper/core-review.ts:10` 的 credential/log 要用 Windows 私有保护。`helper/core-worktree.ts:72` 的 wire 相对路径继续使用 `/`，不直接接受驱动器、UNC、ADS、设备路径或 `..`。本机绝对文件系统路径用 `path.win32` 语义，跨盘 relative 结果视为越界；不能把合法的 repo 绝对根和 wire 相对路径混淆。
- `server/core/worktree.ts:9` 目前拼接 helper 源码 `bun -e`。若 helper 增加安全导入，Windows 本机改成调用 immutable checkout 中的实际 helper 文件及明确 CLI 接口，保留 core machine.exec、stdout JSON 协议；不能留下相对 import 在 eval 环境失效。不要扩大 SSH 支持承诺或修改 Autopilot 的隔离 broker。
- 附件与产物：`server/core/chat.ts:57` 的 upload/read/copy、`server/core/artifacts.ts:77` 的 read 与 `server/core/artifacts.ts:125` 的 export 都有实际路径及 inline uid/mode 检查，Windows 本机分支复用安全接缝。保留 chat/launch 归属、大小/哈希/分片 offset 校验、敏感 provider/home 排除和不覆盖发布。文件名拒绝 Windows ADS、保留设备名、尾随点/空格及越界，不靠 basename 静默改写危险名字。
- 路径归属比较考虑盘符、大小写、separator 和卷身份，同时用实际对象身份判定，不能仅 lowercase 前缀授权。危险 reparse、hardlink 和中途替换拒绝；合法空格/中文及不同盘符上的 repo/worktree/普通文件要有 Windows 证据。需要同卷原子发布的内部 stage 必须位于目标卷，不以跨卷 copy 取代安全发布。
- 共享浏览器、语音、SSH、plan approval、用量读取仍在范围外。`helper/core-browser.ts:14` 等已知 POSIX 断言不能简单删掉；只在普通闭环实际到达时修复必要的公共接缝，否则文档明确限制，不把这些功能算作 Windows PASS。

## 切片、验证、交付与回退

执行 DAG、逐片 AC 原文、允许修改文件、定位结论、RED/GREEN、命令和回退点见 `tasks.md`，不创建第二套计划。T1 可先实施；T2 依赖 T0 和 T1，P1 结束必须同时具备私有目录和优雅停止，不能交付一个暂时跳过安全/硬杀的中间版本。

P4 分阶段新增 Windows typecheck/build、选定适用测试与真实 OS ACL/pipe 用例；保留现有 Ubuntu 全套检查，并给变更接缝补 macOS 回归。先使 Windows 基础接缝可信，再扩大普通任务集合；不能通过按平台跳过安全断言得绿，也不承诺把全部 POSIX/浏览器测试直接搬到 Windows。测试 runner/preload 中的 `/proc`、`ps`、shell 假 hc 等是明确的适配输入。

本机只允许后续实施者执行 `bun run typecheck`；本规划未执行。所有测试/构建命令标记 `NOT RUN（本机禁止；待 CI）`，未授权 push/PR/workflow_dispatch 时准备 workflow 后保留远端结果 `NOT RUN`。真实 core、agent 和共享浏览器人工证据独立记录；fixture 和 demo 不代替。声明首版完成仍须 AC-WIN-08 要求的 Windows CI、原平台检查与真实闭环证据。

主会话拥有执行、记录证据、修复与最终交付；本规划角色拥有本两份文档的覆盖核对。实现稳定后只安排一次 fresh-context 独立 Standards / Spec 审查，最多一次聚焦修复复查，不能递归审查或自行扩大轮次；模型不可观察时不宣称跨模型。

无需数据迁移、版本更改或发布。现存 home 不自动改 ACL，旧凭据格式继续读，新增运行记录字段可选。回退按切片撤回代码并停止隔离应用；新建隔离状态只由其 owner 在核对身份后清理，保留 core/agent 及真实数据。任何保护能力失败时暂停 Windows 功能并保留错误，不能回退为无保护运行。

## 尚未解决的事实与 readiness

- P0 协议和 core 生命周期结论已返回，T0 已收口；D2 已由裸 direct pipe 修订为同句柄受检 broker，尚无 broker 实测。原始 P0 产物位于 `C:\Users\shuan\AppData\Local\Temp\opencode\shepherdr-win-p0`；规划角色依据 canonical verification 与主会话补充，不宣称独立读过外部 JSON。
- T1：默认普通用户下 .NET/API、脚本策略、DACL/句柄与 pipe first-instance 的可用性须有真实 Windows 证据；这决定能否保持零新增原生依赖。
- P0 使用临时官方 hc，不代表 PATH 中已安装 hc；本机仍无 claude、codex 只有 npm PowerShell shim。真实 agent 与完整 Shepherdr server 闭环 UNVERIFIED，不得由 core 探针推定。
- Bun 1.4.2 Windows 尚未验证；CI 保持 1.4.2，不能把 1.4.4 的 P0 结论回填为旧 pin 的 PASS。
- Windows CI、macOS 变更接缝回归、真实浏览器证据、最终实现独立审查尚未取得，均不能据设计推断通过。

规划覆盖 AC-WIN-01..08：T0 done，T1 code_complete / OS verification pending，T2a 入口修正中，T2b 按修订 D2 实施受检 broker。完整 Windows 支持声明仍不 READY。以上为技术证据缺口，无需重复请求 P0–P4 实施许可。
