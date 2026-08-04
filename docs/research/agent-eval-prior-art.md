# 调研：官方与业界的 agent workflow 评测先例

**Status:** 定稿 · **Date:** 2026-08-04 · 解决 [#12](https://github.com/liumingjian/implement-issues-workflow/issues/12)，属于地图 [#3](https://github.com/liumingjian/implement-issues-workflow/issues/3)

两路并行调研：官方（Anthropic / Claude Code / Agent SDK）与业界（评测框架 / 编码 agent benchmark / 轨迹断言 / 非确定性）。

---

## 0. 一句话结论

**外面没有能直接拿来用的东西，但有三样必须借的，和一条必须推翻的前提。**

- 必须借：**pass^k**（不是 pass@k）、**每次跑用一次性 fixture 而非清理复用**、**`claude -p` 是可脚本化的入口**。
- 必须推翻：#9 的「Workflow 只能在 Claude Code session 内发起，无法从裸 shell 调用」—— **错的**，官方文档明写 workflow 在 `claude -p` 和 Agent SDK 里都能跑，且 `-p` 模式下审批提示不会触发。
- 业界最强的那条建议（**把 GitHub 装进 fixture**）**在本项目不成立**，理由见 §3.2 —— 这反而把地图 Notes 3 从「一个选择」升级成「唯一可行解」。

---

## 1. 官方：有方法论，没有工具

### 1.1 唯一一份对口的官方文档

[Demystifying evals for AI agents](https://anthropic.com/engineering/demystifying-evals-for-ai-agents)（Anthropic Engineering，2026-01-09）。它几乎逐条对上了本图要做的事：

**「按环境终态判分，不按路径判分」是它的核心立场，不是脚注：**

> "The outcome is the final state in the environment at the end of the trial."
> "Grade what the agent produced, not the path it took."

它给的例子正是本图第 1 层的形状：验「数据库里真的存在这条预约」「订单真的被下了」。翻译到这里就是：判 **git 终态 + tracker 终态 + 测试退出码**，不判 transcript。**本 workflow 的 post-merge 全套 gate 本身就已经是它定义里的 deterministic grader。**

**「每次 trial 必须从干净环境开始」—— 它点名了本图 #6 正在纠结的那个坑：**

> "Each trial should be isolated by starting from a clean environment."
> "Shared state can also artificially inflate performance. For example, in some internal evals we observed **Claude gaining an unfair advantage on some tasks by examining the git history from previous trials**."

这是 Anthropic 自己内部评测踩到的。**直接支持 #6 的选项 1（一次性仓库 + 每轮重建）而不是选项 2（长期仓库 + 清理）。**

**其余可操作的点：**
- 规模：「20-50 simple tasks drawn from real failures is a great start」，来源应是「bug tracker and support queue」——即**从真实坏过的地方取样**，而不是凭设计文档臆造。
- deterministic grader「Fast, Cheap, Objective, Reproducible, Easy to debug」但「brittle to valid variations」；LLM judge 必须「calibrated against expert human judgment」、按维度拆开由**互相隔离**的 judge 打分、并且要给它「a way out — an instruction to return Unknown」。
- 非确定性：引入 **pass@k**（k 次至少一次成功）与 **pass^k**（k 次全部成功）。
- 点名的框架 —— Harbor、Braintrust、LangSmith、Langfuse、Arize/Phoenix，**没有一个是 Anthropic 自己的**。Harbor 由 Laude Institute 维护（[harbor-framework/harbor](https://github.com/harbor-framework/harbor)，MIT），是 Terminal-Bench 2.0 背后的 per-trial 容器 runner。官方态度是别纠结：「quickly pick a framework that fits your workflow, then invest your energy in the evals themselves」。

### 1.2 Claude Code Workflow 运行时：能用的

来自 [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows.md) 与 [headless docs](https://code.claude.com/docs/en/headless)：

- **workflow 在 `claude -p` 与 Agent SDK 中都受支持**；headless 文档明写「User-invoked skills and custom commands work in `-p` mode: include `/skill-name` in the prompt string」。
- **`-p` 模式下审批提示不触发**——「The run starts immediately.」全程可脚本化。
- `--output-format json` / `stream-json` 给出结构化结果、`session_id`、usage 与 `total_cost_usd`；退出码 0/非 0。
- **`--bare`** 跳过 hook/plugin/CLAUDE.md 自动发现，官方定位就是「you need the same result on every machine」——为可复现设计。
- `stream-json` 里子 agent 消息带 `parent_tool_use_id`；`--forward-subagent-text`（v2.1.211+）会吐出子 agent 文本，可重建每个 agent 的 transcript 与完整嵌套树。
- `args` 作为全局传给已保存的 workflow —— **每次 trial 可以换 fixture 参数而不改脚本**。

### 1.3 官方：看着能用但不能用的

- **Resume 不是 replay。**「Resume works within the same Claude Code session. If you exit Claude Code while a workflow is running, the next session starts the workflow fresh.」更糟的是缓存规则：「Cached results stop at the first agent that didn't finish, and every agent that started after that one runs again, even if it completed.」这是**中断后的省钱机制，不是确定性重放**。不要把评测策略建在它上面。
- **Transcript JSONL 官方拒绝背书**：「The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release.」**没有稳定的 transcript schema 可断言。**
- **Console Evaluation tool** 是 prompt 级的（`{{variable}}` + CSV），跑不了多 agent 编排、看不到 git 状态。名字有迷惑性，不适用。
- 运行时上限会影响 fixture 设计：最多 16 并发 agent、单次 run 1000 个 agent、运行中无法接受用户输入、**workflow 脚本本身无文件系统与 shell**。
- 子 agent 恒定跑在 `acceptEdits` 模式；未列入白名单的 Bash/MCP 调用仍会卡住 run —— **CI 里必须预置白名单，否则会挂起**。

### 1.4 官方：不存在的

没有 dry-run、没有 `agent()` 的 mock/stub、没有随机种子、没有 `--replay`、没有把上次 run 的 agent 输出喂回脚本离线重跑的能力。TypeScript SDK reference 里**没有 Workflow 的一等公民入口**。

### 1.5 一个意外收获：OTel 可能顶掉 #4 提出的 `trace` 字段

[observability docs](https://code.claude.com/docs/en/agent-sdk/observability.md)：`CLAUDE_CODE_ENABLE_TELEMETRY=1` + `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` 产出 `claude_code.interaction` / `llm_request` / `tool` / `hook` span，且**子 agent 的 span 嵌套在父 `claude_code.tool` span 下，整条委派链是一条 trace**。

这意味着 [#4](https://github.com/liumingjian/implement-issues-workflow/issues/4) 记的 G1/G2 缺口（「谁在第几轮落地」「plan 对象不进返回值」）**可能不必改 workflow 就能观测**。但它是 **beta**，官方明说「span names and attributes may change between releases」。结论：**当作诊断手段，不当作门禁数据源** —— 与地图 Notes 4 对 LLM 打分的态度同构。

---

## 2. 业界：框架

| 框架 | 适配 | 判断 |
|---|---|---|
| **Inspect AI**（UK AISI） | **FITS** | 唯一一个把 sandbox（Docker/K8s/Modal/…）+ 真实副作用 + **纯 Python code scorer** + 重复跑统计凑齐在一处的。`events` transcript 可程序化读取（`read_eval_log_samples()`），scorer 可以是纯断言函数、模型不入环。epochs + reducer 里直接有 `pass_at`（pass@k）与 **`pass_k`（k 次全过，τ-bench 的可靠性指标）**。想要真正的 harness 而不是自写脚本，就是它 |
| **LangChain AgentEvals** | 部分 | 借它的**四种匹配模式**（`strict` / `unordered` / `subset` / `superset`），别用产品本身——它假定 LangChain 消息形状的 trajectory 和托管 LangSmith 后端 |
| **Promptfoo** | **借词汇表** | 断言词汇最直接可抄：`trajectory:tool-used`、`trajectory:tool-sequence`（「必须先取信息再动手」）、`trajectory:tool-args-match`、`trajectory:step-count`、`trace-span-count`、`trace-error-spans`。就是「B 不能在 A 之前跑」「这个工具恰好被调两次」的配置化形态。全部读 **OTel span 属性**。runner 本身是 prompt 中心的，驱动不了 worktree 流水线 |
| **Braintrust** | 部分 | code scorer 与 LLM judge 并存，trace 级 scorer 能拿到整条执行轨迹；同一套 scorer 离线/CI/线上通吃。**适合存放与追踪昂贵跑动的结果趋势**，但不编排、不复位环境 |
| **Langfuse / Phoenix / Weave / AgentOps** | **不适配** | 全是 observability 优先。不跑流水线、不复位外部状态。只能当**被断言的 trace 汇点** |
| **OpenAI Evals** | **不适配** | 已死：2026-10-31 只读，2026-11-30 关停。忽略 |

## 3. 业界：fixture 与状态复位

### 3.1 通用模式：不可变镜像 + 一次性容器，**从不原地清理**

SWE-bench 每个 instance 一个 Docker 镜像，仓库 reset 到 `base_commit`、挂在 `/testbed`，**每个测试各自一个容器**。Terminal-Bench（Harbor harness，ICLR 2026）是「断言副作用」这条直觉最锋利的先例：task = 指令 + Dockerfile + 测试 + oracle 解，而**测试验的是容器终态的性质，明确不验 agent 的命令与控制台输出**。

**一条必须抄的教训**：SWE-bench 的镜像曾泄漏 `base_commit` 之后的 commit，agent 用 `git log`/`git show` 就能读到真答案（[arXiv:2606.12344](https://arxiv.org/html/2606.12344v1)）。**demo 仓库的 git 历史是 fixture 的一部分，必须截断，不能只是 checkout。** 与 §1.1 里 Anthropic 的同类警告是同一件事。

### 3.2 业界最强的建议，在这里不成立

业界唯一处理「可变外部状态」的先例是 **τ-bench**：它比对每次 task 后的**数据库终态**与标注的目标态——而它做得到，是因为**它自己拥有一个可复位的本地 DB，而不是去和厂商说话**。由此得出的通用建议是：**别去复位真实 GitHub，把 GitHub 装进 fixture**（Gitea 容器或 [kiegroup/mock-github](https://github.com/kiegroup/mock-github)），复位就退化成 `docker rm`。

**这条在本项目不成立。** 本 workflow 被验的机制里一大半是 **GitHub 独有**的：leaf-only 靠 `sub_issues_summary.total`，阻塞靠**原生 issue dependencies**（`dependencies/blocked_by`），落地靠 `gh issue close`。Gitea 有自己的 issue dependency 概念，但没有 GitHub 的 sub-issues API，`gh` 也不指向它；mock-github 伪造的是 octokit，覆盖不到这两组端点。**把 GitHub 换成 fixture，等于把最想验的那几条命题（[#4](https://github.com/liumingjian/implement-issues-workflow/issues/4) 的 P19/P20/P22）全部验没了。**

调研结论因此是**反向的**：地图 Notes 3（tracker 用真实 GitHub）不是一个可选项，而是**唯一可行解**——代价是必须自己承担业界从未解决过的那个问题。而既然如此，§1.1 与 §3.1 的一致建议就更硬了：**用一次性仓库重建，不要原地清理**。原地清理不幂等，业界没有一个人这么做。

> **诚实结论**：没有任何已发表的做法教你「在真实 github.com 上跨轮次 reopen issue / 删分支 / 关 PR」。整个领域是**绕开**了这个问题（把外部服务做进镜像），不是解决了它。

## 4. 业界：轨迹断言

先例是真实的，且在向 OTel 收敛。OTel GenAI semantic conventions 已定义 agent span：`create_agent`、`invoke_agent`、`invoke_workflow`、`plan`、`execute_tool`，必填 `gen_ai.operation.name` / `gen_ai.provider.name` —— 但**全部仍是 Development stability**（2026-05 仍如此）。**OTel span 可以当被断言的产物**（promptfoo 已经这么做），但鉴于其状态：**自己钉死一份 span schema，把 OTel 名字当作「我发出的约定」而不是「我依赖的契约」。**

支持本图第 3 层存在必要性的硬引用：Kirgis, Kapoor, Steinhardt, Narayanan, *"Log analysis is necessary for credible evaluation of AI agents"*（[arXiv:2605.08545](https://arxiv.org/abs/2605.08545)，2026-05-08）—— 只看终态 pass/fail 会掩盖**抄近路**与危险动作；在 τ-Bench Airline 上，日志分析显示 pass^5 被低估了近 50%。**这条与 §1.1 的「grade the outcome, not the path」构成张力，而本图的三层结构恰好是这个张力的解**：第 1 层判终态（门禁），第 3 层读轨迹（只读，防抄近路）。

## 5. 业界：非确定性

- **T=0 也有方差。** METR：「the variance in task success can be large across repeated runs, even with identical agents and task prompts, and even when using T=0」（[metr.org, 2024-08-06](https://metr.org/blog/2024-08-06-update-on-evaluations/)）。
- Miller（Anthropic），*Adding Error Bars to Evals*（[arXiv:2411.00640](https://arxiv.org/abs/2411.00640)）：报标准误、**用配对差分比较两个系统**、做 power analysis 定样本量、当心 clustered sampling（clustered SE 可达 naive 的 **3 倍**）。
- **跑动昂贵时的停止规则**（METR）：先跑一次，算 bootstrap 95% CI，**只在 CI 尚未越过阈值时才继续跑**（[evaluations.metr.org/example-protocol](https://evaluations.metr.org/example-protocol/)）。
- **指标选 pass^k（k 次全过），不是 pass@k。** pass@k 奖励「蒙对一次」，正是「这台机器还按设计运转吗」的反面。一个 5 次里干净合并 3 次的编排器就是坏的。τ-bench 的 pass^k 是对的形状，Anthropic 的 model card 现在也报这个。
- **实际 N**：公开建议是「3+ 次取平均以吸收非确定方差」，pass@k 在小 N 下不稳。**没有人公开过「单次跑动要好几美元」情形下的 N**；诚实的答案是 **N=3 + 一个配对的基线**，不是 N=1。
- **「系统退化」还是「模型今天状态不好」**：公认答案是**配对比较 + 趋势，不是绝对阈值**。把每次跑动的 JSON 滚动提交进 git，对**持续漂移**告警，而不是对单次跑动划线。

---

## 6. 落到本图的行动项

按价值排序。前三条改变已有 ticket，后四条是 #8 的直接输入。

| # | 结论 | 影响 |
|---|------|------|
| 1 | **`claude -p "/implement-issues ..."` + `--bare` + `--output-format json` 是可脚本化入口**，`-p` 下不触发审批 | **[#9](https://github.com/liumingjian/implement-issues-workflow/issues/9) 的第 2 问前提是错的**，必须改写。入口可以是一条真正的 shell 脚本，边界不必划在「人手动起 Workflow」那里 |
| 2 | **一次性仓库重建 > 长期仓库清理**，两路调研独立给出同一结论；且 **git 历史必须截断**（Anthropic 与 SWE-bench 都踩过 agent 读历史抄答案） | **[#6](https://github.com/liumingjian/implement-issues-workflow/issues/6) 第 1 问已有强推荐答案**，第 2 问（清理覆盖面）多半整段作废 |
| 3 | 「把 GitHub 装进 fixture」是业界解法，但**在本项目不成立**（Gitea/mock 都没有 sub-issues 与原生 dependencies） | **地图 Notes 3 从「已锁的选择」升级为「唯一可行解」**，并且要接受：这个问题业界没有先例可抄 |
| 4 | **pass^k（全过），N=3，配对基线，看趋势不划绝对线** | #8 第 5 问的答案 |
| 5 | **断言终态，不断言控制台输出**（Terminal-Bench 的契约）；但只看终态会掩盖抄近路（arXiv:2605.08545）——三层结构正是这个张力的解 | 验证地图 Notes 4 的分层，且给第 3 层找到了存在理由 |
| 6 | Promptfoo 的断言词汇（`tool-sequence` / `tool-used` / `step-count`）+ AgentEvals 的四种匹配模式（并行 implement 段用 `unordered`/`subset`，串行 merge 段才用 `strict`） | #8 第 1/2 问写断言时直接照抄这套词汇 |
| 7 | Claude Code 的 **OTel 增强遥测**（beta）能拿到嵌套子 agent span，或许不改 workflow 就能填上 [#4](https://github.com/liumingjian/implement-issues-workflow/issues/4) 的 G1/G2 —— 但 schema 不稳定，**只作诊断，不作门禁** | #8 第 4 问（第 3 层记什么）的候选数据源 |

**不要引入的**：OpenAI Evals（关停中）；Langfuse/Phoenix/Weave/AgentOps 当 harness（只是 trace 汇点）；AgentEvals/Braintrust 的 LLM-judge trajectory scorer（地图 Notes 4 已排除，且它把你正要测量的方差又引了回来）；SWE-smith 式的 task 自动生成（这里只需要一个 fixture，不是 5 万个）；把 OTel GenAI 约定当硬依赖。

**唯一值得认真考虑引入的现成物是 Inspect AI**（§2）：sandbox + 纯 code scorer + `pass_k` reducer 齐全。但它是 Python 生态、要把 `claude -p` 包成一个 external agent，且它的 sandbox 对本项目没用（§3.2 —— 我们必须打真实 GitHub）。**建议：先自写脚本，把 pass^k 与配对基线这两件事做对；只有当用例数量涨到需要统计基础设施时才回头看 Inspect AI。**
