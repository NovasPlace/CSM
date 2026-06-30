# Continuity Engine

**Continuity Engine** is an open-source continuity layer for AI systems.

It gives AI coding assistants a durable memory of their work, their decisions, their lessons, and the project they are helping build. Instead of forcing an assistant to start from zero every session or burn context rereading the same information, Continuity Engine captures what matters, stores it, compresses it, and brings back only the context that is useful for the current task.

The goal is simple: help AI systems keep working with continuity.

Continuity Engine is not just a memory plugin. It is a persistence, recall, compaction, checkpoint, journaling, and documentation system designed to make long-running AI development sessions more reliable, more efficient, and easier to resume.

---

## What This System Does For You

When you use an AI coding assistant without continuity, every new session has the same problems:

- the assistant forgets what happened before;
- you repeat project context again and again;
- important decisions disappear into old chats;
- long tool outputs consume huge amounts of context;
- mistakes get rediscovered instead of avoided;
- sessions become harder to resume as the project grows.

Continuity Engine solves those problems by giving the assistant a structured memory layer outside the model's limited context window.

It watches the work, records useful information, stores it in PostgreSQL, retrieves relevant context when needed, and keeps the active prompt focused instead of overloaded.

In practical terms, it helps your assistant remember:

- what the project is;
- what files and systems matter;
- what changed recently;
- what goals are active;
- what errors happened before;
- what lessons were learned;
- what checkpoints were created;
- what decisions should not be repeated or reversed;
- where the previous session left off.

---

## Why Continuity Matters

Large language models can reason well, but their working memory is temporary. A model may solve a problem in one session, then lose the context that made the solution possible in the next session.

Continuity Engine separates long-term project knowledge from short-term model context.

Instead of stuffing every past message into the prompt, it builds a living knowledge base and returns compact, relevant context only when it is needed.

This makes the assistant feel less like a disposable chat window and more like a long-running development partner that can build on prior work.

---

## Core Capabilities

### Persistent Memory

Continuity Engine stores meaningful memories across sessions. These can include project facts, user preferences, architectural decisions, lessons, repo knowledge, conversation summaries, and procedural knowledge.

Memories survive restarts and can be searched, recalled, ranked, and injected into future sessions.

### Semantic Retrieval

The system does not blindly reload everything it has ever seen.

It searches for memories relevant to the current task using vector search, full-text search, entity matching, and fallback text search. This keeps the assistant focused on useful context instead of stale noise.

### Context Compaction

Long sessions create huge amounts of text, especially from tool calls, test output, logs, and repeated assistant reasoning.

Continuity Engine distills large outputs into compact summaries and references while preserving important signals. Raw evidence can be retained outside the prompt so the assistant can recover details later without carrying everything in active context.

### Context Pressure Management

The engine monitors prompt pressure and helps prevent the working context from becoming overloaded.

When a session grows too large, it can generate compact continuation briefs, preserve recent work, and reduce unnecessary prompt load while keeping the important continuity intact.

### Checkpoints

Continuity Engine can save durable checkpoints of important session states.

A checkpoint acts like a structured handoff: what was happening, what changed, what failed, what succeeded, and what should happen next.

This makes it easier to resume work after a restart, a compaction, or a fresh session.

### Agent Work Journal

The system records the agent's work as it happens.

Tool calls, decisions, milestones, errors, and session boundaries can become part of a structured work journal. Future sessions can use that journal to understand the previous agent's path instead of guessing from scattered messages.

### Lessons Learned

When something goes wrong and gets fixed, Continuity Engine can preserve the lesson.

This lets future sessions avoid repeating the same mistake. Lessons can become high-value memories that influence planning, verification, and tool use.

### Project Knowledge

Continuity Engine builds a durable understanding of the codebase over time.

It can preserve repository facts, architecture notes, file relationships, implementation decisions, system maps, and development history. This turns project context into searchable knowledge instead of one-off chat history.

### Auto Documentation

The system can help maintain documentation from actual project activity.

As the agent works, Continuity Engine can update maps, decisions, changelogs, architecture notes, and other project documents so the knowledge base stays aligned with the codebase.

### Governance and Evidence

Continuity Engine is designed to distinguish between what is known, what is inferred, and what is missing.

It can preserve evidence anchors, classify memory provenance, and avoid treating weak assumptions as confirmed facts. This matters for trustworthy long-running agent behavior.

---

## What It Is Not

Continuity Engine is not a replacement for the model.

It does not make a small model magically become a frontier model. It does not remove the need for verification. It does not guarantee perfect recall.

Instead, it gives models better infrastructure:

- durable memory;
- compact context;
- structured recall;
- resumable sessions;
- evidence-backed project knowledge.

The model still reasons. Continuity Engine helps it remember what it should be reasoning from.

---

## Current Focus

This repository currently focuses on an OpenCode-oriented continuity plugin backed by PostgreSQL and pgvector.

The system includes memory capture, semantic search, context compilation, compaction, checkpoints, bridge/handoff support, work journals, lessons, and auto-documentation components.

The broader direction is a host-neutral continuity engine that can support multiple AI coding surfaces and agent runtimes.

---

## Quick Start

```bash
npm install
npm run build
npm run verify
```

PostgreSQL with pgvector is required for the full memory and retrieval system.

See the documentation in `docs/` for architecture notes, phase evidence, store submission planning, and implementation details.

Useful starting points:

- `docs/ARCHITECTURE.md` — design and system architecture
- `docs/STORE_SUBMISSION.md` — public plugin/store submission plan
- `docs/PHASE32_CONTEXT_GOVERNOR_RESULTS.md` — context governor evidence
- `docs/PHASE33_TRACE_VAULT_RESULTS.md` — trace vault and evidence distillation results

---

## High-Level Architecture

```text
AI Assistant / Host Runtime
        |
        v
Continuity Engine
        |
        |-- Memory capture
        |-- Semantic retrieval
        |-- Context compilation
        |-- Tool-output distillation
        |-- Checkpoints
        |-- Work journal
        |-- Lessons
        |-- Auto documentation
        |
        v
PostgreSQL + pgvector
```

The model stays focused on the current task. Continuity Engine handles the persistent context layer around it.

---

## Who This Is For

Continuity Engine is for builders who want AI assistants to work across more than one conversation.

It is useful if you are:

- building long-running software projects with AI agents;
- tired of repeating the same context every session;
- trying to reduce token waste from giant histories and tool outputs;
- experimenting with persistent memory for coding assistants;
- building local-first or host-neutral AI infrastructure;
- designing agents that need structured recall, evidence, and handoff.

---

## Philosophy

Continuity Engine is built around one core idea:

> Intelligence is amplified by continuity.

Models are powerful, but temporary context limits how much they can build on their own prior work.

Continuity Engine gives AI systems a durable layer of experience: what happened, what mattered, what changed, what failed, what worked, and what should be remembered next time.

That continuity makes agents more useful, more consistent, and less wasteful.

---

## Status

Continuity Engine is under active development.

The current implementation is experimental but functional, with ongoing work around context governance, evidence vaulting, host-neutral bridge support, memory provenance, and safe long-session continuity.

Expect rapid iteration, changing APIs, and frequent architecture improvements as the system evolves.

---

## License

See the repository license for usage terms.
