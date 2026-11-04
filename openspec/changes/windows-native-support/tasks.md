# Windows 原生支持任务

## 调度契约与状态

唯一 change：`openspec/changes/windows-native-support/`；profile：`critical`。本文件同时承载顺序与可委派上下文包，不另建任务系统。`covers` 表示本片负责的证明范围，不等于 AC 已验收。无实现、测试或构建由规划角色执行。

| ID | 范围 | covers | blocked_by | state | writer |
| --- | --- | --- | --- | --- | --- |
| T0 | P0 已返回，主会话最终复核收口 | AC-WIN-02, AC-WIN-03 | [] | done | main（已有探针协议 PASS） |
| T1 | P1 私有 home、文件与 ACL | AC-WIN-04 | [] | code_complete / OS verification pending | fixer（ses_e5fab8650ffeb34hckh9cYJgNM；主会话读核与 typecheck PASS，不代表 AC 通过） |
| T2 | P1 CLI、core 端点、operator 与安全生命周期 | AC-WIN-01, AC-WIN-02, AC-WIN-03, AC-WIN-04 | [T0, T1] | code_complete / OS verification pending（T2c2 修正版 main typecheck PASS；fixture 清理小补正待下一批类型核查） | main 验证；真实门禁转 T6/T7 |
| T3 | P2 普通 agent 闭环及本机 Autopilot 拒绝 | AC-WIN-05, AC-WIN-07 | [T2] | code_complete / typecheck PASS / OS verification pending（AC-WIN-05/07 未验收） | fixer ses_e5f557aaeffef55rik7bE0t4gH；main 已读核 Claude exec hooks 与失败探针修正；真实 provider 未验 |
| T4 | P3 worktree/includes 与 review helper | AC-WIN-06 | [T3] | code_complete / typecheck PASS / OS verification pending（held-parent 与 mid-read 竞态保持 TODO） | fixer ses_e5c837be2ffetqdWOf5kYAv8Xo；共享发布/前缀读取接口由 fixer ses_e5d55a849ffeknFZXyqbhfj2KQ 独占 helper 实施；main 验证 |
| T5 | P3 附件与产物文件路径 | AC-WIN-06 | [T3] | code_complete / typecheck PASS / OS verification pending | fixer ses_e5d55a849ffeknFZXyqbhfj2KQ；main 读核并补 Windows 文件名拒绝，AC 未验收 |
| T6 | P4 Windows CI、平台回归与支持文档 | AC-WIN-08（汇总 AC-WIN-01..07） | [T4, T5] | code_complete / typecheck PASS / remote CI pending（CI 脚本和真实 runner 行为未验） | CI fixer ses_e5c0efbeeffefCEGg69zGjEy64；main 文档与验证 |
| T7 | 真实证据、独立审查及交付收口 | AC-WIN-01..08 | [T6] | blocked（full + focused 输入覆盖完成；R1–R4 已修；R4 修后独立证据及 Windows/原平台 CI、真实 provider 验收未取得） | main；reviewer magpie/auto/gpt-6.1-sol |

每个 bounded slice 同时只有一个 writer。T4/T5 的写文件不重叠，可并行；共同的安全 helper 在 T1/T2 完成，后续片若需更改它，先由主会话串行收回该文件所有权，不并发改写。`state` 由主会话按真实证据更新；本规划不移动会话指针或标记实现完成。

`blocked_by` 区分编码依赖与验收门禁：保护接口可审阅后可继续依赖它的编码；真实 Windows 启动及支持声明仍需对应安全证据。不能因测试仅能在 CI 执行而把依赖编码和后置 CI 配置互相阻塞；主会话保留未执行证据，不能把编码完成写成 AC 通过。

所有实施 handoff 首两行必须是：

```text
Active change: openspec/changes/windows-native-support/
Assigned slice: <一个 T 编号及其范围>
Phase: implementation
Read: <下述公共必读与该片绝对路径；附该片上下文包>
Must preserve: Linux/macOS；public plugin 契约；--core-socket 与旧凭据；README 设计；真实状态/账户/信任；Windows 安全检查；Autopilot 无隔离拒绝；不发布。
```

规划 handoff 的 Assigned slice 固定为 `planning / all accepted ACs`。不得递归委派，不重跑 T0，不扫描其他 changes。每片交回实际文件列表、命令/结果、NOT RUN/UNVERIFIED 原因与回退点；证据由主会话写入本 change 的 `artifacts/verification.md`。

公共必读（每次 handoff 携带绝对路径）：

- `D:\my-works\herdr-plugin\shepherdr\AGENTS.md`
- `D:\my-works\herdr-plugin\shepherdr\docs\develop.md`
- `D:\my-works\herdr-plugin\shepherdr\docs\core\start.md`
- `D:\my-works\herdr-plugin\shepherdr\package.json`
- `D:\my-works\herdr-plugin\shepherdr\tsconfig.json`
- `D:\my-works\herdr-plugin\shepherdr\openspec\changes\windows-native-support\proposal.md`
- `D:\my-works\herdr-plugin\shepherdr\openspec\changes\windows-native-support\specs\windows-runtime\spec.md`
- `D:\my-works\herdr-plugin\shepherdr\openspec\changes\windows-native-support\design.md`
- `D:\my-works\herdr-plugin\shepherdr\openspec\changes\windows-native-support\tasks.md`
- `D:\my-works\herdr-plugin\shepherdr\openspec\changes\windows-native-support\artifacts\context.md`
- `D:\my-works\herdr-plugin\shepherdr\openspec\changes\windows-native-support\artifacts\verification.md`

规范来源快照：项目基线 `8df9402c63ebd97ae05ed309b0444e2d755cacc6`；公共参考 `C:\Users\shuan\.agents\skills\project-standards\references\common.md`（本次读取版，未取得独立 revision）。下述每片已内联适用规则，不要求 worker 重载全套技能。TS strict/ESM、TypeScript 5.9.3、CI Bun 1.4.2；P0/本机 Bun 1.4.4。Windows 1.4.2 UNVERIFIED，保持 pin，不升级。无 TypeScript 专项参考，无数据库迁移需求。

