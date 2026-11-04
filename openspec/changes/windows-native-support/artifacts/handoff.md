# Windows 原生适配：Herdr 新会话交接

> 已被用户 2026-11-03 后续要求取代：只使用 omo-slim 新建一个子代理续接原 T2b，不转交整个协调会话。下文关于 Herdr 新会话所有权/自主后续协调的说明仅为撤回后的历史，不再执行。主会话保留 OpenSpec、总体调度与验收所有权。误开的 `win-native-next` / `wJ:pM` 已在 Herdr 清单中不存在；原 T2b writer 已 cancelled。新 writer 只接管原 T2b 文件范围和未完工作，以下技术事实仍可参考。

<user_request>子代理交接到一个新会话中</user_request>
<user_request>现在使用的是 herdr</user_request>

前协调会话上下文与解释：本文件是给新会话的交接任务。接管既有已批准实施与后续协调，读完本文件及指定 canonical 文件后，简短确认并自主继续；不用等待前会话再次授权。先审读部分代码再补缺，不重复创建同范围 owner。

记录时间：2026-11-03。用户要求将子代理工作交接到新会话，并明确当前工具是 Herdr。

## 所有权与授权

- 接管既有已批准实施，不是重新规划或重新申请许可。目标为 Windows x64 原生 Shepherdr 服务端，连接同机同普通账户 herdr-core；用户已批准 P0–P4 实施及 OpenSpec 初始化。完整范围/AC 以本 change proposal/spec 为准。
- 仓库：`D:\my-works\herdr-plugin\shepherdr`，分支历史记录为 `windows-support`，基线 `8df9402c63ebd97ae05ed309b0444e2d755cacc6`；接管时自行只读确认现状。修改均未提交，不 reset/clean/回滚未知改动。
- 唯一 change：`openspec/changes/windows-native-support/`。先读 `proposal.md`、`design.md`、`tasks.md`、`specs/windows-runtime/spec.md`、`artifacts/context.md`、`artifacts/verification.md`；其他历史 PENDING 以这些文件后面的明确结论为准。
- 前主会话 `ses_e5ffad234ffeL3BU3hU65TXPvr`，Herdr pane `wJ:p2`；新建接管 pane `wJ:pM`，同一 cwd，未切用户焦点。接管后前主会话不再派实现 writer。
- 原 T2b writer `ses_e5f745f3bffe2i8RW13fmAx8Gs` 已明确 cancelled，取消事件已收到；仅为安全交接，全部部分修改保留。其他 writer 均已返回，没有应继续运行的写入任务。不要重放已完成调用或把取消当作代码回滚。

## 不可越过的边界

- 本机只允许 `bun run typecheck`（它包含 build-plugins）；不得 bun test/test/check/browser tests/完整 build。测试要写，执行交 CI。允许隔离手工探针不等于可运行测试套件。
- 未获 push、PR、workflow_dispatch、版本/tag/发布许可。不修改真实 home、全局 PATH、provider 登录/信任、Tailscale；不安装真实 agent。不更改 README 设计。保留 Linux/macOS/public plugin 契约和旧凭据。
- CI Bun pin 保持 1.4.2；本机 1.4.4，二者证据不可混同。Windows 本机 Autopilot 明确拒绝，不自动 WSL/无隔离 fallback。SSH/voice/shared browser/plan approval 等无首版支持承诺。
- status 只读。安全不明 fail closed，不能跳过 ACL/SID/reparse 校验；同 SID 可信、提权管理员接管不在防御边界。
- Shepherdr stop 只停止自身 main/drain，禁止 hc server stop/restart、HTTP stop 或未知 PID kill；core/holder/原程序必须保持。

## 已有结果

- T0 done。官方 hc 0.1.17/gen1 Windows x64 已在隔离目录手工探针通过；ZIP SHA256 `A212B69DB0EFB808882683F15E5DA45AB9606DA7BCC54B97B29ED4FA540F5491`。原 node:net direct pipe 与 hc connect 均完成实际 framed 协议、19 REQUIRED、terminal attach/run/resize 等。P0 不是完整应用/ACL/agent 验收。无需重跑。
- P0 发现 hc server restart 保留同一 holder/原程序连续输出；hc server stop 会杀原程序，下次 keep terminal 显示 live 也只是新 shell。因此不能以 live 标签证明保留。详情见 verification。
- T1 code_complete / OS verification pending。`helper/core-windows.ps1`、`server/core/windows-security.ts` 实现固定系统 PS5.1/.NET 文件保护，home/store/vault 已接入；已有 Windows ACL/reparse/hardlink/共享保护/journal 测试，但均 NOT RUN。多次主会话 diff --check/typecheck PASS，不是 OS 安全 PASS。
- T1 已修私有目录 inherit-only foreign ACE 绕过；仅 ancestor 可跳过 inherit-only，私有描述符仍验 trustee/deny/unknown，inherit-only 不贡献有效 full-control。unknown ACE 用 raw descriptor seam（不是安装到真实对象）；holdFile 测试只证明持有期间共享保护，不证明打开前或跨账户。不要夸大。
- T2a 源码读核完成，最后修正后的 typecheck 尚待批次：共享 `helper/core-entry.ts`、POSIX wrapper、`bin/shepherdr.cmd`；空 status 参数已修，CMD DisableDelayedExpansion；config Windows 保持 raw local pipe，只显式 --core-socket 或 eligible HC_SOCKET，显式 session 不继承错误端点，不猜默认。真实 CMD fixture 测试已写未跑，PowerShell 调用/嵌入双引号仍未覆盖，不承诺任意 shell 字符全保真。

