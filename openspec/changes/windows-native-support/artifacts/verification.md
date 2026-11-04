# Windows 适配执行证据

## 当前交付状态（2026-11-04，历史记录见下文）

- 状态：partial / blocked，NOT COMMITTED。T0 可行性已确认，T1–T6 编码已落盘；Windows 支持尚未验收。
- 当前材料的主会话 `bun run typecheck`：PASS；`git diff --check`：PASS（仅 LF/CRLF warnings）。本机测试、完整构建、浏览器、Windows/Ubuntu/macOS CI、真实 Claude 闭环：NOT RUN。本机检查范围遵守 AGENTS.md。
- 独立审查模型：用户指定的 `magpie/auto/gpt-6.1-sol`。一轮完整审查加一次定向补充已覆盖基线 tracked diff 与明确 untracked 清单；共发现三项 HIGH 及一项 LOW。R1/R2/R3 已修复并由同一 reviewer 静态读核，R4 在定向补充后由主会话修复、类型检查 PASS，尚无修复后的独立复核或 Windows 执行证据。不能标记 CLEAN。
- 验收表中的 UNVERIFIED 表示缺少应用层执行证据，不能由类型检查、mock、skip 或 P0 core 探针替代。

| 标准 | 当前结果 | 缺少的证据与下一步 |
| --- | --- | --- |
| AC-WIN-01 | UNVERIFIED | 普通 Windows 用户执行 core-windows-cli 的真实 CMD、中文/空格路径、stdin 与退出码用例。 |
| AC-WIN-02 | UNVERIFIED | P0 仅 core 协议可行；须在普通 token 下验证新 broker 连接真实 hc、端点和兼容性拒绝。 |
| AC-WIN-03 | UNVERIFIED | 认证 stop/清理已实现并修正删除分发；须执行 core-windows-lifecycle 验证 drain、幂等、core/holder/原程序连续性。 |
| AC-WIN-04 | UNVERIFIED | 须执行 core-windows-security/pipe/operator/secrets 的真实 ACL、SID、完整性、链接和共享保护用例；未覆盖的竞争接缝仍为 TODO。 |
| AC-WIN-05 | UNVERIFIED | 须在已安装且登录的真实 native Claude 上验证启动、消息、hooks、完成和应用重连；当前无 provider 账号或安装证据。 |
| AC-WIN-06 | UNVERIFIED | worktree ref 回归已修；须执行 core-git/tasks/worktree/includes/review、Windows 文件/发布/传输及可用第二卷用例。 |
| AC-WIN-07 | UNVERIFIED | Windows 本机 Autopilot 已明确拒绝；须执行多入口拒绝与无副作用断言。 |
| AC-WIN-08 | UNVERIFIED | CI workflow/普通用户脚本与文档已准备；需取得 Windows 普通用户强制层、Ubuntu 全套及 macOS 回归实际结果。未触发远端 CI。 |

### 独立审查与修复记录

- R1 / HIGH：`server/core/git.ts:62` 的 `branch refs/heads/...` 与解析后的纯 ref 不匹配，破坏合法 worktree 恢复及分支占用判断。已改为 `refs/heads/${branch}`；现有 `test/core-git.test.ts` 含已有 worktree、Windows 路径和 elsewhere 回归，NOT RUN。
- R2 / HIGH：`helper/core-windows.ps1:18` 的 ValidateSet 遗漏 `deleteFile`，使同 boot 记录清理在参数绑定前失败。已加入白名单，保留原同句柄删除；`test/core-windows-lifecycle.test.ts` 已覆盖同 boot 删除，NOT RUN。
- R3 / LOW：Windows 文档示例 session 原长 45，超过 24。已使用 12 字符随机后缀，总长 24，目录和 pipe 仍保留完整随机值。
- 同 reviewer 已确认 R1/R2/R3 修复。remote PARTS 遗漏 repository-paths 的疑点未成立，不列 finding；实际闭包测试仍 NOT RUN。
- 一轮 full + 一次 focused follow-up；focused 的补充覆盖曾因外部目录权限拒绝而中断，未增加审查轮次。改用仓库内临时输入后，reviewer 已读完 3,070 行 tracked diff 并按清单补读新增生产/CI/Windows tests；附件、产物、includes、hooks、文件发布及 Autopilot 入口的输入覆盖缺口已补齐。两份临时输入已删除。
- R4 / HIGH：`test/core-windows-pipe.test.ts:343` 的 fixture 从 advapi32.dll 导入 LocalFree，pipe 创建后在 LISTENING 前即会入口解析失败，阻塞普通层和提权拒绝层。主会话读取后改为 kernel32.dll，执行 `bun run typecheck` PASS；生产 helper 的声明本就正确，未改变安全策略。现有 core-windows-pipe 测试仍 NOT RUN，TypeScript 不验证嵌入 C# 原生入口。
- 最终 reviewer 状态：FINDINGS（针对 R4 修复前材料）；主会话已应用最小修复，但唯一 focused 预算已用完，不将未审修复自动转为 CLEAN。后续需受影响 Windows CI 的真实结果，并保留 R4 修复的独立证据缺口；没有自发增加审查轮次。
- TDD RED：NOT CAPTURED（本机禁止执行测试）；GREEN：仅上述主会话类型检查 PASS，不表示回归测试通过。没有 push、创建 PR、触发 CI、版本/tag 或发布。

## 授权与基线（2026-11-03）

- 用户已批准 P0–P4 规划并要求开始执行，明确同意初始化 OpenSpec 与创建 windows-native-support。
- 分支：windows-support。初始工作区干净；当前新增 OpenSpec 记录，尚未修改生产代码。
- `bun install --frozen-lockfile`：PASS，Bun 1.4.4，80 packages installed，无跟踪文件改动。
- `bun run typecheck`：PASS，执行 `bun scripts/build-plugins.ts && tsc --noEmit`，未报告类型错误。
- 本机未运行测试套件、浏览器测试或完整构建；CI 尚未触发。
- 本机没有 PATH 中的 hc 或 claude；codex 为 npm PowerShell shim，真实 agent 验收待定。

## 调度

- P0 手工隔离探针：explorer，session ses_e5fe44179ffegwgROzQneZRwBs。仅允许临时目录内官方 core、独立端点与 session，不改真实状态、PATH、凭据和信任。结果 PASS（仅 core 兼容性，非应用验收）。
- 设计与切片：workflow-planner，session ses_e5fe06e6bffex6oHDJmdlyoLw9。只写本 change 的 design.md 和 tasks.md。结果 PENDING。
- 未指定模型，使用宿主默认路由；实际模型未观察，不宣称跨模型独立性。

## 尚未取得的证据

- Windows 安全启动与私有目录/通道验证。
- 真实 agent、手工浏览器与 Windows/Linux/macOS CI。
- 最终实现的独立审查。

当前状态：in_progress。以上基线 PASS 不代表 Windows 适配已完成。

## P0：core 兼容性（2026-11-03）