验证总规则：下面的测试命令和 `bun run build` **只在 CI 执行**；本机只允许 `bun run typecheck`，且本规划连 typecheck 也未执行。每片 RED 是待 CI 执行的预期失败，GREEN 是待 CI 观察的同一命令成功；不能倒填 RED。缺少远端执行授权时保持 `NOT RUN（待 CI；未触发）`。provider/设备的真实验收另行记 `UNVERIFIED`，不能用 fixture、demo 或测试绿替代。

## T0 — 消费既有 P0，不重新探针

- covers: [AC-WIN-02, AC-WIN-03]；blocked_by: []；state: done；writer: main。
- 已返回的 explorer session：`ses_e5fe44179ffegwgROzQneZRwBs`；本任务只收结果，不分发第二个探针。授权、复核与隔离边界见 `artifacts/verification.md:14`、`artifacts/verification.md:26`。
- AC 原文：AC-WIN-02「指定 core session 或端点并启动」→「连接所选 core，校验 generation 和所需方法；不兼容时返回可操作错误，不连接其他会话」；AC-WIN-03「重复启动、查询状态、停止或异常退出后重启」→「启动幂等、状态只读、停止执行 drain 和清理、不重复创建任务；停止应用保留 core 和 agent；不终止身份未核对的进程」。P0 仅证明上游/core 可行性，应用生命周期仍由 T2 证明。
- 已知证据：hc 0.1.17 / generation 1、Windows x64、Bun 1.4.4；原生 `node:net` 的真实 `CoreClient.open(pipe)` 握手/RPC/subscribe/terminal run/attach/resize 成功，19 REQUIRED 全部存在；现有 `CoreClient.endpoint({ binary, session, socket })` 的 `hc connect` 也成功。原始产物目录 `C:\Users\shuan\AppData\Local\Temp\opencode\shepherdr-win-p0`，报告含 `probe-client-report.json`、`probe-holder-report.json`；规划角色读取外部报告被权限拒绝，结论依据 canonical verification 与主会话补充，不宣称独立读取原始 JSON。
- 历史 P0 决策为 direct pipe；后续 D2 已修订为固定 helper 对同一个受检 pipe 连接做 binary relay，因为 Bun 不公开实际句柄。保留 remote `hc connect` 和 CoreSession string 接口，不自动 fallback。管道 ACL/实际 peer、自建 operator、安全 home 与完整应用仍需 T1/T2 证明，协议连通不是安全验收。
- 生命周期实测：`hc server restart` 保留同一 holder 与程序；`hc server stop` 结束 core/holder/程序，下次 start 只把 keep terminal 恢复成新 shell。Shepherdr stop 必须仅停止自己的 main/drain，禁止通过 core stop/restart 或其他 core 生命周期操作停止应用。Bun 1.4.2、真实 agent 和完整 server 均未由 P0 验证。
- 规范：只读真实环境；仅既有隔离目录/官方 core，不改 PATH、provider 账户/信任、真实 home 或 core；不写生产文件。允许主会话写本 change 的执行证据，规划角色不写该记录。
- 验证：主会话继续复核 explorer 回传的**原样命令与输出**，不新造复现命令。该项消费现成外部实验，无新增 RED/GREEN；由 T2 的 CI 协议/应用生命周期承接。core 兼容性 PASS，T0 的最终收口由 main 标记 done；Windows 应用安全/真实闭环仍 UNVERIFIED。
- 回退：执行者已报告隔离 core/进程/pipe 清理；不再重复清理，不按未核实 PID 操作，不停其他 session。应用回退同样不能停止 core 来代替应用 drain。

## T1 — 私有文件保护（首个可立即委派的实施片）

