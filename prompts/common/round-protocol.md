# 外审轮次协议：状态机与每轮生成规则

> 外审不是一个 prompt，是一个**状态机**。每轮提示词由当前状态 + 上轮产出生成。协议经 shouxie-mcp 八轮外审实证收敛（该八轮实际上按此协议执行，只是当时未显式化）。

## 状态机

```
INIT ──→ FINDINGS ──→ REMEDIATION ──→ REGRESSION ──→ [EVIDENCE] ──→ APPROVED
  │          │              │               │              │
  └── 送审准备（first-audit 模板 + 交付物打包，按 evidence-standards 组织证据）
```

| 状态 | 使用模板 | 输入 | 输出 |
|---|---|---|---|
| FINDINGS | review/first-audit.md | 交付物 + 背景槽 | 发现清单（P0-P2）+ **整改验收标准**（行为性）+ 好评确认 + 下一轮判据 |
| REMEDIATION | （整改方执行，不是提示词） | 上轮验收标准 | 整改 PR + 测试证据 |
| REGRESSION | review/regression-recheck.md | 上轮发现 + 修复映射表 | 逐项判定表 + 终判/下一轮条件 |
| EVIDENCE（可选） | review/evidence-check.md | 证据包 | 逐项判定 + 终判 |
| APPROVED | — | — | 部署期验证清单生效 |

## 每轮生成规则

1. **输入组装**：当前状态对应模板 + 上轮报告的关键节（映射表/验收标准/判定）+ 整改方新证据。
2. **槽位填充**：模板内 `{{槽位}}` 逐个填充；填不了的项目显式写"未提供"，不得虚构。
3. **契约引用**：输出格式节统一引用 `common/output-contract.md` 的判定表与分级定义；证据类引用 `common/evidence-standards.md`。
4. **停止条件**：REGRESSION 全部闭环且证据充分 → 直接批准（实证教训：不要为了谨慎制造新形式门槛——shouxie 第八轮的两项"格式收尾"若早按 evidence-standards 组织，可省一轮）。
5. **防漂移**：任何轮不得引入上轮判据之外的新形式要求（可建议，但标注"建议后续轮采纳，不阻断本轮"）。

## 轮次收敛的实证数据

shouxie-mcp：8 轮收敛（发现 22 → 11 → 10 → R4 → 测试 → 证据 → 证据 → 格式 → 批准）。返工项分析：
- 第五轮 N2 注入时机错、第六轮证据格式、第七八轮 manifest/URL 格式——**全部可通过"初次审计即产出行为性验收标准 + 按 evidence-standards 组织证据"预防**
- 预计理想收敛：4-5 轮（发现 → 整改 → 回归 → 证据 → 批准）