证据目录：`C:\Users\shuan\AppData\Local\Temp\opencode\shepherdr-win-p0`。主会话独立读取 `probe-client-report.json` 与 `probe-holder-report.json`，核对直接命名管道、hc connect、事件、终端和重启/停止语义；其他细节来自探针执行者的记录。

- 官方 manifest `https://releases.herdr.dev/core/latest.json`：0.1.17 / generation 1，Windows x64 包 3,699,216 bytes。ZIP SHA256 `A212B69DB0EFB808882683F15E5DA45AB9606DA7BCC54B97B29ED4FA540F5491` 与 manifest 一致（执行者验证）；EXE SHA256 `D144159FE0A4CA3EEE4AB9D176331632FB78E2B1AFE6F90ACFC4325AEA97594E`。
- 环境 Windows NT 10.0.26300.0 x64 / Bun 1.4.4；独立 `HC_SESSION=shep-p0`、`HC_SOCKET=\\.\pipe\shepherdr-p0-8f3a2c`，XDG 变量全部隔离。Bun 1.4.2 未验证，暂不改 pin。
- raw 9 字节帧握手与 RPC：32 methods，19 REQUIRED 全部存在；doc/file/machine.exec/terminal/events/attach/resize/interrupt 手工探针通过（执行者报告）。
- 真实仓库 `CoreClient.open(pipe)` 与 `CoreClient.endpoint({binary, session, socket})`：status、subscribe、run、attach、resize、close、kill、rm 成功；直接管道和 hc connect 可行。
- `hc server restart`：core PID 13688 → 22288，holder PID 34628 不变，程序 TICK 由 3..7 延续到 10..14，仍 live。
- `hc server stop`：core/holder/程序均结束；下次 start 的 keep 终端显示 live，但运行的是新 shell，旧程序未重跑。**Shepherdr stop 必须只停止应用，不能调用 hc server stop，也不需要重启 core。**
- 执行者报告最终 core/探针进程及独立管道全部清理。未运行真实 agent，未修改真实用户状态或安装 PATH。
- 决策：P1 优先直接命名管道以复用 CoreClient；保留现有 hc connect 传输。不需要新 PTY 实现。真实服务、安全边界和 agent 闭环仍未验证。

## T0 收口（2026-11-03）

- T0：DONE。主会话已复核 P0 canonical 证据并将 direct pipe、generation/method 门禁、以及不得用 `hc server stop`/`hc server restart` 停止 Shepherdr 的生命周期约束写入 design/tasks。
- T0 只证明官方 core 与现有 CoreClient 的隔离协议/生命周期可行性；AC-WIN-02/03 的 Shepherdr 应用验收仍由 T2 承担，AC-WIN-04 的私有 home/operator 安全仍未通过。
- T1：IN PROGRESS，唯一 writer 为 workflow-implementer session `ses_e5fc72a9dffeVWbfptIvUA48iq`；其文件边界见 tasks.md T1。测试与构建尚未在本机执行。
- T1 workflow-implementer session `ses_e5fc72a9dffeVWbfptIvUA48iq` 首次执行与一次续接均因 `Response still truncated after two output token limit continuations` 中断。主会话核对仅新增 `server/core/windows-security.ts` 与 `helper/core-windows.ps1`，尚未接入既有调用点或新增测试，不能算完成。fixer session `ses_e5fb6e5b0ffeMAD8IL5D3070Rh` 接手后因用户要求暂停而取消，未核实其有任何代码写入。用户随后要求继续；当前唯一 writer 为 fixer session `ses_e5fab8650ffeb34hckh9cYJgNM`，负责先审计草稿 ACL/TOCTOU，再按 D1 实施或报告明确阻塞，不放宽要求。此前基线 typecheck 不覆盖这些新增代码。

## T1 返回与主会话核验（2026-11-03）

