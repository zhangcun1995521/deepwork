# The same domain, asked in Chinese

A second real session against the bundled example domain — same data, same derived tools, question
asked in Chinese. Kept because it shows two things the English session does not: the tool surface
is language-independent (the agent chose the same four declared queries), and the answer follows
the reader's language while the domain's own values stay as declared.

**问题**

> 哪些项目存在风险或已经延期？分别由谁负责？各自还有哪些未闭环的高危问题？请基于本体回答。

**它调用的（全部是域里声明的查询）**

| 调用 | 次数 | 声明来源 |
|---|---|---|
| `at_risk_projects` | 2 | `filter_by` on `Project` where status ∈ {AtRisk, Delayed} |
| `open_issues_of` | 2 | `traverse` along the issue relation, filtered to open |
| `high_severity_open_issues` | 2 | `filter_by` on `Issue`, open and high |
| `accountable_for` | 1 | `traverse` along the accountability relation |
| `ontology_find` | 1 | a structural read |

**回答**

以下结论全部基于本体的项目、人员与问题数据。

## 一、有风险 / 已延期的项目

| 项目 | 客户 | 状态 | 交付负责人 | 计划交付日 | 合同额 |
|---|---|---|---|---|---|
| **P-2026-001** | Northwind Logistics（CUST-NORTHWIND） | **AtRisk（有风险）** | **Wei Lin（EMP-LIN，Delivery Lead）** | 2026-11-30 | €480,000 |
| **P-2026-003** | Helios Energy（CUST-HELIOS） | **Delayed（已延期）** | **Wei Lin（EMP-LIN，Delivery Lead）** | 2026-10-15 | €610,000 |

两个项目的**问责人（accountable）都是 Wei Lin**。作为对照，同客户的 P-2026-002（Northwind，负责人 Ada Okafor）状态为 OnTrack，不在风险清单内。

## 二、未闭环的高危（high）问题

**P-2026-001（AtRisk）— 2 个高危未闭环问题：**
- **ISSUE-101**（2026-08-12 提出，指派 Ada Okafor / EMP-OKAFOR，Senior Engineer）：报关数据接口（customs feed）的稳定接口仍未达成一致，阻塞集成。
- **ISSUE-103**（2026-09-18 提出，指派 Wei Lin / EMP-LIN）：客户网络团队尚未开放所需的防火墙网段。
- 另有 1 个中危未闭环问题：ISSUE-102（回归测试套件覆盖率不足约定验收标准的一半，指派 Ilya Petrov）。

**P-2026-003（Delayed）— 1 个高危未闭环问题：**
- **ISSUE-105**（2026-09-08 提出，指派 Ilya Petrov / EMP-PETROV，QA Engineer）：替代逆变器（inverter）机组供应商交货又推迟两周。

## 三、值得注意的两点
1. **风险集中在 Wei Lin 身上**：他既是两个风险/延期项目的问责交付负责人，同时又是 P-2026-001 中一个高危问题的直接指派对象（ISSUE-103），存在"既问责又亲自解阻塞"的集中度风险。
2. **P-2026-001 是双重风险**：接口未冻结（ISSUE-101）+ 客户侧环境未就绪（ISSUE-103），一个是内部技术/需求问题，一个是外部客户依赖；P-2026-003 的延期则源自供应链（ISSUE-105）。

本体的原始数据中，ISSUE-101/102/103 与 ISSUE-105 的状态均为 `open`，因此上述高危问题**尚未闭环**。

**两点值得注意**

答案里多了一句英文会话没有的对照：*"同客户的 P-2026-002 状态为 OnTrack，不在风险清单内"* —— 它用一个反例说明清单是完整的。这不是被要求的，是声明式的查询让它能顺手问到。

另一句是 *"原始数据中状态均为 open"* —— 中文叙述，英文枚举值照原样引用。域里怎么声明，就怎么说，翻译只发生在外层叙述。