- covers: [AC-WIN-04]；blocked_by: []；state: code_complete / OS verification pending；writer: fixer（ses_e5fab8650ffeb34hckh9cYJgNM，已返回）。编码依赖释放，安全验收不释放。
- AC 原文：WHEN「home、凭据或 operator 存在宽松 ACL、链接、junction、端点替换或身份不匹配」；THEN「拒绝不安全访问并解释原因；位于用户 profile 下或拥有随机管道名本身不足以授权；无法确认保护时拒绝」。本片负责 home/凭据/状态；operator 在 T2 完成，AC 不提前标记 done。
- 依赖决策：D1。本片先完成固定 PowerShell/.NET 机制与本地文件保护；pipe/core/lifecycle 由 T2 按修订 D2 实施，不在 T1 扩展 provider 修改。
- 允许修改/新增（绝对路径）：
  - `D:\my-works\herdr-plugin\shepherdr\server\core\windows-security.ts`（新增，窄的 Windows I/O adapter）
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-windows.ps1`（新增，固定脚本；本片只实现安全目录/文件操作）
  - `D:\my-works\herdr-plugin\shepherdr\server\core\home.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\store.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\common\secrets.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-home.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-windows-security.test.ts`（新增）
  - `D:\my-works\herdr-plugin\shepherdr\test\core-secrets.test.ts`
- 定位结论/可复制模式：`server/core/home.ts:11` `inspectHome` 保持只读分类；`server/core/home.ts:22` `prepareHome` 稳定 identity/legacy refusal；`server/core/home.ts:45` `readCredential<T>` 展示“检查→打开→检查同一对象→读→finally close”；`server/core/store.ts:15` `CoreStore` 需把 Windows ACL 保护置于 SQLite 打开前；`server/common/secrets.ts:38` `Vault.read` 的无法读不能视为空库，`server/common/secrets.ts:87` `Vault.write` 保留临时文件发布语义。新测试复制 `test/core-home.test.ts:8` 的独立 temp/finally 清理与 legacy 内容保持断言。
- 内联规范：保留同步调用者可用的 `readCredential<T>` 和 JSON 格式；只在 win32 分支使用脚本。固定系统程序 argv、stdin JSON，不插值 shell、不输出秘密、不绕过策略。SID/受保护 DACL/祖先替换权限与实际 handle identity 全验证；脚本只返回经同一持有句柄读取的字节，不能返回路径让 Bun 重开。新增目录创建即私有，既存宽松 ACL 拒绝而不修复；未知 ACE/reparse/hardlink/共享冲突默认拒绝。POSIX 原 mode/uid/O_NOFOLLOW 不削弱，禁止全局 ACL 变更、依赖升级和生成物修改。
- RED：先写 Windows 真实 OS 对象用例：合规目录稳定身份、只读 absent status、继承 Users/Everyone allow 拒绝、owner/未知 DACL 拒绝、junction/reparse/硬链接拒绝、打开时替换/共享写入拒绝、脚本不可用拒绝、vault 不覆盖无法读状态。用临时目录 DACL 构造，不需真实第二账户或提权；不能用 mock 的 ACL 结果替代 Windows API 用例。现有 POSIX mode 测试保留并与 Windows 等价断言分开。
- GREEN：实现 D1 后同一组 OS 用例通过；验证 `status` 不创建目录、没有 ACL 自动修复或 credential 泄露。同 SID 可信边界、管理员接管能力和不支持的文件系统明确记录。
- 精确命令：实施本机 `bun run typecheck`；CI `bun run test core-home core-windows-security core-secrets`。需要先在 CI 安装依赖/生成 registry，不能因此本机跑测试。当前结果：NOT RUN（规划片；测试仅 CI）。
- 回退点：新增隔离 home 尚未用于 agent 前。撤回该片代码，保留测试/记录中的失败事实，不改旧 home；Windows 启动继续拒绝，不以旧 POSIX mode 检查当 Windows 保护。
- 完成条件：安全接口、保守失败路径与类型检查结果可审阅后，释放 T2 的依赖编码；测试仅能在 CI 执行时如实携带 NOT RUN，实际 Windows 启动和 AC 验收仍等待安全实证。若 .NET/策略/句柄语义不能满足，列出具体 API/错误与必要依赖备选交主会话，不能自装新依赖或以 realpath 替代。

## T2 — 原生 CLI、选定 core 与完整安全生命周期

- covers: [AC-WIN-01, AC-WIN-02, AC-WIN-03, AC-WIN-04]；blocked_by: [T0, T1]；state: in_progress。T2a fixer ses_e5f83411dffeQFx2j4tBSb9OlW 处理入口修正；oracle ses_e5f9820b8ffe4XjLyBXTqLlsUK 的聚焦诊断已返回、不占 T7 审查。D2 已修订为固定 helper 在同一实际 pipe handle 上检查并 relay；禁止 preflight 后 Bun 重连、禁止隐式裸连接 fallback。Windows API/实际 hc DACL/清理行为均待实证。
- T2b 当前 fixer `ses_e5f557aaeffef55rik7bE0t4gH`（用户要求 omo-slim 新子代理续接；旧 `ses_e5f745f3bffe2i8RW13fmAx8Gs` 已 cancelled，保留部分代码）单独拥有 `helper/core-windows.ps1`、`server/core/windows-security.ts`、`server/core/client.ts`、新增 `test/core-windows-pipe.test.ts`（必要 `test/core-client.test.ts`）；可新增窄模块 `server/core/windows-pipe.ts` 将异步 relay 与同步文件 I/O 分离。仅实现修订 D2 的 client broker 与边界测试；不写 T2a 文件，不写 operator/launcher/main/source/session 或 OpenSpec 记录。首版仅同 SID、同 session、非提权 medium-integrity；固定 helper 版本化 READY + raw binary、背压、启动 deadline、EOF/dispose/父死亡清理。安全 gate 未验证仍拒绝，不改 hc ACL。main 负责读核及证据；不移交整个协调会话。T2c 自建 operator/生命周期待 T2b 接缝可审后串行分发；共享 helper 不并发写。
- T2a 写范围仅 `bin/shepherdr`、`bin/shepherdr.cmd`、`helper/core-entry.ts`、`server/core/config.ts`、`test/core-windows-cli.test.ts` 及必要的既有配置测试；不写 helper、安全适配器、client/operator/launcher/main/source/session。Windows 默认管道规则未取得证据前要求显式 `--core-socket` 或可继承的 `HC_SOCKET`，不猜默认值。main 拥有记录与验收；本片仍仅允许本机 typecheck。
- T2b 聚焦修正及类型批次已返回，main 独立 typecheck PASS / OS pending。T2c 分为串行两片：T2c1 仅私有 operator transport、boot 握手与测试；T2c2 再接 launcher/main 的锁、记录与统一 drain。当前同一 fixer 单独拥有 helper/core-windows.ps1、server/core/windows-pipe.ts、必要 windows-security.ts、operator.ts、helper/core-operator.ts、core-operator.test.ts；可新增窄模块 server/core/windows-operator.ts 和 test/core-windows-operator.test.ts。T2c1 不写 launcher/main/source，不接真实 stop；若提供 stop callback 接缝，默认拒绝且只在回执 flush 后触发。main 记录验收，Windows 尚不可宣称支持。
- T2c1 最后修正版已读核，main typecheck PASS；main 补正 Stream 回执调用及 answer+send 整体 deadline 后，串行放行 T2c2 编码（不是 OS 验收）。同一 fixer 现可写 launcher.ts/main.ts/operator.ts/windows-operator.ts、helper/core-operator.ts、必要固定 helper/security 接缝和 lifecycle/相关 operator 测试；source.ts 仅 drain 接缝有必要时。T2c2 发布 operatorPid、私有记录/锁/日志、只读 status、认证 stop 与唯一 drain、caller helper 父死亡清理；禁止 agents/config/client/session 与 OpenSpec 写入。仍不得本机运行测试/构建、触发远端或改真实状态。
- AC 原文：AC-WIN-01 WHEN「安装路径含空格或中文，用户从 Windows 命令行调用 CLI」THEN「参数完整传递，命令可运行，无隐含 POSIX shell 前置要求」；AC-WIN-02 WHEN「指定 core session 或端点并启动」THEN「连接所选 core，校验 generation 和所需方法；不兼容时返回可操作错误，不连接其他会话」；AC-WIN-03 WHEN「用户重复启动、查询状态、停止或在异常退出后重启」THEN「启动幂等、状态只读、停止执行 drain 和清理、不重复创建任务；停止应用保留 core 和 agent；不终止身份未核对的进程」；AC-WIN-04 WHEN「home、凭据或 operator 存在宽松 ACL、链接、junction、端点替换或身份不匹配」THEN「拒绝不安全访问并解释原因；位于用户 profile 下或拥有随机管道名本身不足以授权；无法确认保护时拒绝」。
- 依赖决策：D1–D3、D4 的入口；按修订 D2 的同句柄 broker 保留现有 framed `CoreClient.open(string)` 和 remote connect，不做传输自动 fallback。本片完成前 P1 不具备可交付状态，安全检查与优雅停止不可后补。T0 done 不代表 broker 或完整应用验收。
- 允许修改/新增：
  - `D:\my-works\herdr-plugin\shepherdr\bin\shepherdr`
  - `D:\my-works\herdr-plugin\shepherdr\bin\shepherdr.cmd`（新增）
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-entry.ts`（新增，共享 CLI 分发）
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-operator.ts`
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-windows.ps1`（接续 T1，增加本片 pipe 操作）
  - `D:\my-works\herdr-plugin\shepherdr\server\core\windows-security.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\config.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\client.ts`（仅必要的安全接缝/错误处理；不重写已通过的 framed transport）
  - `D:\my-works\herdr-plugin\shepherdr\server\core\launcher.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\main.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\operator.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\source.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-client.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-launcher.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-operator.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-windows-cli.test.ts`（新增）
  - `D:\my-works\herdr-plugin\shepherdr\test\core-windows-lifecycle.test.ts`（新增）