- fixer `ses_e5fab8650ffeb34hckh9cYJgNM` 已返回。主会话读取全部新增 helper/adapter/Windows 测试及五个既有文件的 diff，确认修改均在 T1 允许范围。home、凭据、SQLite、vault 已有 Windows 接入，不再是只有草稿；不等于安全通过。
- 主会话执行 `git diff --check`：PASS；`bun run typecheck`：PASS，输出 `$ bun scripts/build-plugins.ts && tsc --noEmit`，无类型错误。没有执行测试、完整构建或浏览器验证；Windows 用例仍为 `NOT RUN（本机禁止；待 CI）`。
- T1 暂不标记 done，T2 未放行。待核对 `FILE_RENAME_INFO.RootDirectory` 的 Win32 支持约束、私有目录 inherit-only ACE 对 SQLite journal 等继承文件的影响，以及 deny/真实竞态用例是否足够。
- 聚焦技术升级：oracle `ses_e5f9820b8ffe4XjLyBXTqLlsUK`，只读上述具体 API/设计疑点，无 writer 权限、不得运行测试；这不是全量交付审查，不消费或替代 T7 的单次独立审查。实际模型未观察。结果已返回：Microsoft FILE_RENAME_INFO 契约支持相对名称配非空 RootDirectory，不能据此认定写入失败；实际 Windows 发布仍未验证。
- 确认的实现缺陷：私有目录提前跳过 inherit-only ACE，可接受 foreign `OIIO` 子文件继承授权。SQLite 主文件的显式 DACL 不能证明 journal 等另建子文件私有；具体 Bun journal 行为尚待 Windows 证据。必须在 private 检查中验证 inherit-only trustee/deny/unknown，且不计入有效 owner full-control。
- 测试缺陷与证据纠正：Users Read deny 可能在句柄打开时就得到 `EACCES`，而非描述符的 deny-ACE 文案。已有静态 junction/hardlink/sharing 用例不等于同步 TOCTOU 测试；此前 worker 的 unknown-ACE/TOCTOU 覆盖声明未获源码支持。fixture temp 祖先是否满足安全要求仍是环境门禁，不能通过只保护 leaf 绕过。
- 同一 fixer `ses_e5fab8650ffeb34hckh9cYJgNM` 已续接作限定修正：ACL 继承回归、deny 分层诊断、实际 journal 检查，以及可可靠实现的 unknown-ACE/同步竞争用例；不得虚报未覆盖项。主会话仍拥有验证与文档，T1 未完成，T2 未放行。
- 该轮返回后主会话核对：`Assert-Descriptor` 已在 private 分支验证 inherit-only trustee/deny，不再使其满足有效 full-control；新增 foreign OIIO、独立 EACCES 和未提交 SQLite journal trustee 用例。unknown ACE 采用描述符级 seam，非安装在真实对象上的未知 ACE；同步竞争尚未覆盖，worker 已纠正声明。所有用例仍 NOT RUN。
- 主会话发现新测试的 SID `GetBinaryForm()` 无参调用不符合 .NET 签名，已交回同一 fixer 改为 byte[]/offset，并补同生产链/句柄函数的 ready/continue 确定性竞争 seam（需有界等待、finally 释放）。本轮只补该已批准测试接缝，不扩大平台范围。完成后按 T1 编码门禁审阅释放 T2；CI、安全实证与 AC 验收不随之通过。
- fixer 返回后主会话读取 SID fixture、`holdFile`、stdout 行读取及并发替换测试。seam 使用生产打开/验证函数，ready 后另一进程尝试文件/祖先重命名、hardlink、写入，continue 后核对同一 identity。测试只覆盖句柄持有期间的共享保护，不证明打开前窗口或跨账户，实际运行 NOT RUN。主会话额外加固 attempt：进程启动失败/超时/非零直接失败，PowerShell terminating-error 捕获且必须显式 `REFUSED:`，避免“没有 SUCCEEDED”把未执行误判为保护成功。
- 最终本轮主会话 `git diff --check` PASS、`bun run typecheck` PASS（build-plugins + tsc --noEmit）。T1 标记 code_complete / OS verification pending，按 tasks 的编码/验收分离规则释放 T2 编码依赖；AC-WIN-04 与 Windows 支持声明仍未通过。CI 须设置足够的真实 Windows helper 用例超时，不能以超时 skip 代替。
- T2 前置只读调查已委派 explorer `ses_e5f8a1bb0ffegNoPHXwegsNrFH`：定位 Bun node:net 与同一持有管道句柄 ACL/peer 校验的实现接缝；若既定 direct-pipe 决策无法满足安全要求，报告具体阻塞及最小设计修订，不暗改传输、不采用路径 preflight 后不安全重连。结果 PENDING；尚无 T2 writer。
- 该调查现已返回：既有 `CoreClient.open(string)` 的 `node:net.connect` 无公开 Windows HANDLE，路径预检后重连不能满足同连接身份保证。建议固定 helper 持有并验证实际 pipe 后转发 framed bytes，但与 D2 原“不引入本机 subprocess”冲突；调查中官方文档访问失败，API 可用性与 PowerShell 5.1/.NET Framework 差异尚待确认，不能把建议写成已证实能力。
- 已将此冲突交 oracle `ses_e5f9820b8ffe4XjLyBXTqLlsUK` 聚焦裁定最小安全设计修订（不是 T7 交付审查）；未放行管道 writer。独立 T2a 入口/显式端点配置交 fixer `ses_e5f83411dffeQFx2j4tBSb9OlW`，文件所有权见 tasks；不依赖待定管道实现、不改真实状态。T2a 结果 PENDING；D2 仍待裁定，AC 未通过。
- T2a 初版返回后，主会话读取共享 dispatcher、新 CLI 测试、CMD wrapper 与 config diff：显式 Windows pipe 保持原始名称、不猜默认、不继承显式其他 session 的 HC_SOCKET；现有 POSIX 解析保留。主会话 `git diff --check` PASS（Git 提示本机换行转换，不是验证失败）、`bun run typecheck` PASS。TS runner fixture 不代表真实 CMD 引号/stdin 证明；发现 `status ""` 与原 shell 空字符串分支不等价，已交同一 fixer 修正并增加跨 CMD 的临时 checkout fixture 用例（只写测试，NOT RUN）。同时显式禁用 wrapper delayed expansion；完整 shell 特殊字符支持不由 `%*` 注释推断。当前 focused correction PENDING，T2a 未验收，管道方案仍待 oracle 返回。

## T2a 修正回读与 T2b 分发（2026-11-03）

- T2a 同一 fixer 已返回。主会话读取 `helper/core-entry.ts` 与 `test/core-windows-cli.test.ts:197-293`：显式空参数路由已修复；新增 Windows-only 真实 CMD → 原 wrapper → 原 dispatcher → 临时 fixture target 的五条路径，断言 argv、Unicode 多行 stdin 与退出码 23，无真实服务或账户。wrapper 禁用 delayed expansion。该批没有运行命令；最终 typecheck 留待与 T2b 合并后的批次。所有测试仍 NOT RUN；Windows CI 尚未配置，现有 Ubuntu runner 会跳过此 E2E，不能宣称命令行实证通过。
- 明确剩余缺口：测试覆盖空格、中文、单引号、空参数、反斜杠及 `/v:off` 下的叹号；未覆盖嵌入双引号、PowerShell 调用，外层 `/v:on` 在进入 wrapper 前吞掉的叹号不由 wrapper 修复。无完整任意 shell 字符保真承诺；这些缺口须在 T6/T7 证据中保留，不以 TS seam 代替。
- oracle 详细诊断已消费；main 已将 D2 修订为固定 helper 验证、持有并 relay 同一实际 pipe。保留 CoreClient/CoreSession string 与 framed 协议，remote hc connect 不变，无运行时 fallback。理由是 Bun 的公开连接 API 不能提供同句柄 peer/DACL 证明。新增同 SID/session、非提权 medium-integrity 的明确支持限制；文件/pipe 不混用安全对象类型与权限 mask。
- T2b 已交 fixer `ses_e5f745f3bffe2i8RW13fmAx8Gs`，仅 client broker/helper/适配器及窄测试，边界见 tasks。尚未返回，不宣称编译或运行成功。Framework API、真实 hc DACL、server-PID 查询、READY/binary fidelity/背压、EOF/取消/父死亡清理均 UNVERIFIED。诊断是参考源代码/API 研究，不是 Windows 实验，也不消费 T7 独立交付审查预算。

## 用户纠正后的子代理续接（2026-11-03）

- 主会话曾误解为 Herdr 整个协调会话接管，创建 win-native-next / wJ:pM；用户随后明确只要求 omo-slim 新子代理续接原工作。整会话交接已撤回，`artifacts/handoff.md` 顶部已标历史失效；主会话继续拥有调度/记录/验收。
- 旧 T2b writer `ses_e5f745f3bffe2i8RW13fmAx8Gs` 已 cancelled 且终态确认，未回滚部分代码。取消后 `git diff --check` PASS（换行警告），存在新的 windows-pipe.ts 与 pipe tests 及 client 修改；实现未读核、未 typecheck 或测试。
- Herdr 重查 win-native-next 返回 agent_not_found，wJ:pM 返回 pane_not_found，agent list 已无该接管者；任务诊断显示已跟踪原 writer 为 cancelled、其余既有任务 completed，未发现活动交接 writer。不猜测窗口为何消失，不停止其他用户 pane。
- 已使用 omo-slim subagent 新建 bounded fixer `ses_e5f557aaeffef55rik7bE0t4gH`（fix-5），只续接 T2b 同一文件范围，先审实际部分 diff 再补缺；禁止接管全部协调、递归委派或创建 Herdr pane。保持所有安全门禁与本机测试禁令。结果 PENDING，当前无新增验证通过声明。

## T2b 返回后的主会话源码核查（2026-11-03）

