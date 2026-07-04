# Phase 4E-B: Belief Knowledge Contract

## Three-Layer Separation (Advisory Only)

| Layer | Table | Role | Advisory? |
|-------|-------|------|-----------|
| **1. Observation** | `experience_packets` | Raw event stream | Yes — passive capture, never reads |
| **2. Review Queue** | `memory_candidate_queue` | Pattern candidates (5 belief types + maintenance) | Yes — written by scanner, never promoted |
| **3. Consolidated State** | `belief_knowledge_store` | Advisory belief entries | **Yes — never injected into context or memories** |

## Contract Rules

1. **`memory_candidate_queue` = review queue only.** No candidate is ever promoted to durable memory or injected into any prompt. All write paths are purely advisory.

2. **`belief_knowledge_store` = advisory consolidated belief state.** Entries start at `status='candidate'`. No durable memory is ever created from a belief_knowledge_store row. No prompt injection reads from belief_knowledge_store.

3. **`memories` = durable confirmed recall.** Only user-initiated `csm_memory_save` or explicit memory extraction writes here. Belief knowledge never writes to `memories`.

4. **Context brief = not using belief_knowledge yet.** The `csm_memory_context` tool and the runtime context compiler do not query `belief_knowledge_store`. This will change only in Phase 4F under strict guardrails.

5. **No LLM interpretation at consolidation time.** The `BeliefKnowledgeConsolidator` uses only deterministic math (confidence/uncertainty clamping, contradiction tracking). No LLM is called.

6. **`csm_belief_knowledge` is read-only.** The tool queries `belief_knowledge_store` for display only. It does not call `consolidate()`.

## Acceptance Test Inventory

| Test | Verifies |
|------|----------|
| candidate_preference → belief_kind=preference | Kind mapping correctness |
| candidate_worldview → belief_kind=worldview | Kind mapping correctness |
| candidate_opinion → belief_kind=opinion | Kind mapping + neutral stance |
| candidate_belief is skipped | No mapping → no belief entry |
| duplicate candidate updates existing (reinforcement) | Confidence up, uncertainty down |
| contradiction increases uncertainty / lowers confidence | Contradiction tracking |
| status remains candidate/advisory by default | No auto-promotion |
| disabled config returns empty | Config gating |
| getAllBeliefs returns all | Read-back correctness |
| getBeliefsByKind filters | Kind filter |
| tool returns empty when no beliefs | Tool display |
| tool returns beliefs without kind filter | Tool display |
| tool filters by kind | Tool kind filter |
| tool does not write | Read-only guarantee |

## Future Phase 4F Guardrail Requirements

Before `belief_knowledge_store` can influence context:

- [ ] Explicit config flag `beliefKnowledge.injectContext` (default `false`)
- [ ] Only promoted status entries qualify
- [ ] Token-budgeted injection with hard limit
- [ ] All injected beliefs must be labeled as "advisory belief (not proven fact)"
- [ ] Drifted/stale entries excluded
- [ ] User can mute specific subjects via config

None of the above are implemented yet.