- 另须只读打开：`D:\my-works\herdr-plugin\shepherdr\server\core\session.ts`；direct pipe 沿用 string 接口，不为本机扩 endpoint union。
- 定位结论：`bin/shepherdr:5` 生命周期/agent/human-secret 路由是复制基准；`helper/core-operator.ts:8` 拒绝 agent 借 human channel；`server/core/config.ts:24` 的 resolve 不可用于 pipe，`server/core/config.ts:33` `coreEnvironment` 继续清理启动者身份；`server/core/client.ts:18` `CoreEndpoint` 保持原 remote 行为，`server/core/client.ts:19` 的 19 REQUIRED 已在 P0 全部找到；`server/core/session.ts:28` 与 `server/core/source.ts:123` 保持 string pipe；`server/core/source.ts:188` recovery 不可切换端点；`server/core/operator.ts:42` `operatorRequest` 为既有权限边界；`server/core/launcher.ts:21` health 的 product/boot/pid 与 `server/core/launcher.ts:174` stop 必须联合处理；`server/core/main.ts:38` 已有 drain/cleanup，`server/core/main.ts:45` 只删同 boot 记录。
- 复制模式：`test/core-client.test.ts:21` framed fixture/版本拒绝及 unknown-write 不重放；`test/core-launcher.test.ts:9` 活 PID 未确认时既不报 stopped 也不 signal；`test/core-operator.test.ts:9` secret 经 server vault 写入且不安全端点拒绝。Windows 替换 POSIX fixture 的可执行 shebang/Unix socket，不删原平台断言。
- 内联规范：CLI 只用结构化 argv，CMD/PowerShell 的 stdin、退出码、中文/空格/引号覆盖。原 `--core-socket` 和 credential socket/endpoint fallback 兼容；没有 generation/schema 特例。私有 operator pipe 创建即受保护、first-instance、防远程及实际 handle peer 校验；先核对 boot 再发送 secret。authenticated stop 只走应用 main 的幂等 drain，禁止调用 `hc server stop`、`hc server restart` 或其他 core 生命周期操作代替停止，超时也不 fallback。锁和记录经私有读取；不给 HTTP stop，不用 Windows SIGTERM 当优雅停止，不 kill 未确认 PID，不终止 core/agent。保留 Unix operator 路径规则和 100 字节上限仅用于 Unix；Windows 端点单独校验。
- RED：新增 Windows CLI 路径/argv/stdin 路由；端点优先级、错误 session、错误 generation/缺方法的可操作拒绝；不安全 home/pipe、pipe 预占、替换与 boot/PID 不匹配；重复 start/status/stop、并发锁、异常 app 退出后恢复；在 drain 中阻塞时不得提前报 stopped/删记录。断言 Shepherdr stop 不调用 core stop/restart，core PID、holder PID 和原程序均保持；不能只检查 keep terminal 又显示 live，因为 P0 已证明它可能是新 shell。身份错误测试不得 signal 实际父进程。
- GREEN：在 CI 的隔离 home、端口、session、hc 0.1.17 / gen1 上运行真实 Shepherdr lifecycle，Bun 仍用 pin 1.4.2 验证；fake 只测协议与错误边界。Windows stop 回执与最终退出分离，重复 stop 幂等；应用重启不重复任务，也不以重启 core 保持表面存活。detached readiness、日志句柄释放、同一原程序连续输出与进程身份纳入测试。当前 P0 的 Bun 1.4.4 协议通过不充当完整 server 或 pin 1.4.2 的 GREEN。
- 精确命令：实施本机 `bun run typecheck`；CI `bun run test core-client core-launcher core-operator core-windows-cli core-windows-lifecycle`。真实 lifecycle 用例读取 `SHEPHERDR_TEST_CORE_BIN`（由 T6 在 runner.temp 中准备并指定绝对路径），缺少该输入必须报告未验证，不能 skip 后计 AC 通过。当前 NOT RUN（待 T0/T1 与 CI）。
- 回退点：创建任何 provider session 前。停止仅本片隔离 app，回退入口/transport/lifecycle 代码及可选 run 字段；不动 core、agent、旧凭据或真实 home。失败时保留私有日志和错误，不能硬杀“修好”stop。

## T3 — 普通 agent、hooks、消息与 Autopilot 拒绝