- fix-5 已返回初版补缺：token elevation/integrity gate、READY 前父进程句柄、refusal/transient 退出码、CoreError refused 映射、EOF/取消用例。代理报告 PS5.1 ParseInput 与 helper C# Add-Type 编译成功、当前 token medium/non-elevated；这些为代理提供的有限证据，尚非主会话独立 runtime 验证，更不是完整应用验收。
- 主会话已读 `server/core/windows-pipe.ts` 全文件、`helper/core-windows.ps1` 的 C# pipe 模式、`test/core-windows-pipe.test.ts` 全文件并核对 design D2。发现退出码 0 时 reader.cancel 丢弃排队 stdout 的尾部风险、stdout EOF 但 helper 未退出的释放缺口，以及 dead-parent 测试在非 medium runner 会先触发 token 拒绝导致错误断言。已交回同 fix-5 一轮聚焦修正，要求确定性的背压/尾字节与清理回归，不放宽 ACL/token 门禁。
- 正向真实 pipe 用例以普通 token 为前提；在高完整性 runner skip 不能计为 AC-WIN-04 或 relay 验收 PASS。T6 必须准备实际普通 token 必跑路径或明确保持未验收；本轮不自行改变 D2，也未触发远端 CI。
- T2b 当前为 focused correction in progress，批次 typecheck 待修正返回后由主会话执行；所有本机 bun 测试/完整 build/check/browser NOT RUN。T2c 仅只读接缝调查已交 exp-5 `ses_e5f3d0defffeGEYNDieHjkA4r1`；尚未放行下一个 writer，共享 helper 无并发写。

## T2c 只读接缝调查（2026-11-03）

- 停止实现必须先回复再 drain：operator stop handler 写回 `{code:0}` 并结束连接，再等待可能很长的 `source.drain()`；不能让客户端等待 drain 后才收到回执。
- Windows stop 必须重新读取并锁定 `run.json` 的 boot 身份，连接后再次核对；绝不回退到 PID。`run.json.pid` 仅健康身份，不得在 Windows stop 中发送信号；helper PID 不等于应用 PID。
- `status` 不得创建 home 或触发 `ensureCore`；未知 owner/身份不明的锁和 live PID 必须拒绝清理或停止。Windows app stop 只 drain 自身，core/holder/agents 保留；超时返回 `finishing`，不强杀。
- 建议顺序：纯 frame codec（4-byte LE + JSON，512 KiB）→共享 operator handler 可选 boot/stop 校验→launcher Windows stop 分支→main 单一幂等 shutdown→Windows operator helper 启动/READY/处置→client Windows branch→真实 DACL/peer/first-instance/remote reject 与 lifecycle CI。POSIX operator/socket 测试保持平台保护。
- 风险：operator in-flight connection 必须允许回执 flush；READY 后写 run record 存在竞态但无 record 应拒绝；Windows PowerShell stdout READY 后只能 raw binary、日志走 stderr；旧 POSIX request 仍省略 boot/stop 时需兼容。

## T2b 修正批次收口与 T2c1 分发（2026-11-03）

- 主会话读核 EOF-driven pump/finish 与回归测试：48 KiB READY 尾部超过 stream high-water mark、排队块后退出、stdout EOF 无 exit、dispose 幂等、真实父进程在 READY 后死亡。测试是已编写、NOT RUN，不把读源码当运行成功。
- 本次首次 `bun run typecheck` FAIL，实际为 7 条 diagnostics（先前回复误称 6）：windows-pipe.ts 的 stdin.write 联合返回类型，CLI fixture env 可选 undefined，pipe test 一个隐式 any 与四处错误联合未收窄。已由同一 fixer 修正 write/flush await 背压、Record 类型与 instanceof 错误收窄。
- 修正后主会话重新运行 `bun run typecheck` PASS：`bun scripts/build-plugins.ts && tsc --noEmit`，无类型错误；`git diff --check` PASS，仅 bin/shepherdr 与 config.ts 换行警告。另读核 client.ts/test diff：Windows 拒绝映射 refused 保持，原 POSIX/remote/framed/schema 不改。
- T2a/T2b 为 code_complete / OS verification pending，仅释放后续编码依赖。代理报告的 PS5.1 解析及 C# 编译未由主会话重跑；真实 core DACL、同句柄 relay、普通 token 用例和应用闭环仍 UNVERIFIED。未运行测试套件、完整 build、browser 或 CI，未 push/发布。
- T2c1 已串行交同一 omo-slim fixer `ses_e5f557aaeffef55rik7bE0t4gH`：私有 operator 创建/peer/boot 身份与有界 framing。T2c2 生命周期尚未分发；不并发改 helper、不因未接 main 而提供不安全 stop fallback。

## T2c1 初版主会话核查及聚焦修正（2026-11-03）

- 初版返回后，主会话完整读取 windows-operator.ts、新增 596 行测试、helper operator 的 C#/PowerShell 块，并读核 operator.ts/helper/core-operator.ts/POSIX 测试 diff。该片未改 launcher/main/source，Windows run record 尚无 operatorPid，客户端按设计暂时拒绝，不能启动真实服务验收。
- `bun run typecheck` FAIL：windows-operator.ts:150-152 六条 stdin 可能 undefined/number 的 diagnostics；:325 一条 Buffer 泛型不匹配。随后独立 `git diff --check` PASS，仅既有换行警告。未运行测试。
- 代码核查发现真实请求错误写入 helper 标准输入而非输出（PS:1587）；READY 尾帧必须等下次 read 才处理；app channel 超时后继续复用会有旧读/旧回包错配；stop 的 pending ACK 需绑定请求；读 deadline 与同步 write 未全程有界；客户端 UTF-8 分块解码与退出/清理不完整；回复缺上限。已全部附确切位置交回同一 fixer，一轮聚焦修正，不另开 writer。
- 新增 WMI 父进程查询不属于已批准安全机制且混淆 caller/server app PID；要求移除，明确 boot 与实际服务 helper PID，以及同 SID/session/medium-integrity 的现有边界。创建端也需验证自身 token，不以高完整性 READY 作为成功。
- 代理报告 PS/C# 静态检查使用过 `-ExecutionPolicy Bypass`，这不作为策略兼容证据；已明确后续检查不允许该参数或全局策略更改。生产启动未带该参数，保持不带；策略阻止时应拒绝并报告。主会话未复跑该静态命令。
- 当前状态：T2c1 focused correction in progress，T2c2 未放行。T2b 先前类型通过仍属其批次历史，不能据此推断当前工作区通过。所有 Windows OS 行为、测试与完整应用验收仍 NOT RUN / UNVERIFIED。

### T2c1 修正版读核

- 修正版主会话 `bun run typecheck` PASS，`git diff --check` PASS（仅既有换行警告）。标准流方向、READY 尾帧、UTF-8 累积、非零退出拒绝、ABANDON 清 pendingStop、移除 WMI 和创建端 token 门均已读核。测试依旧 NOT RUN。
- 仍需收口：Win32 WriteFile 完成不代表接收完成，DisconnectNamedPipe 会丢弃未读数据；要求客户端读取后经同 pipe 明确确认，再发 app ACK。无确认则 ABANDON，禁止无界 FlushFileBuffers。
- 同步写超时的背景线程与裸 handle 必须共同终止；不能 CloseHandle 后继续使用或由 PowerShell finally 二次关闭。允许 owned helper 在该异常路径直接非零退出，以 OS 进程回收终止 I/O，禁止复用失败通道。
- app answer/send 需整体有界并在失败后终止通道，避免 vault 未完成使 TS 无法处理 helper EOF；迟到回复不得跨请求写入。三项收尾继续由同一 fixer 在原 T2c1 scope 实施，T2c2 仍未放行。