## 立即接续：T2b 部分代码审读后补完

取消前实际出现 `server/core/windows-pipe.ts`、`test/core-windows-pipe.test.ts`，并修改 `server/core/client.ts`、`test/core-client.test.ts`；固定 PS helper 也可能已加 pipe 模式。**尚无返回报告、主会话尚未读核、不知实现完整性；禁止按文件存在标完成。** 先读上述实际源文件和 git diff，再只补缺失工作，不重造并行实现。2026-11-03 取消后 git diff --check PASS（LF/CRLF 提示），未跑新 typecheck；tracked diff stat 不含 untracked 代码。

T2b 原允许范围：`helper/core-windows.ps1`、`server/core/windows-security.ts`、`server/core/client.ts`、可新增 `server/core/windows-pipe.ts`、`test/core-windows-pipe.test.ts`、必要 `test/core-client.test.ts`。不同时写 operator/launcher/main/source/session/T2a 文件。先一个 bounded writer 收口，接管者拥有验证与 OpenSpec 更新。

### D2 已修订，勿按旧 direct-pipe 禁 subprocess 执行

- Bun node:net 不公开实际 HANDLE，预检后 Bun 重连不满足同连接身份保证。固定 helper 必须打开、验证、持有并 relay **同一个** pipe；保留 `CoreClient.open(string)`、CoreSession string 和原 framed negotiation。remote hc connect 不变；不能 fallback 裸 net/hc connect/其他 session。
- 系统 Windows PowerShell 5.1/.NET Framework 4.x；NamedPipeClientStream Asynchronous + Identification SQOS + HandleInheritability.None。Framework 无 CurrentUserOnly/FirstPipeInstance 枚举。
- handle GetSecurityInfo 用 SE_KERNEL_OBJECT=6（文件为1）；ReadWrite|Synchronize mask 0x0012019B 含 READ_CONTROL。owner 当前 SID、protected 非空 DACL、只 current/SYSTEM allow，明确 pipe rights/unknown ACE/flags/masks 拒绝，不能照搬文件 mask 或修写 hc DACL。
- GetNamedPipeServerProcessId，持有 process/token handle，TokenUser 不用 TokenOwner，前后 recheck pipe PID；双方同 SID/session、非提权 medium-integrity，无法查询拒绝。不是 executable attestation，也不抵御恶意同 SID 进程。
- READY 在验证后，控制协议有界/版本化，此后 stdout 纯 binary；父端保留同 chunk 尾部数据。C# 二进制 relay、有界缓冲/背压，禁止 PS 文本管线；bounded stderr 无秘密。启动/编译及 connect 各 deadline，健康连接无 idle timeout。
- 任一方向 EOF/error、子异常均关闭连接并释放另一 copy；dispose 仅杀 owned helper。父死亡即使 stdin 被其他子进程继承也要清理。重连属 CoreSession，不 replay uncertain write。
- oracle `ses_e5f9820b8ffe4XjLyBXTqLlsUK` 是聚焦技术诊断，不是交付 review；已查 Microsoft Framework reference source Pipe/Enums/PipeStream/PipeSecurity 及官方 GetSecurityInfo/pipe rights/PID/token 文档。**Framework 编译、实际 hc DACL、client-side PID 查询、binary/EOF/cancel/父死亡清理均 UNVERIFIED**。不得用 API 文档替代 OS 实验。

## 后续顺序与交付

- T2b 接缝可审后 T2c：私有 operator（创建即 protected DACL、first-instance、防 remote、同句柄 peer/boot）和认证 app-only stop + 唯一 drain；launcher lock/log/run/readiness。共享 helper 只一个 writer。
- 随后 T3 普通 agent/hooks/Autopilot 拒绝 → T4 worktree/includes/review 与 T5 附件产物（独立文件才并行）→ T6 Windows CI/macOS 回归/准确文档 → T7 真实证据和一次完整独立 review。tasks 含确切范围/命令。
- 编码依赖可凭可审接口继续，不能因测试只在后置 CI 执行造成循环阻塞；实际安全/支持声明仍需实证。当前无真实 agent，claude 不存在，codex 只有 npm shim；不得称完整 Windows 支持已完成。
- 实现稳定后 T7 仅一次独立 Standards/Spec review、最多一次 focused follow-up；前面的 oracle 聚焦诊断不消费该预算，不做无限审查循环。
- 若后续使用 OpenSpec CLI，须经 `C:\Users\shuan\.agents\skills\run-engineering-workflow\scripts\openspec_compat.py`，全局 node CLI 位于 `D:\Projram Files\nodejs\node_global\node_modules\@fission-ai\openspec\bin\openspec.js`。不需再次 init/change create。
