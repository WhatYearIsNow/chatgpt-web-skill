# prompts/ — ChatGPT 通道的提示词资产库

> 目的：把"拿到 ChatGPT 高质量回答"的杠杆从每次发挥变成**结构化资产**。外审/提示词优化/生图三场景的模板与规范在此版本化——引擎（CLI 与 MCP）是通道，提示词是通道的弹药。
>
> 期一（本目录现状）= 外审族模板，抽象自 2026-11-07/08 **shouxie-mcp 八轮真实外审**的全部提示词与产出。设计依据吸收社区主流经验（OpenAI / Anthropic 官方指南、G-Research LLM 代码审查工具工程报告、LLM-as-judge 与 meta-prompting 实践），来源与映射见文末。

## 目录

```
prompts/
├── README.md                     # 本文件：使用指南 + 设计依据
├── common/
│   ├── output-contract.md        # 输出契约：分级枚举/判定表/一句话理由/前置判据/好评确认
│   ├── evidence-standards.md     # 证据标准：三值证据等级/可独立核验清单/格式陷阱速查
│   └── round-protocol.md         # 轮次协议：外审状态机/每轮生成规则/收敛实证
└── review/
    ├── first-audit.md            # 初次审计模板（FINDINGS）
    ├── regression-recheck.md     # 回归复审模板（REGRESSION）
    └── evidence-check.md         # 证据核验模板（EVIDENCE，可选阶段）
```

## 使用指南（外审全流程）

1. **送审准备**：按 `common/evidence-standards.md` 的清单组织交付物与证据（陷阱速查表逐项过）。
2. **初次审计**：填 `review/first-audit.md` 的槽位送出。**必看**：输出契约要求复审者同时给出「整改验收标准」（行为性）——它是下一阶段的验收契约，前期拿到可消除"证据格式"类返工（实证：shouxie 第五~八轮的三次返工均可由此预防，预计 8 轮收敛可缩至 4-5 轮）。
3. **整改**：按验收标准逐条整改；每条修复附"测试真实命中分支"的证据。
4. **回归复审**：填 `review/regression-recheck.md`（上轮发现→整改映射表逐行对应，缺项显式标注）。
5. **证据核验**（如判定含证据条件）：填 `review/evidence-check.md`。
6. **轮次管理**：状态流转与每轮生成规则见 `common/round-protocol.md`；任何轮不得引入上轮判据之外的新形式要求。

## 设计依据（社区主流经验 → 本库映射）

调研时间 2026-11-08；要点映射如下，完整来源见本节末尾链接。

| 来源 | 吸收的要点 | 落点 |
|---|---|---|
| G-Research《Building a code review tool: the LLM patterns that actually work》 | 两遍审查（第一遍召回/第二遍过滤）；"the model can suggest, but never define"（标准唯一事实来源）；每条发现对应规则与位置；**测试行为而非措辞** | first-audit 的两遍式方法节；立场边界第 3 条；regression 的行为性验收 |
| OpenAI《Prompt engineering》（官方） | Identity/Instructions/Examples/Context 分层；生产 prompt 存于代码并版本化；rubric 自评迭代；验收标准与 eval 套件 | 模板四段骨架；本目录版本化；round-protocol 的轮次自评 |
| Anthropic《Prompting best practices》 | XML 标签划槽位、multishot 3-5 例、prompt chaining（每轮含前序响应） | 模板 `<deliverable>` `<background>` `<remediation-map>` 标签；regression 的映射表输入 |
| LLM-as-judge 实践（Agenta/Evidently/Confident AI 等） | rubric 枚举防 label drift；判定依据 + 一句话理由；迭代轮次的判定契约 | output-contract 的分级枚举与一句话理由收尾 |
| Meta-prompting 共识（PromptHub 等） | 输出格式明确 + 结构抽象 + 迭代 refine；"先追问澄清再产出" | 期二 optimize 模板的设计原则（未在本期交付） |

**本库与社区经验的差异点**（我们的实证增量）：
- 外审是**多轮状态机**而非单 prompt——轮次协议（前置判据/停止条件/防漂移条款）来自八轮实证，社区资料多为单轮审查场景
- 证据标准独立成文——多轮准入复审中，**证据格式返工**占总轮次的 3/8，单轮资料不会涉及
- 好评确认（"做得好的地方"）作为防方向性误判的必填节——实证中复审者的方向确认避免了推倒重来

## 维护原则

- 模板更新必须注明实证来源（哪次外审的哪条教训）——无实证不改进。
- 槽位填充质量同样走本库闭环：重要提示词本身可送外审复审（自举）。
- 期二（提示词优化族 optimize/）与期三（生图族 image/）按实战需求追加，不提前空占目录。

## 来源

- [G-Research: Building a code review tool — the LLM patterns that actually work](https://www.gresearch.com/news/building-a-code-review-tool-the-llm-patterns-that-actually-work)
- [OpenAI: Prompt engineering (official guide)](https://developers.openai.com/api/docs/guides/prompt-engineering)
- [Anthropic: Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Anthropic: The Complete Prompt Engineering Guide](https://www.anthropic.com/learn/prompt-engineering)
- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [PromptHub: A Complete Guide to Meta Prompting](https://www.prompthub.us/blog/a-complete-guide-to-meta-prompting)
- [Agenta: LLM as a Judge — guide & best practices](https://agenta.ai/blog/llm-as-a-judge-guide-to-llm-evaluation-best-practices)
- [Evidently AI: LLM-as-a-Judge — a complete guide](https://www.evidentlyai.com/llm-guide/llm-as-a-judge)