### T2c1 收口、T2c2 编码依赖释放

- 主会话完整读核当前 windows-operator.ts、重写后的 core-windows-operator.test.ts（实际读取 1082 行）、helper 的写超时及 server/client 回执块。代理曾批量改写测试文件造成行拼接/编码损坏，已重写；该文件按全新文件核查，不能以旧版本的读核代替。当前有启动/帧边界、ABANDON、永不完成/迟到结果、UTF-8/非零退出、真实 pipe 与超时用例；全部 NOT RUN。
- 收口返回后的主会话 `bun run typecheck` PASS。背景同步写超时直接退出 owned helper，避免关闭后裸 handle 复用；成功 reply 后等待同 pipe 固定 received 确认，失败发 ABANDON；这两条实现已读核，真实 Win32 行为仍 UNVERIFIED。
- 主会话进一步修正两个小缺陷：PowerShell 客户端 receipt 原错把 NamedPipeClientStream 传给仅接 IntPtr 的 OperatorWrite，改用 FrameWrite(Stream, bytes)；TS deadline 从只覆盖 answer 改为覆盖 answer+send，两者超时均关闭通道且迟到结果不写。上述两处补正后的下一次类型批次归 T2c2 reconciliation，不引用补正前类型结果冒充补正后结果。
- 已向同一 omo-slim fixer 串行分发 T2c2：run/operatorPid、私有 lock/record/log、只读 status、实例核验后的 stop、唯一 drain、caller helper 父死亡清理及对应测试。T2c1 只释放编码依赖；AC-WIN-03/04、真实 stop 保留 core/holder/原程序、普通 token 下实际 pipe 安全均待 CI/真实验收。

### T2c2 初版核查：未通过，集中修正中

- 主会话读取 launcher.ts、main.ts、windows-operator.ts 的 shared ask、新增 launcher/lifecycle 测试及 helper 删除/watch 接缝。`bun run typecheck` FAIL：`test/core-windows-lifecycle.test.ts(127,107): error TS2353: Object literal may only specify known properties, and 'encoding' does not exist in type 'SpawnSyncOptions<"ignore", "pipe", "pipe">'.` 未运行测试、构建或真实 hc。
- 必现动态调用缺陷：helper C# `static void WatchParent(int parentPid)` 是 private，但 PowerShell operatorClient 外部调用 `[ShepPipe]::WatchParent(...)`；C# 编译成功不能证明此运行时绑定有效。已要求开放窄 public 方法并核对同类绑定。
- 生命周期仍需修正：老的无 owner 锁可能在创建者暂停时被删；kill-0 的 EPERM/未知错误被当成死亡；Windows 损坏 core.json 被吞成 absent；就绪轮询吞安全错误；spawn 同步抛错时日志 FD 未必释放；统一 shutdown 的 cleanup 抛错需要收口并保留诊断/记录。
- 真实生命周期 fixture 当前不能作为证据：Bun 错执行 POSIX shell 入口、缺显式 pipe、固定 session/port 并继承真实 XDG/core 环境、缺 owned 进程清理，也没核对 core PID/holder PID/原程序连续输出。Windows 普通测试 home/unsafe lock fixture 依赖继承 ACL 假设，需明确构造。已禁止运行此初版 fixture，并要求隔离、正确入口/参数、有界等待/finally 与真实保留证据。
- 已向同一 fixer 集中发回上述修正及阻塞/失败 drain、重复 stop 的关键验证义务；T3 尚未放行。代理所报前台 start 长期持锁并非现源码行为：runCoreServer 在 setup 完成后返回，withLock 随即释放，不为此添加新机制。

### T2c2 修正版再次核查：仍未通过

- 主会话重读 main.ts、launcher.ts、完整 core-windows-lifecycle.test.ts 与 core-launcher.test.ts。修正版已把 ownerless 锁保留、仅 ESRCH 判死、损坏保存配置拒绝、spawn 日志 FD finally 释放、统一 shutdown 失败保留记录及对应测试接入。行为测试仍 NOT RUN。
- 主会话 `bun run typecheck` FAIL（三条）：`server/core/main.ts(90,18): error TS2322: Type 'Promise<boolean>' is not assignable to type 'Promise<void>'.`；`test/core-windows-lifecycle.test.ts(239,9): error TS2304: Cannot find name 'started'.`；`test/core-windows-lifecycle.test.ts(239,35): error TS2304: Cannot find name 'started'.` 源码核对 source.ts:867 / tasks.ts:590 表明 drain 的 boolean 仅表示曾等待工作，不是成功标记；可 await 后丢弃返回值，不能据此拒绝正常停止。
- fixture 仍有具体缺陷，已集中退回同一 writer：CLI 流字节上限不等于时间有界；finally 尚未清理刚启动的隔离 hc 就删除它的状态；CLI 启动失败后可能遗留已发布 app。允许仅 fixture finally 用唯一 session/pipe/隔离 XDG 环境清理其 owned core；production stop 禁止停止 core 的约束不变。
- 原有 machines 测试被 prepareHome 提前写 marker 后改变 empty-home 语义，应恢复空目录阶段；Unix 默认 socket 测试在 Windows 必须明确平台限定，Windows 端点规则由专用配置测试覆盖。等待本轮类型/fixture 收口后才释放 T3。

### T2c2 编码依赖收口，T3 开始

- 主会话读核本轮实际 main.ts drain 适配、Unix empty-home/默认 socket 测试修正、完整 lifecycle fixture 命令与清理段；`bun run typecheck` PASS。固定 helper 动态绑定、普通 token pipe、真实 server start/stop 以及所有测试依然 NOT RUN / UNVERIFIED，类型通过不构成 AC-WIN-03/04 验收。
- 主会话随后修小的 fixture 尾项：超时先 abort/cancel stdout/stderr readers，再 kill owned CLI 并对 reap 再设 2 秒期限，避免继承 pipe 的子进程使读取永远不结束；timeout 不返回成功退出码。隔离 core 的 finally stop 失败时保留其临时状态并打印路径，不删除活 core 状态。此补正后的类型验证随下一批进行，不冒用补正前结果。
- 真 core fixture 现在隔离 home/session/pipe/XDG 并使用真实 TypeScript 入口；只断言 app stop 后 core 端点仍可连。core PID、holder PID、原程序连续输出与真实 agent 完整闭环仍是 T6/T7 明确待补证据，未计为通过。
- T2 标 code_complete / OS verification pending，只释放 T3 编码依赖。已向同一 omo-slim fixer 分发 T3：agent native argv/PATH/hooks/权限失败拒绝，以及 Windows 本机 Autopilot 各入口无副作用拒绝；不改 T2 共享安全/生命周期文件。主会话独占上述 fixture 小补正和 OpenSpec 记录。