- covers: [AC-WIN-05, AC-WIN-07]；blocked_by: [T2]；state: in_progress；writer: fixer ses_e5f557aaeffef55rik7bE0t4gH（omo-slim，同会话续接，main 验证）。
- AC 原文：AC-WIN-05 WHEN「启动一个宣称支持的原生 agent 并提交无害任务」THEN「启动、消息、hooks、状态更新、任务结束和应用重连均有真实证据；缺少账号或程序时记录未验证，不以 fake 代替」；AC-WIN-07 WHEN「在 Windows 本机请求 Autopilot」THEN「明确说明本机不支持，不启动无隔离 fallback，也不自动使用 WSL」。
- 依赖决策：D1/D2 的保护与身份、D4；T2 必须已提供可安全停止的隔离应用。本片不得安装/登录 agent、改变 hook trust 或放宽 native permissions。
- 允许修改：
  - `D:\my-works\herdr-plugin\shepherdr\server\core\agents.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\own-commands.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\source.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\pilot-lifecycle.ts`
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-hook.ts`
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-cli.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-agents.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-launch-matrix.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-own-commands.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-pilot-lifecycle.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-windows-agents.test.ts`（新增）
- 另须打开的只读文件：
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-pilot-launch.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\mailbox.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\logs.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\native-file.ts`
- 定位结论/模式：`server/core/agents.ts:22` POSIX quote，`server/core/agents.ts:40` `worktreeRoot`、`server/core/agents.ts:53` `bun`、`server/core/agents.ts:75` `launch`；`server/core/agents.ts:111` 至 `server/core/agents.ts:124` 的 SHEPHERDR_COMMAND/PATH/hook command/提示词必须一起保持一致；`helper/core-hook.ts:21` 读 credential，`helper/core-hook.ts:43` 权限错误 deny；`server/core/own-commands.ts:7` `ownRules` 与 `server/core/own-commands.ts:34` `ownCommand` 为不能扩权的现有规则；`server/core/source.ts:528` 模式切换进入 lifecycle，`helper/core-pilot-launch.ts:38` 已拒绝非 Linux。复制 `test/core-agents.test.ts:11` 的旧 hook 不覆盖 replacement agent，以及 `test/core-agents.test.ts:148` 起的 launch env/permission 不越权断言。
- 内联规范：本机 Windows 与远端目标平台分开；PATH delimiter/大小写环境键正确，不引入 POSIX shell。core terminal.run 与 helper 均用 argv；provider hook 字符串只按已验证的 provider Windows shell 编码。原生 executable 优先；仅发现 npm ps1/cmd 不等于已验证可运行。不能安全精确匹配 command 就不给自动批准，不加 wildcard、dangerously-* 或策略绕过。D1 helper 的凭据读写要真正接入生成文件路径，hook 记录不读写到宽松/链接文件；不打印 credential。
- RED：验证 Windows launch argv、带中文/空格/引号的 cwd/hook 路径、PATH 与 command 一致性、旧 credential 兼容、permission transport 失败 deny、late hook 不回退状态；Autopilot 从模式切换/重启/直接 launch 的入口均在创建 state/grant/terminal 前拒绝，断言无 WSL/普通 launch fallback。保留 Linux contained launch 测试和原平台 permission 默认值。
- GREEN：同组边界测试通过后，在已安装且已登录、无需改变现有 trust 的 Windows 原生 agent 上做一次人工无害闭环：启动 → 发送消息 → hook/native 状态变化 → 完成 → 停止并重连应用 → 原 terminal/session/任务身份保持。记录 provider 版本、真实命令、时间、脱敏结果与人工页面观察；不要把 fake terminal 生命周期当真实 agent。
- 精确命令：实施本机 `bun run typecheck`；CI `bun run test core-agents core-launch-matrix core-own-commands core-pilot-lifecycle core-windows-agents`。人工闭环使用 T2 已验证的 `bin\shepherdr.cmd start/status/stop` 及 UI；具体隔离 `--home/--port/--core-session/--core-bin` 值由主会话从 T0/T2 证据原样携带，不虚构账号命令。当前测试 NOT RUN；真实 agent UNVERIFIED（hc 仅在 P0 临时目录验证，PATH 中无 hc/claude；codex 仅 npm ps1，登录/信任未验证）。
- 回退点：真实 agent 启动前保存该隔离 launch 身份；失败时撤回生成命令变更并撤销仅本 launch 的 grant，保留 core terminal 供用户检查，不删 provider 账户数据或 native transcript。没有真实 agent 证据时不授予“支持”状态，不阻止 T4/T5 的代码工作，但 T7 交付声明仍 blocked。

## T4 — 普通 worktree/includes 与 review helper

- covers: [AC-WIN-06]；blocked_by: [T3]；state: blocked；writer: unassigned。
- AC 原文：WHEN「使用普通 worktree、includes、review helper、附件或产物，路径含空格、中文、反斜杠或不同盘符」；THEN「合法操作成功，越界、危险链接及不安全文件被拒绝；保留现有 Linux/macOS 行为」。本片负责 worktree/includes/review，附件/产物由 T5 证明。
- 依赖决策：D1、D4/D5。包括任务实际调用链，不为 Autopilot/SSH 扩展 Windows 支持。
- 允许修改/新增：
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-worktree-includes.ts`
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-worktree.ts`
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-review.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\worktree.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\git.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\tasks.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-worktree-includes.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-worktree.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-git.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-tasks.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-review-reader.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-windows-files.test.ts`（新增；本片拥有）
- 另须只读打开：`D:\my-works\herdr-plugin\shepherdr\server\core\files.ts`、`D:\my-works\herdr-plugin\shepherdr\server\core\windows-security.ts`、`D:\my-works\herdr-plugin\shepherdr\helper\core-worktree-move.ts`。后者是依赖 flock 的 contained adoption 接缝，不为普通 Windows 任务删除其锁/隔离检查。
- 定位结论/模式：`server/core/tasks.ts:183` 派生普通任务 folder，`server/core/tasks.ts:424` 执行 includes；`helper/core-worktree-includes.ts:8` Git argv 仍带 `/dev/null` hooksPath，Windows 应使用经验证的空 hooks 目录而不改用户 Git config；`helper/core-worktree-includes.ts:24` `plainParents` wire path 校验，`helper/core-worktree-includes.ts:116` 至 `helper/core-worktree-includes.ts:123` 独占临时文件/硬链接发布不覆盖；`helper/core-worktree.ts:72` 拒绝不安全 wire 相对路径；`server/core/worktree.ts:9` eval 源码，`server/core/worktree.ts:20` machine.exec 调用点；`helper/core-review.ts:6` 配置读与 `helper/core-review.ts:8` log 打开需要 D1。复制 `test/core-worktree-includes.test.ts:17` includes 选择/不覆盖和 `test/core-worktree-includes.test.ts:72` interrupted publish 恢复；`test/core-review-reader.test.ts:4` completed/failed review 区分保留。
- 内联规范：Git 路径列表保持 NUL 协议、argv 与 --end-of-options；native 路径和 wire `/` 相对路径区分。Windows 驱动器/UNC/ADS/设备名、junction/reparse、跨盘 relative 越界、hardlink 和发布替换均拒绝；合法目标可在不同盘，内部 stage 选目标卷保证不覆盖发布。stage/log/credential 的 ACL 复用 D1，不能删 mode/uid 后裸跑。若增加 helper import，同片处理 eval 调用点，Windows 本机调用 immutable helper 的明确 CLI，stdout 仍是 JSON。保留原平台和隔离 broker 的安全检查，不动 public plugin 契约。
- RED：先为真实 Windows temp Git repo/worktree 加空格/中文路径用例；includes 排除/只复制忽略项/已有目标不覆盖；junction 父目录、文件替换、wide ACL stage、硬链接、ADS/设备名拒绝；review config/log 私有且 JSON 事件完整。跨盘合法 repo/task 与越界测试需真实不同卷，优先使用 runner 已有的两个可写卷；缺少第二卷记录 UNVERIFIED，不新增磁盘基础设施，也不用纯 path mock 代替文件实证。
- GREEN：同组用例通过，reviewer 非零退出/缺 turn.completed 仍失败；普通任务从创建 worktree、includes 到 reviewer 完成的公共行为有覆盖，不重复构造任务。更改可执行 shell 及原子发布语义时必须证明不扩权。
- 精确命令：实施本机 `bun run typecheck`；CI `bun run test core-worktree core-git core-tasks core-review-reader core-windows-files`。当前 NOT RUN（本机禁止；待 CI）。第二卷缺失单项 UNVERIFIED 并保留为 T7 阻塞，不把 skip 算通过。
- 回退点：启动 reviewer 和发布目标文件前；保留已创建 worktree、分支和用户内容，仅清理经身份核对且本片拥有的 stage 别名。不得强制删除 dirty worktree 或覆盖已存在目标。

