# Quick Sessions

Quick is a creation-time Session profile for low-latency questions. A Quick
Session stays Quick for its entire lifetime: Harness, model, and effort cannot
be changed after creation. Create a Standard Session when a task needs tools,
live data, files, or external actions.

Quick uses the normal RemoteLab Session, history, context, delivery, and memory
pipelines. It does not introduce a second execution service. The profile:

- pins one runtime (`codex`, `gpt-5.6-luna`, `low` by default);
- omits Agent templates and custom system prompts;
- tells the model to return a concise final answer without tools or progress;
- disables Codex apps and skips session-start preflight;
- retains normal conversation continuation and memory processing.

The fixed runtime can be configured before the service starts:

```bash
REMOTELAB_QUICK_TOOL=codex
REMOTELAB_QUICK_MODEL=gpt-5.6-luna
REMOTELAB_QUICK_EFFORT=low
```

In Chat UI, choose `Quick` before sending the first message. Runtime selectors
then disappear, and the attached Session shows a locked Quick badge. In a
Feishu group or topic, start one with:

```text
/quick

你的问题
```

Inspect latency from durable request, runner, first-answer, completion, and
connector-delivery timestamps:

```bash
remotelab quick-stats --days 7
remotelab quick-stats --days 7 --json
```