### T3 初版核查：普通 agent 目标仍未完成

- 主会话读核 agent-platform.ts、agents.ts、core-hook.ts、pilot-lifecycle.ts 的进入路径、新 core-windows-agents.test.ts 与已有 agent/pilot/own-command 测试差异。新增平台 delimiter/env-key 规则及本机 Autopilot start/restart 门已接入；当前 hookCommand 对 Windows 的 Claude/Codex 全部拒绝，只是临时安全边界，不是 AC-WIN-05 实现完成。
- 主会话 `bun run typecheck` FAIL：`test/core-windows-agents.test.ts(83,42): error TS2339: Property 'hook' does not exist on type '{}'.` 已交同一 fixer 修类型及 Windows fixture 私有 home/明确 unsafe ACL/credential 正向对照，避免因先前凭据失败产生 hook-deny 假阳性。新旧测试一律 NOT RUN。
- 单独分发只读 explorer ses_e5e80bceeffeVf6txx5OgTbobL 核实 Claude/Codex 官方 Windows hook 执行 shell、发行版本和精确参数编码，争取实现至少一个普通 Windows provider；不能以缺少真实账号为由把所有启动永久拒绝并称完成。没有真实闭环时仍不得授予支持声明。
- T2 fixture 清理的小补正也包含在本次类型编译中，未出现该文件类型诊断；整次类型检查仍因上述 T3 错误失败，记录不写成整体 PASS。T3 尚在修正，T4/T5 未放行。

### T3 测试修正后类型检查

- fixer 返回后，主会话重新读取 `test/core-windows-agents.test.ts` 全文、`test/core-agents.test.ts` 的 fixture/非 launch 用例，以及 `server/core/store.ts` 的 prepareHome 调用，确认改为不存在的 home 叶子、泛型 CoreAgent 收窄和 credential 可读正向对照。hook 文件不安全性由 verifyPrivateFile 的实际拒绝断言约束；尚未执行该 OS 测试，不把继承 DACL 描述当跨账户替换实证。
- 主会话 `bun run typecheck` PASS（build-plugins + tsc --noEmit）；`git diff --check` PASS，仅 bin/shepherdr、server/core/config.ts、server/core/main.ts 的既有 LF/CRLF 提示。包含 T2 fixture 的主会话小补正。
- Windows provider 启动仍为临时拒绝，T3 保持 in_progress。官方 hook shell 调查仍待返回；本轮没有运行测试、启动真实 agent 或修改其账号/信任，不将类型通过升级为 AC-WIN-05 通过。

### 2026-11-04 续步

- 用户要求继续；原 provider hook 调查任务仍 running，已发消息要求收窄到最小 provider 的官方 shell/参数结论，网络阻塞时立即返回事实与局限，不扩散调查。
- 并行委派只读 explorer `ses_e5d5c6098ffeFLRVvvxhpsF098` 核对 T5 附件/产物最小实现接缝：真实 local Windows 与 remote POSIX 路由、inline eval/import、32 MiB 与现有 helper UTF8/大小上限、合法 repo 与私有 stage 的权限区别、是否需要共享 helper 扩展。本次只准备独立编码范围，不宣布 T5 编码依赖或 OS 验收通过。

### T5 独立编码释放

- 只读调查返回后，主会话核对 artifacts.ts:77-127 的普通读取/导出与 pilot 分支；确认 T5 可仅依赖已审的 agentHost/route 接口，不依赖 provider hook 的 shell 决策。T3 保持 in_progress，T5 单独释放编码依赖。
- 唯一 writer fixer `ses_e5d55a849ffeknFZXyqbhfj2KQ` 获准修改 chat/artifacts、相应测试，以及串行扩展共享 windows-security.ts/core-windows.ps1 的窄文件 I/O。其他 writer 不得同时改共享 helper；main 负责代码与类型核查。
- 决定：旧 readPrivateFile 仍返回 UTF8、默认 16 MiB；新增受限 binary 接口支持 32 MiB 附件与足够的 base64 stdout 缓冲。一次性约 130 MiB 瞬时内存可接受，暂不引入分片框架。Windows export 使用已保护 home 内的 exports 子目录，exclusive 发布不覆盖。
- 普通 repo 不套私有 DACL，但必须持有无 share-delete 的只读祖先句柄链，逐层拒绝 reparse、同叶子句柄读取并重验 links/identity/size；不接受仅 FinalPath 预检后重开的简化。敏感根排除必须覆盖实际 canonical 路径；合法不同本地卷路径不能一概拒绝。原 private ancestor 规则不放宽，调查中关于默认根目录 ACL 可能不兼容的推测尚未实证。
- 所有 T5 测试 NOT RUN；CI/真实设备验收未执行，也未触发远端检查。

### T5 初版读核与集中修正