## T5 — 附件、产物与敏感路径边界

- covers: [AC-WIN-06]；blocked_by: [T3 的平台与 route 接口]；state: in_progress；writer: fixer ses_e5d55a849ffeknFZXyqbhfj2KQ（omo-slim，唯一 writer；main 验证）。
- 编码依赖释放：T3 的 agentHost/route 接口已可审且类型通过，附件/产物不依赖尚待调查的 provider hook shell。T3 的真实闭环与最终支持声明仍未通过。T5 此轮显式串行拥有 windows-security.ts/core-windows.ps1 的窄文件 I/O 扩展；期间 T3/T4 不得改这两个共享文件。
- AC 原文：WHEN「使用普通 worktree、includes、review helper、附件或产物，路径含空格、中文、反斜杠或不同盘符」；THEN「合法操作成功，越界、危险链接及不安全文件被拒绝；保留现有 Linux/macOS 行为」。本片负责附件/产物，与 T4 合并后才覆盖完整 AC。
- 依赖决策：D1/D5。仅适配 Windows 本机实际 I/O，现存 core machine.exec 仍是机器路由，不新增上传 listener/HTTP 权限面。
- 允许修改/新增：
  - `D:\my-works\herdr-plugin\shepherdr\server\core\chat.ts`
  - `D:\my-works\herdr-plugin\shepherdr\server\core\artifacts.ts`
  - `D:\my-works\herdr-plugin\shepherdr\helper\core-windows-files.ts`（需要替换 inline I/O 时新增，仅结构化操作、复用 D1）
  - `D:\my-works\herdr-plugin\shepherdr\test\core-chat.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-artifacts.test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\core-windows-transfers.test.ts`（新增；不改 T4 的测试文件）
- 另须只读打开：`D:\my-works\herdr-plugin\shepherdr\server\core\files.ts`、`D:\my-works\herdr-plugin\shepherdr\server\core\windows-security.ts`、`D:\my-works\herdr-plugin\shepherdr\helper\core-windows.ps1`、`D:\my-works\herdr-plugin\shepherdr\test\core-artifact-check.test.ts`。
- 定位结论/模式：`server/core/chat.ts:57` upload 的 basename 与私有 uploads，`server/core/chat.ts:72` read 及 `server/core/chat.ts:80` copy 的 inline uid/mode/open/offset/hash 校验；`server/core/chat.ts:103` 仅接受本 chat 的上传记录；`server/core/artifacts.ts:77` read 的 provider/home 排除和普通文件上限，`server/core/artifacts.ts:125` export 的私有 cache；`server/core/artifacts.ts:181` 发布前重核当前 grant/launch/terminal 身份不可删除。复制现有 chat 归属、transfer 校验、artifact old launch 拒绝及发布事务模式，Windows 分支只替换必要的 I/O 操作。
- 内联规范：不得因 Windows `process.getuid` 不存在而跳过校验；走 D1 的同句柄读取/独占发布。把 Windows native 绝对路径与相对导入参数分开验证；拒绝 ADS/保留设备名/尾随点空格、reparse/硬链接、跨盘逃逸和大小写别名绕过敏感 home 排除。保留 32 MiB 附件、artifact 输入上限、chunk offset/hash、current launch 授权，路径不能授权其他 chat。新 helper 不接受任意脚本/命令，不改共享浏览器或 renderer 设计。
- RED：合法中文/空格/反斜杠/不同卷上传及产物导出；同名文件不覆盖；错误 chat/launch、宽松 ACL、junction/替换、hardlink、大小写 provider home、盘符前缀混淆、ADS/设备名拒绝；分片 offset/checksum 错误不发布、不遗留半个目标。用真实 Windows FS/ACL 对象验证；敏感目录用合成 temp 路径，不读真实 provider 凭据。
- GREEN：同组用例通过，公开 upload→消息附件→合法下载与 artifact→导出链路覆盖；人工共享浏览器检查已有附件/产物界面，记录真实页面操作而非 demo 截图代替。浏览器自动测试本机禁止；已有 renderer/browser 功能不在本片扩承诺。
- 精确命令：实施本机 `bun run typecheck`；CI `bun run test core-chat core-artifacts core-windows-transfers`。当前 NOT RUN（本机禁止；待 CI）；人工页面证据待隔离实例就绪。
- 回退点：任何目标发布和 artifact 版本事务提交前；仅移除已核实 owner/identity 的本次临时文件，不删上传记录对应的用户原始文件，不触碰 `.claude/.codex`、真实 home 或其他 chat 的数据。

