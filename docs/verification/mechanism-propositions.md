# 机制主张清单 — implement-issues 声称做到的事

**Status:** 定稿 · **Date:** 2026-08-04 · 解决 [#4](https://github.com/liumingjian/implement-issues-workflow/issues/4)，属于地图 [#3](https://github.com/liumingjian/implement-issues-workflow/issues/3)

行号基准：`workflows/implement-issues.js` @ `cecabe0`（v4，含 close 语义与 review 门禁）。
清单原文只要求 v3；v4 的三条改动（D3/D4/D5）已经进代码，所以一并列入并标注 `v4`。

## 怎么读这张表

每条命题标注两件事：

- **观测面** —— 断言从哪读。三个来源：`R` = workflow 返回对象（`:479-489`）、`G` = git 仓库状态、`T` = tracker 上的 issue 状态/comment、`X` = 只在 transcript 或 `log()` 行里，返回对象拿不到。
- **判定类** ——
  - **A｜静态可判定**：命题落在纯 JS 编排里，读码即可判对错。用例对它只是回归确认「改动没把它改坏」，不需要跑也能验。
  - **B｜需跑，二值确定**：必须真跑一轮，但断言读的是 git / tracker 上的客观事实，对错没有解释空间。**这一类构成第 1 层门禁的主体。**
  - **C｜需跑，观测面缺失**：命题为真为假是确定的，但现在没有地方能读到证据（`X`）。要么放弃断言，要么给 workflow 加只为可观测性存在的字段 —— 见 §3。

`A` 类多的地方是设计得扎实的地方；`C` 类多的地方是这个 workflow 最声称、却最没法自证的地方。

---

## 1. 命题

### 1.1 Preflight

| # | 命题 | 证据 | 观测面 | 类 |
|---|------|------|--------|---|
| P01 | 基线红 → 立即中止，返回 `{aborted:'baseline-red'}`，**不创建任何东西** | `:353`，prompt `:174-176` | R + G（不存在 `auto/implement*`）+ T（无 issue 被 assign） | A（编排半）/ B（agent 是否如实报告） |
| P02 | preflight agent 死掉 → `{aborted:'preflight-failed'}`，不继续 | `:352` | R | A |
| P03 | **仓库没有测试时 `baseGreen` 被当成绿**，流程照常往下走 | prompt `:174-175` | R + G | B |
| P04 | 集成分支名为 `auto/implement`，撞名则 `-2`/`-3` 递增；从 base 切出 | prompt `:177-179` | R.integrationBranch + G（`git merge-base --is-ancestor base integ`） | B |
| P05 | base 分支 = 发起运行时的当前分支 | prompt `:172` | R.baseBranch | B |

P03 不是 bug 而是明写的行为，但它是**用例本身的硬前提**：demo 仓库若没有非空测试，此后每道 gate 全部空转，整张表的 B 类全部失效（地图 Notes 7）。

### 1.2 Plan —— `classifyPlan` 的纯 JS 不变量

这一整段是 A 类：`classifyPlan`（`:135-164`）不调用任何 agent，输入输出都是普通对象，**可以脱离 GitHub 单测**。

| # | 命题 | 证据 | 观测面 | 类 |
|---|------|------|--------|---|
| P06 | candidates/batch/deferred 内部不得有重复号 → 否则 `invalid` | `:144-146` | X（`log`）→ R.stoppedBy | A |
| P07 | candidates 与 batch 必须严格升序 → 否则 `invalid` | `:147-149` | 同上 | A |
| P08 | batch + deferred 必须是 candidates 的**精确划分**（不重、不漏、不越界） | `:150-153` | 同上 | A |
| P09 | 已 landed 或已 set-aside 的号出现在 candidates → `invalid` | `:154-156` | 同上 | A |
| P10 | deferred 项 `blockedBy` 为空 → `invalid`（不许无证据 defer） | `:157-159` | 同上 | A |
| P11 | candidates 为空 → `complete` | `:160` | R.stoppedBy | A |
| P12 | batch 非空 → `ready` | `:161` | X | A |
| P13 | batch 空且 deferred **全为** `logical` → `blocked` | `:162` | R.stoppedBy | A |
| P14 | batch 空但 deferred 含 `file-overlap`/`api-shape` → `invalid`（整组 defer 不前进，必须报错而不是空转） | `:163` | R.stoppedBy | A |
| P15 | 任何非 `ready` 的分类都要跑**一次独立 confirmation pass**，且 confirmation prompt 明令不复用上一轮结论、重查全部 GitHub 事实 | `:389-397`，prompt `:220-223` | X（第二个 `confirm:rN` agent） | A（是否发起）/ C（是否真重查） |
| P16 | confirmation 后仍为 `invalid`/`complete`/`blocked` → 分别以 `plan-invalid`/`complete`/`blocked` 终止 | `:399-411` | R.stoppedBy | A |
| P17 | planner agent 返回 null → `plan-failed`，**为安全起见结束整个 run**，不重试 | `:386,394` | R.stoppedBy | A |

### 1.3 Plan —— 交给模型的部分

这一整段是 C 类的重灾区：命题都关于 planner 的判断，而 **plan 对象整体不进返回值**。

| # | 命题 | 证据 | 观测面 | 类 |
|---|------|------|--------|---|
| P18 | 每轮把 workflow 自己记的 done/setAside 告诉 planner，并声明它们**权威于 GitHub 读延迟** | prompt `:189-192`，`:384-385` | X | A（是否传入）/ C（是否被采信） |
| P19 | **leaf-only**：按 `sub_issues_summary.total` 判定，umbrella/spec 一律进 `excluded` | prompt `:197-198` | X（`plan.excluded` 不在 R 里） | C |
| P20 | **逻辑依赖要复核 blocker 当前 state**，只对 verified-open 的 blocker defer；关闭的 blocker 视为已满足 | prompt `:204-209` | X（`plan.deferred[].kind='logical'`） | C |
| P21 | **文件重叠序列化**：重叠组释放一个、其余 defer 到后续轮次；**绝不整组 defer** | prompt `:211-212,216` | X（需要「谁在第几轮落地」，R 里没有） | C |
| P22 | **API shape**：生产者先行，消费者 defer | prompt `:213-214` | 同 P21 | C |

**P20 是这张表里唯一一条「已知 prompt 与命令不一致」的命题**：`:204` 的 `gh api .../dependencies/blocked_by --jq '.[].number'` 不按 state 过滤，而该端点**会把已关闭的 blocker 一并返回**（地图 Decisions 里 #5 的实证）。命题为真只能靠模型真的执行了 `:206-209` 那段散文去逐个复核 state。所以 P20 实测的是「模型有没有执行 prompt 的 prose」，是整套里最值得优先证伪的一条 —— 一旦为假，依赖链会在第一个 blocker 关闭后**永久 defer**，run 以 `blocked` 假终止。

### 1.4 Implement

| # | 命题 | 证据 | 观测面 | 类 |
|---|------|------|--------|---|
| P23 | 每个 issue 在**独立 worktree** `../wf-worktrees/issue-N`、**确定性分支** `wf/issue-N` 上构建 | `:26-27`，prompt `:236-245` | G（分支存在且名字确定） | B |
| P24 | **分支复用不重建**：分支已存在则挂上去继续累积，不存在才从 integ tip 开 | prompt `:240-244` | G（同一分支跨轮次累积 commit，无强推、无 rebase 痕迹） | B |
| P25 | 实现阶段 **claim** issue（`--add-assignee @me`） | prompt `:234` | T（assignee） | B |
| P26 | 实现阶段**不 close、不 merge、不 push** | prompt `:250-251` | T（merge 之前 issue 一直 open） | B |
| P27 | per-ticket 全套 gate 必须 100% 绿；编排端要求 `status=success && testsPassed && committed` 三者同时成立才算 buildOk | prompt `:249`，`:419-421` | X（`impl` 对象不进 R） | A（三条与的逻辑）/ C（各分量的值） |
| P28 | 失败 → issue **保持 open**，且失败 agent **自己在 issue 上留言**（原因 + 分支上已有什么）`v4/D5` | prompt `:253-258` | T（comment）| B |
| P29 | 分支已满足 spec 且绿时**不做改动**（merge 重试轮的幂等） | prompt `:248` | G（重试轮该分支无新 commit） | B |

**P28 有一个不可覆盖的洞**：agent 返回 `null`（死掉或被跳过）时走 `:420` 的兜底，没有任何 comment 被写。这个洞已记在 ADR 0002。

### 1.5 Review

| # | 命题 | 证据 | 观测面 | 类 |
|---|------|------|--------|---|
| P30 | review **只在 implement 产出 commit 后才跑**（D9） | `:419-423` | X（是否存在 `review:#N` agent） | A（编排）/ C（观测） |
| P31 | review 与 implement 是**两个不同模型的 agent**（opus/med vs sonnet/med），不能合并成一个 | `:33-34,418,423` | X | A |
| P32 | **review 是 merge 门禁**：不通过则 `bump` 并 `continue`，该分支**不合并** `v4/D4` | `:436-441` | T（issue 仍 open）+ G（`git branch --merged integ` 不含 `wf/issue-N`） | B |
| P33 | review 失败要留 comment，且 prompt 明确告知 agent「不会被合并」 `v4/D5` | prompt `:278-283` | T（comment） | B |
| P34 | nesting 降级：`/code-review` 无法 fan out 时退化为顺序跑两条轴，不降低 checklist 深度 | prompt `:271-273` | X | C |

### 1.6 Merge

| # | 命题 | 证据 | 观测面 | 类 |
|---|------|------|--------|---|
| P35 | merge **串行**，一次一个分支（`for` 循环，不是 `parallel`） | `:428-451` | G（merge commit 的时间序与父子序） | B |
| P36 | 用 `--no-ff`，message 为 `Integrate #N` | prompt `:294` | G（`git log --merges`） | B |
| P37 | 冲突**就地解决**，不重建分支、不盲目 abort | prompt `:295-297` | G（冲突轮里源分支 sha 不变） | B |
| P38 | post-merge 全套 gate；红则**只回滚这一个 merge**，issue 保持 open、分支进度保留 | prompt `:298-302` | G（integ tip 回到合并前）+ T（issue open） | B |
| P39 | clean + green 才 close，且 close comment **首行必须**是 `` Landed on `<integ>` as <sha>. `` `v4/D3` | prompt `:303-311` | T（`gh issue view N --comments`）+ 反查 `gh issue list --state closed --search "<integ>"` 应恰好召回这一轮关掉的全部 issue | B |
| P40 | 编排端只在 `result='clean' && testsPassed && issueClosed` **三者同时为真**时才计入 `completed` | `:444-446` | R.completed | A |
| P41 | **绝不 merge 进 integ 以外的分支，绝不 merge 进 base** | prompt `:313,343` | G（**base 分支 sha 全程不变**） | B |

P41 是整张表里最强的一条：断言完全确定、代价为零（跑前记一次 sha，跑后比一次），且它是这个 workflow 唯一的安全承诺。**它应当是第 1 层门禁里唯一一条「失败即整个用例作废」的断言。**

### 1.7 Set-aside 与计数

| # | 命题 | 证据 | 观测面 | 类 |
|---|------|------|--------|---|
| P42 | `bump` 在三处触发，且 reason 串可区分：`'build failed'` / `'review did not pass'` / merge 的 summary | `:432,438,448` | R.setAside[].reason（**只有进了 set-aside 的才看得到**） | B（部分） |
| P43 | **k=2**：`attempts >= MAX_ATTEMPTS` 时进 set-aside，且 reason 只记第一次 | `:365` | R.setAside | B |
| P44 | set-aside 的 issue 此后每轮都被排除：既经 planPrompt 的列表告知，也由 `classifyPlan` 兜底判 `invalid` | `:190-191,384,154` | R.setAside + X | A（兜底）/ C（planner 是否遵守） |
| P45 | set-aside 的 issue **保持 open**，分支进度保留 | 设计 §3 D6，`:467-469` | T + G | B |

### 1.8 终止

| # | 命题 | 证据 | 观测面 | 类 |
|---|------|------|--------|---|
| P46 | 轮次上限 `MAX_ROUNDS`（默认 10），用满则 `stoppedBy='max-rounds'` | `:374,455` | R.rounds + R.stoppedBy | A |
| P47 | 预算低于 120k 时在下一轮**开始前**停，`stoppedBy='budget'` | `:378-381` | R.stoppedBy | A |
| P48 | `stoppedBy` 取值恰为 `complete`/`blocked`/`max-rounds`/`budget`/`plan-failed`/`plan-invalid` 六选一 | `:455`,`:386,394,401,406,410` | R.stoppedBy | A |

### 1.9 Finalize 与返回

| # | 命题 | 证据 | 观测面 | 类 |
|---|------|------|--------|---|
| P49 | `unfinished` 覆盖三类来源并按号升序去重：knownCandidates（含**从未被尝试**的 deferred）、attempts、setAside | `:456-470` | R.unfinished | A |
| P50 | finalize 再拉一次 open leaves 做对账，union 进 unfinished，不含 umbrella | prompt `:325-330` | R.unfinished | B |
| P51 | push 集成分支并开 **draft** PR into base，**绝不自动合并** | prompt `:332-343` | R.pr/R.pushed + `gh pr view --json isDraft,baseRefName,state` | B |
| P52 | PR body 必须带「重跑前先合掉、或显式作废并 reopen 其 issue」的警告 `v4/D2` | prompt `:336-340` | `gh pr view --json body` | B |
| P53 | `push=false` 时不推、不开 PR | prompt `:342` | R.pushed=false, R.pr=null | B |
| P54 | 正常返回对象恰为 `{integrationBranch, baseBranch, completed, unfinished, setAside, rounds, stoppedBy, pr, pushed}` | `:479-489` | R | A |

### 1.10 元

| # | 命题 | 证据 | 观测面 | 类 |
|---|------|------|--------|---|
| P55 | **实际模型路由靠 `M` 表经 `agent()` 的 `{...M.x}` 直传，不靠 `meta.phases`**。`meta.phases` 的 title 只是声明；运行时每轮传的是 `phase('Round N')`（`:376,383`），与 `meta.phases` 里的 `Plan`/`Implement`/`Review`/`Merge` 对不上 | `:6-13,31-37,385,418,423,443` | 读码 | A |

P55 修正了 charting 阶段记在地图 Out of scope 里的那条候选缺陷（「`meta.phases` 名字对不上导致模型路由声明失效」）：**路由本身没有失效**，失效的只是 `meta.phases` 这份声明的展示价值。这条不需要用例来证，读码即可定案。

---

## 2. 统计

| 类 | 条数 | 含义 |
|---|------|------|
| A｜静态可判定 | 24 | 读码即可判定；`classifyPlan` 的 12 条（P06-P17）**可以脱离 GitHub 直接单测** |
| B｜需跑，二值确定 | 22 | 第 1 层门禁的主体 |
| C｜需跑，观测面缺失 | 9 | 现在断不了，见 §3 |

对第 8 号 ticket（判定标准）的直接输入：

- **A 类里的 `classifyPlan` 12 条应该先被拆出来做纯单测**，跑一次几毫秒、零成本、零非确定性。它们不该占用一次昂贵的真实跑动。真实跑动只用来验 B 类。
- **B 类才是「跑一轮」要换回来的东西**，一共 22 条。
- **C 类 9 条现在无解**，见下节。

## 3. 可观测性缺口（记录需求，不在本图实现）

按地图 Notes 与 #8 第 1 问的约定，这里只记录需求：

| 缺口 | 挡住了哪些命题 | 最小补法 |
|------|--------------|---------|
| G1 | 返回对象里没有「谁在第几轮落地」 | P21 P22 | `completed` 从 `[number]` 改成 `[{number, round}]`，或加 `rounds: [{round, batch, deferred, excluded}]` |
| G2 | plan 对象整体不进返回值：`excluded`/`deferred`/`candidates` 全丢 | P19 P20 P21 P22 P44 | 同上，一个逐轮 `trace` 数组一次性解决 G1+G2 |
| G3 | agent 返回 `null` 时不写失败 comment | P28 P33 的空洞 | 编排端在兜底分支补一次 comment —— 但运行时无 shell，只能再起一个 agent，代价与收益需权衡 |
| G4 | `attempts` 计数不进返回值，只有进了 set-aside 的才从 reason 串里透出来 | P42（失败一次但未 set-aside 的看不见） | `trace` 里带 attempts 快照 |
| G5 | 中止路径的返回对象形状（`{aborted}`）与正常路径完全不同 | P01 P02 的断言脚本 | 断言脚本必须先判形状；或统一返回形状 |

G1 + G2 是同一个补法：**一个逐轮 trace 字段**。它能把 C 类 9 条里的 6 条转成 B 类，是这张表给 v4 提出的最有价值的单点需求。

## 4. 与埋点 backlog 的对应（#7 的输入）

| 埋点 | 验证的命题 |
|------|-----------|
| 文件重叠的两张 ticket | P21（+ G1/G2 才能断言） |
| `blocked_by` 依赖链 | **P20**（最高优先级）、P13、P16 |
| 报表消费汇总的类型 | P22 |
| umbrella + sub-issue | P19 |
| 注定失败的 ticket | P28、P32、P42、P43、P45 |
| 任意一张正常落地的 ticket | P23-P27、P29-P31、P35-P41、P49-P54 |

「注定失败」那张同时承担 build 失败与 set-aside 两条路径；若还要单独验 **P32（review 门禁）**，需要一张**能做绿、但 review 必然挑出问题**的 ticket —— 这是 #7 尚未列出的第六类埋点，本清单在此提出。