- writer 返回后，主会话读核 windows-security.ts、新 transfers 测试全文、chat/artifacts diff、原有 chat/artifacts 测试 diff，以及 helper 的 raw path/PlainChain/PlainFile/ReadPlainFile 块。普通读取持有祖先与叶子句柄、返回同句柄 canonical 路径；私有读保留 16 MiB 默认并新增 32 MiB binary 上限。共享 helper 另改 operator 的 PowerShell `$input` 自动变量名、AceFlags 整数运算与规范化前路径拒绝；代理手探针/编译报告不替代主会话的行为验证。
- 主会话 `bun run typecheck` FAIL：`server/core/chat.ts(81,31): error TS2322: Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BlobPart'.`；`git diff --check` PASS（既有 LF/CRLF 提示）。未跑本机 tests/build/check/browser/真实应用。
- 交同一 T5 writer 一轮集中修正：Blob 类型；route 错误传播与合法 remote fixture；卷根比较错误（`C:\` 对 `C:` 恒不等）和缺第二卷的显式未验证；PowerShell 单引号字面量取代 JSON.stringify 的错误 shell 转义；恢复 POSIX symlink 创建失败断言，仅确切 Windows 权限缺失可记未验证；完整 32 MiB 字节校验与中文/空格路径报告解析。T5 仍 in_progress。
- 旧双 provider hook 调查长时间没有终态，已取消 `ses_e5e80bceeffeVf6txx5OgTbobL`，改派有界 Claude-only 官方来源调查 `ses_e5cc5d891ffeaTAW6vGH66V5MS`，要求有限来源调用，网络阻塞立即返回事实与 unknown；没有给 T5 writer 并发修改 T3 文件的权限。

### T3 Claude exec hooks 路线

- 有界调查已返回；主会话独立读取官方 https://code.claude.com/docs/en/hooks，确认 exec form 的 `command` + `args` 不经过 shell，Windows 必须真实 exe；shell form 默认 Git Bash，缺失时 PowerShell，不能按 CMD 规则统一编码。`onFailure: "block"` 文档要求 >=2.1.295。尚未独立核查 changelog 的引入版本，exec form 最早版本仍 unknown。
- 保守实现下限暂定 Claude Code >=2.1.317（调查时官方 changelog 顶部版本）；低版、缺失、无法检测、只有 shim 均在创建 launch/grant/terminal 前拒绝。这不是旧版本不支持的实证，也不代表真实 provider 闭环已通过。
- T3 原 fixer `ses_e5f557aaeffef55rik7bE0t4gH` 继续仅处理 agent 平台、生成配置/指令、hook 与 T3 测试。共享 helper/security/chat/artifacts 仍由 T5 writer 独占；T3 只调用既有私有 I/O API。Windows 未核实的精确自动批准规则不生成，正常 permission flow 保留；Autopilot 拒绝与 Codex 临时限制不变。本轮尚无新类型/OS 验证。

### T5 修正版读核与类型通过

- 主会话重新读取 transfers 测试全文及 chat/artifacts/原 artifact 测试 diff，核对 route 拒绝传播、真实 remote fixture、PowerShell 单引号、卷根比较、完整 32 MiB 字节对照、带中文空格路径。POSIX symlink 创建失败仍抛出，仅 Windows EPERM 记录未验证；第二可写卷缺失同样明确 UNVERIFIED。
- 主会话 `bun run typecheck` PASS；没有运行任何测试、分支探针、真实 core/provider 或构建。T5 仅 code_complete，不代表 AC-WIN-06 已验收，共享 helper 写权限已释放。
- 此后 main 为 Windows upload 补充原始文件名拒绝（路径分隔符、ADS/非法字符、尾随点空格、保留设备名），在文件操作前拒绝，避免 basename 静默改写危险名字；新增零 I/O 回归断言，待下一批 typecheck。POSIX 原有清理行为保留。
- T4 已派只读调查 `ses_e5cc0b7c0ffev2Cx6kHqHlifLr`，等待明确普通 repo/private stage 与同卷安全发布接缝后再分配 writer；不与 T3 的 agent 文件并发写。

### T4 编码释放及跨片 import 闭包

- T4 调查已返回。该代理违反只读/不执行任务边界，自报在系统临时目录运行了 Bun/Git/路径行为探针；主会话不重复这些探针，其行为结论不作为验收证据，仍记 UNVERIFIED。仅源码问题作为实施线索：porcelain 路径字符串匹配会漏掉 Windows worktree，includes 使用 Unix 权限/硬链，wire 路径缺少 Windows 名字边界，review 日志权限判断不适用 Windows。
- 已分配 T4 caller writer `ses_e5c837be2ffetqdWOf5kYAv8Xo`，仅 tasks/git/worktree/includes/review 与相应测试；安全 helper 独占 writer 为 `ses_e5d55a849ffeknFZXyqbhfj2KQ`，只补普通目标目录同句柄 no-replace 发布和有界文件前缀读取。前者不改 helper，后者不改 caller；T3 agent writer 写范围保持独立。所有新代码和测试均不得在本机执行，后续由 main 统一 typecheck。
- 已定接口：`publishPlainFile(directory: string, leaf: string, bytes: Uint8Array): void`，普通继承 ACL、目标目录内临时对象、16 MiB、同句柄完整写后 no-replace rename；`readPlainFileHead(path: string, max: number): { path: string; bytes: Buffer; size: number }`，读取前缀最多 1,000,000 字节并返回原始大小，保留大文件预览语义。普通 checkout 不施加 private DACL，private stage 不硬链进 checkout。
- 主会话独立读核 remote 的静态依赖：home 引入 windows-security，client 引入 windows-pipe，后者引入 config。已将这三个 TypeScript 模块加入 remote PARTS；平台门控保持远端 POSIX，不增加远端 Windows 支持。import 闭包测试统一将 relative 结果的反斜杠转成仓库的 `/`，避免 Windows 噪声；T3/T4 完成后还需核对新增依赖。未运行该测试或 CI，类型检查待 writer 汇合。

### T3 Claude 接入初版读核与 T6 文档准备

- 主会话已全读 agent-platform、Windows agent 测试及 agents 的启动主体。Windows 使用真实绝对 claude.exe、exec-form Bun hook、私有 launch 文件和 `.cmd` 产品命令；Codex 与本机 Autopilot 仍拒绝。没有真实 provider/权限/重连证据，不把代理的“闭环完成”表述当验收。
- 找到版本预检缺陷：stdout 包含合法版本时，原 windowsClaude 会忽略非零退出、信号或 timeout 并接受。已交原 writer `ses_e5f557aaeffef55rik7bE0t4gH` 聚焦修正，补充失败同时打印合法版本的 portable/launch 零副作用回归；同时删去 2.1.317 已被官方版本证实的错误注释。T3 仍 in_progress，类型核查待各 writer 汇合。
- 主会话新增 docs/core/windows.md 并在 docs/core/start.md 增加入口，明确实验状态、普通用户/x64/显式 pipe、隔离环境、private home、只停应用、Codex/Autopilot 拒绝和真实证据缺口。没有修改 README、系统 PATH、真实状态、信任、Tailscale 或发布配置。
- T6 仅只读 CI 可行性调查已分发 `ses_e5c7fe905ffeTJY2JWETo2sP3X`：重点是真正普通 medium token 必跑 Windows 安全/生命周期门禁，不允许通过 elevated skip 伪装通过。尚未编写或触发 Windows CI，未运行任何本机测试或构建。

### T3 探针修正读核及生命周期证据准备

- 主会话读核 agent-platform.ts 的失败优先判定，以及 Windows agent 测试中非零退出/信号/timeout 各自携带合法版本 stdout 的 portable 和 launch 零副作用矩阵。现在失败结果不会进入版本解析；版本下限注释已改为保守配置而非已验证能力。T3 仅 code_complete，统一 typecheck 待其他 writer 汇合，所有行为测试仍 NOT RUN。
- 主会话只读重核 P0 既有 probe-holder.ts/report.json，确认已有 `server.status` 的 core pid/holder pid+instance、`terminal.run` 和 `terminal.read` 接缝；没有运行旧探针。已将 test/core-windows-lifecycle.test.ts 独占分配同 writer，补无账号 counter 程序在应用 stop/restart 前后的原 PID 与递增输出、core/holder 身份保留、重复 start 幂等断言。该测试不启动真实 Claude，不能替代 AC-WIN-05；仍禁止本机运行，后续 CI 才能取得证据。

- 生命周期增强已返回，主会话完整读核新增 helper 与真实 fixture：记录原程序 nonce/PID/递增 counter，应用停止后新连 core 并核对 core PID、holder instance/PID 和原程序连续输出；重启后检查唯一 terminal label，再重复 start 核对同 boot/PID。主会话修正两处额外假设：holder 基线在第一个 terminal 成功打印后采集（新 core 初始可无 holder），应用重启用 boot 区分而非要求新 PID 数字不同（Windows 可复用 PID）。应用与其 operator 仍须为不同的同时存活进程。所有新断言仅源码核对，typecheck 待 writer 汇合，行为 NOT RUN。

### 用户暂停后恢复 T4 / T6 准备

- 用户要求暂停时，两个 T4 writer 和 CI 只读调查均已收到 cancelled 终态；没有回滚工作区。用户随后明确继续，主会话先核对 git status 与 tasks.md，再恢复原三个 session，文件所有权与安全边界不变。
- 当前快照已有未审查的 test/core-windows-publication.test.ts，T4 caller 文件尚未在 git status 出现修改；不据暂停前任务描述推断实现完成。两个 writer 需先核对已有内容，main 等待汇合后统一读核与 typecheck。
- CI 调查限定收口已有结果，最多补两个官方页面，网络失败直接报告；没有授权或触发远端 CI，没有新增本机测试、构建、探针、真实 provider 或状态修改。

### T6 只读结论消费与 CI 编码

- 调查 `ses_e5c7fe905ffeTJY2JWETo2sP3X` 已收口：官方 GitHub runner 文档说明 Windows 为管理员且 UAC 关闭；普通层必须创建标准用户/profile，并用 GetTokenInformation 强制 SID/session/elevation/integrity，不能靠 skip。CreateProcessWithLogonW/profile/desktop、Secondary Logon 和 runner 身份仍需实际 CI 验证，未预先声称可用。
- 固定版本 manifest 与 ZIP 的版本化地址由调查读到；主会话独立 fetch `https://releases.herdr.dev/core/0.1.17/manifest.json` 失败 `getaddrinfo ENOTFOUND releases.herdr.dev`，不宣称本轮独立复核成功。ZIP/EXE SHA256 沿用已读核 P0 证据，CI 必须实际核对两个固定 hash，不使用 latest。
- 主会话独立读 check.yml、preload.ts、test.ts 与 T6 清单：发现 preload 即使 TEST_RUNNER 已设仍无条件执行 command() 并在 Windows 调用 ps，调查称“无害”不成立；已交 CI writer 修复。补清单遗漏的 core-secrets/core-windows-pipe/core-windows-operator/core-windows-publication；真实 lifecycle 多次有界 start/stop 需要显式 --timeout=240000，不能沿默认 20s。
- CI writer `ses_e5c0efbeeffefCEGg69zGjEy64` 只拥有 workflow、两个 scripts/windows CI 引导、preload 和必要 runner 平台小补正。main 拥有 Windows/develop 文档与本记录，T4 writer 所有权不变。新增 Windows 普通用户强制层与 macOS 接缝，保留 Ubuntu 原 gate；只写文件，不运行引导或触发远端。当前仍 NOT RUN。