## T6 — 分阶段 CI 与支持边界文档

- covers: [AC-WIN-08]，汇总 AC-WIN-01..07；blocked_by: [T4, T5]；state: blocked；writer: unassigned。
- AC 原文：WHEN「声明 Windows 首版完成」；THEN「所需 Windows CI 与原有平台检查通过，文档分别列出支持、未验证和不支持；本机只执行 typecheck，测试和构建交给 CI，真实设备或 agent 证据不由 fixture 代替」。
- 依赖决策：D1–D5 与设计的验证/交付部分。CI 准备可以提前，最终适用测试清单须与 T1–T5 的实际文件/接缝一致；不能为提前 green 删掉负向安全用例。
- 允许修改/新增：
  - `D:\my-works\herdr-plugin\shepherdr\.github\workflows\check.yml`
  - `D:\my-works\herdr-plugin\shepherdr\scripts\windows\ci-host.ps1`（新增，仅 CI 管理员引导）
  - `D:\my-works\herdr-plugin\shepherdr\scripts\windows\ci-user.ps1`（新增，普通用户强制验证）
  - `D:\my-works\herdr-plugin\shepherdr\scripts\test.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\preload.ts`
  - `D:\my-works\herdr-plugin\shepherdr\test\once.ts`（仅实际 Windows 锁/句柄故障有证据时修改）
  - `D:\my-works\herdr-plugin\shepherdr\docs\core\start.md`
  - `D:\my-works\herdr-plugin\shepherdr\docs\develop.md`
  - `D:\my-works\herdr-plugin\shepherdr\docs\core\windows.md`（新增，main 所有；沿用 core 文档目录）
- 另须只读打开：`D:\my-works\herdr-plugin\shepherdr\bunfig.toml`、`D:\my-works\herdr-plugin\shepherdr\.github\workflows\core-rewrite.yml`；以及 T1–T5 的测试文件/命令。不修改 README、manifest 版本、锁文件、public plugin API 或既有发布流程。
- 定位结论/复制模式：`.github/workflows/check.yml:38` 的 Ubuntu types/build、`.github/workflows/check.yml:56` 的三 shard 全套测试必须保留；`.github/workflows/check.yml:46` Bun 1.4.2、`.github/workflows/check.yml:52` frozen install 是版本/依赖基准；`scripts/test.ts:193` 平台 priority、`scripts/test.ts:214` runner 环境已有分支；`test/preload.ts:41` `command()` 的 `/proc`→`ps` 发现不适用于 Windows；`test/once.ts:15` `once` 已用 exclusive 文件锁，不无证据换锁。`docs/develop.md:33` 要求 meaningful tests，`docs/core/start.md:283` 的 Unix human secret 描述应原位补平台限定并链接新文档。
- 内联规范：最小改动复用 Check 触发/依赖安装/缓存，不新增发布或部署；不改原 Ubuntu 完整 gate，不触发额外远端运行。Windows 安全失败必须红，不能 `continue-on-error` 或 `process.platform === 'win32'` 全跳过；POSIX 专有测试可保留原平台运行，同时补 Windows 等价真实 OS 断言。固定 PowerShell/.NET 脚本也纳入 CI 变更路径与执行覆盖。仅适配 runner 的平台识别/命令/fixture，避免为 Windows 顺带重写整个 runner。
- RED：先定义 Windows stage 的选定测试清单与成功条件，再确认未实现平台分支会失败；目前无远端运行，记 NOT RUN。脚本/fixture 故障回给原片单 writer 修复，不在本片越界修改其他 worker 文件。
- GREEN 分阶段：① Windows x64 frozen install/typecheck/build；② Windows CLI、DACL/reparse/pipe、协议及真实隔离 core 生命周期；③ 普通 agent 边界、worktree/includes/review、附件/产物。另加 macOS 对更改接缝的回归，保留 Ubuntu 全套。测试 runner 使用真实 OS，不把平台参数 mock 当 ACL 证明；CI 不需要 provider 账号，真实 agent 验收在 T7 独立汇总。
- 精确命令（每条作为独立 CI step，不在本机运行）：
  - Windows：`bun install --frozen-lockfile`
  - Windows：`bun run typecheck`
  - Windows：`bun run build`
   - Windows 安全/生命周期：`bun run test --timeout=240000 core-home core-secrets core-windows-security core-client core-launcher core-operator core-windows-pipe core-windows-operator core-windows-cli core-windows-lifecycle core-windows-publication`
  - Windows 普通任务：`bun run test core-agents core-launch-matrix core-own-commands core-pilot-lifecycle core-windows-agents core-worktree core-git core-tasks core-review-reader core-windows-files core-chat core-artifacts core-windows-transfers`
  - macOS 变更接缝：`bun run typecheck`，然后 `bun run test core-home core-client core-launcher core-operator core-agents core-worktree core-chat core-artifacts`
  - Ubuntu：原 workflow 的 `bun run typecheck`、`bun run build` 和 `bun run test --shard=${{ matrix.shard }}/3 --map=screen-map.json` 保留。