### T4 helper 初版读核

- 主会话读核 windows-security.ts 两个命名导出、helper 发布与前缀操作以及 445 行 publication 测试。`readPlainFileHead(path, max)` 在 spawn 前限制整数 1..1,000,000，返回同句柄 canonical path / prefix / 安全整数 size；完整读取仍限 32MiB。发布通过持有的普通祖先链、独占新临时对象写入、Flush、同句柄 no-replace rename，失败只尝试删除自己持有的临时对象，不收窄普通目录 ACL。
- 尚需 focused 修正，已交同 helper writer `ses_e5d55a849ffeknFZXyqbhfj2KQ`：Users Modify fixture 未设继承标志却期望文件继承；路径/leaf 设备名正则缺 COM/LPT 的 ¹²³；两项仅打印 UNVERIFIED 的测试用 `expect(true)` 冒充 pass，改 todo；跨卷 catch 包围发布而吞掉 helper 错误，须只捕获创建目录时真正不可写，发布后所有错误传播；Flush 注释不得保证完整断电事务。
- 已通知 T4 caller 两个接口已落盘，无需 stub，文件所有权保持独立。没有运行新增 helper、测试或系统探针；本批类型核查待三个 writer 收口后统一执行。

### T4 helper focused 修正读核

- 同 writer 修正返回后，主会话独立读取 publication 测试的继承规则与跨卷错误边界，并 grep 核对 helper 两处设备名规则：Users Modify 明确设置 ContainerInherit/ObjectInherit 并回读断言，发布前后目录 SDDL 保持；跨卷仅 mkdir 的 EACCES/EPERM 可忽略，成功创建后发布/回读错误不再吞掉；缺竞争暂停点的两项改为 todo，不计 PASS。
- helper 路径与 leaf 都通过 ASCII 码点构造 ¹²³ 保留名称规则，避免 PowerShell 5.1 无 BOM 脚本代码页差异；Flush 注释已撤销完整崩溃持久性保证。主会话没有执行新增操作，OS 验证仍未完成；此接口片可供 caller 编码汇合，T4 整片尚未完成，统一 typecheck 仍待 caller/CI writer 收口。

### T3/T4/T5/T6 汇合与独立审查启动

- writer 均已返回；主会话读取 T4 生产 diff、Windows publication 测试、CI host/user 脚本、workflow 和 preload。CI writer 额外执行的静态 token/PowerShell 探针没有成为本记录的 Windows 行为验收证据。
- 主会话首次汇合 `bun run typecheck` 发现 T4 四条 TS2367：git.ts/tasks.ts 将 boolean `samePath` 与 `'same'`/`'unknown'` 比较。已改为 `pathRelation` 并移除多余 import；第二次主会话 `bun run typecheck` PASS，`git diff --check` PASS（仅既有 LF/CRLF 提示）。没有运行本机 tests/build/check/browser 测试。
- CI host ZIP SHA256 的转录遗漏已修为 `A212B69DB0EFB808882683F15E5DA45AB9606DA7BCC54B97B29ED4FA540F5491`；与 P0 记录一致。版本化 manifest 本轮网络解析失败，不能记录为已下载验证。CI 普通用户创建/profile/桌面站权限/Bun 1.4.2 与真实 core 行为仍 NOT RUN。
- T7 单次独立完整审查已委派 `ses_e5bddf03affe2f3iAPRoGsZGrq`，只读、基于现有证据，不运行测试或触发 CI。已要求核对 CoreGit 保存分支 ref 比较和 remote 静态导入闭包等主会话待处理疑点。审查结论尚未返回，所有 Windows AC 仍未最终验收，未 push/PR/触发 CI/发布。

### T7 审查取消后恢复

- 前次审查收到 cancelled 终态，没有返回可用审查结论。用户要求继续并指定 `gpt-6.1-sol`，主会话查询模型目录后以 `magpie/auto/gpt-6.1-sol` 恢复同一 reviewer session `ses_e5bddf03affe2f3iAPRoGsZGrq`，仍属于原计划的一轮审查。
- 本次恢复没有修改应用代码或新增验证结果；维持只读审查及本机测试限制。待审查返回后核对具体发现、修复并执行允许的类型检查，Windows/平台 CI 与真实 provider 仍未验收。