- 真实 core 输入：固定 P0 的 hc 0.1.17 / gen1 Windows x64 资产及 `artifacts/verification.md:30` 的 SHA256 依据，在 runner.temp 内准备独立二进制/状态/session，显式设置 `SHEPHERDR_TEST_CORE_BIN`；不得用用户全局 hc 或 PATH 安装。不能填 latest 或 fake 冒充。Bun 保持 1.4.2，Windows 兼容性由 CI 补证，禁止仅因 P0 是 1.4.4 就改 pin。T2 lifecycle stage 要断言真实用例确实执行、应用 stop 不触及 core 生命周期。
- 文档分别列 Supported / UNVERIFIED / Unsupported，并依据实际证据升格：安装与 CMD/PowerShell 用法、私有 home 的 ACL/脚本策略要求、显式 core 选择、启动/只读状态/优雅 stop、真实验证 provider 版本、路径限制、故障处理。Windows 本机 Autopilot/WSL fallback 明确拒绝；ARM64、自启/服务、SSH、共享浏览器、语音、plan approval、用量读取不承诺。不要把尚未运行的 CI 写成通过。
- 当前命令结果全部 NOT RUN（CI 未触发）；本机只允许实施者 `bun run typecheck`。未获 push/PR/workflow_dispatch 授权时只准备 workflow，主会话另记证据缺口，不为了验证自行触发或发布。
- 回退点：workflow 还未触发时即可撤回 CI/文档修改，原有 Check 保持可运行；若修复 native job，不以取消 gate/隐藏错误回退。没有新数据迁移或线上服务动作。

## T7 — 主会话证据与一次独立审查

- covers: [AC-WIN-01..08]；blocked_by: [T6]；state: blocked；writer: main。
- AC 原文：验收采用本文件各片内联的 AC-WIN-01..08；完成声明额外遵守 AC-WIN-08「所需 Windows CI 与原有平台检查通过，文档分别列出支持、未验证和不支持；本机只执行 typecheck，测试和构建交给 CI，真实设备或 agent 证据不由 fixture 代替」。
- 主会话补齐实际读取/证据清单与结果，仅在该 change 的 canonical artifacts 中记录；本规划角色不修改 `artifacts/context.md` 或 `artifacts/verification.md`。读源使用各片绝对路径及最终 diff，不让 reviewer 重新全库扫描。
- 核验顺序：每片真实文件在允许范围 → 精确命令/输出和 NOT RUN/UNVERIFIED → Windows DACL/peer/TOCTOU/stop 负向证据 → 真 core/普通 agent/人工页面 → Windows CI、Ubuntu 全套与 macOS 接缝结果。PR/CI 尚未执行时直说无法声明首版完成，不把可实现设计当交付证据。
- 独立审查预算：实现稳定后安排一次 fresh-context Standards / Spec 审查；critical 在可用时用不同模型，实际模型不可观察则明确记录。最多一次聚焦 blocking 修复 follow-up，跨 session 不重置预算；本规划不启动审查或递归委派。
- 审查 test seam：外部 CLI/API 行为、所选 core 协议、真实安全对象、drain 与重连、真实 provider 和普通任务。不能只审 helper 内部函数或接受 fixture 作为 AC-WIN-05 证明。
- 精确本地命令：`git diff --check`、`git diff --stat`、`git status --short`（只读 diff 核对）；实施代码的允许编译检查 `bun run typecheck`。CI 结果只消费实际 workflow run 链接/结论；未授权不新触发。人工证据记录隔离实例/任务身份及实际步骤，避免秘密/个人路径泄露。
- 回退点：最终交付声明前。阻塞发现按原片修复、重验证受影响 seam；无证据或审查不可用就保留 UNVERIFIED。不得自行 commit/push、merge、archive、改版本/tag、移动 session 或发布。

## AC 覆盖与规划核对

| AC | 主实施/证明片 | 对外测试接缝 | 预期 RED → GREEN | 交付回退点 |
| --- | --- | --- | --- | --- |
| AC-WIN-01 | T2 | CMD/PowerShell 调用真实 CLI、argv/stdin/退出码 | POSIX 入口依赖失败 → 原生 wrapper/共享路由通过 | provider 启动前撤回入口 |
| AC-WIN-02 | T0 → T2 | 所选 session/direct pipe 的 hello/schema/RPC/重连 | P0 已确认协议；应用的 resolve/错路由门禁待补 → 保留 framed client/remote connect 并通过 CI | 隔离连接建立前，保留原 core |
| AC-WIN-03 | T2 | 应用 start/status/stop、锁、drain/异常重连、同一原程序存活 | Windows signal/重复启动/不明 PID 行为不符 → 认证 stop/唯一 main drain，零 core stop/restart | 仅隔离 app，绝不操作 core 生命周期以停止应用 |
| AC-WIN-04 | T1 + T2 | 真实 DACL/句柄/链接/pipe peer 负向对象 | POSIX mode 不构成保护 → SID/DACL/实际对象验证且未知拒绝 | 新隔离 home 使用前，失败继续拒绝 |
| AC-WIN-05 | T3 + T7 | 真 agent 的消息/hooks/native 状态/完成/应用重连 | Windows launch/hook 路径失败 → 边界绿且真实闭环成立 | 每 launch grant/生成文件；保留 native history |
| AC-WIN-06 | T4 + T5 | Git worktree/includes/review 与上传/产物公共链路 | 分隔符/ACL/eval/跨盘边界失效 → 合法路径成功且危险对象拒绝 | 原子发布/版本提交前，不覆盖用户文件 |
| AC-WIN-07 | T3 | 本机 Autopilot 所有启动入口与 no-side-effects 断言 | 过晚/不清晰拒绝或 fallback → 明确拒绝且无 grant/进程/WSL | 发放任何 contained 能力前 |
| AC-WIN-08 | T6 + T7 | 真实 CI、人工证据、支持矩阵与独立审查 | 无 Windows 证据且支持声称过早 → 必需结果齐备/未验证准确分类 | 支持/交付声明前 |

规划文档 owner：workflow-planner。覆盖、DAG、每片允许文件、内联规范、AC、定位/模式、RED/GREEN、命令与回退已列出；规划只做静态核对，没有运行测试、构建或 typecheck。执行与最终审查 owner：主会话。当前可委派边界为 T1；T2 的 direct pipe 路线已定，等待 main 对 T0 收口及 T1 保护接缝。真实 agent、完整 server、Bun 1.4.2 Windows 与 CI 尚未验证，整个 Windows 首版尚未 ready。
