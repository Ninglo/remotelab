# Codex command output and reply delivery

A large `rg` result can produce thousands of App Server `item/commandExecution/outputDelta` notifications. Building and queuing the entire growing command transcript for every delta caused quadratic JSON processing before spool clipping. In one observed request the model had already saved its final answer, while the detached output writer spent more than ten minutes draining command previews and withheld that answer.

The native driver now keeps a 4096-character command preview and the total output byte count. The host coalesces pending command previews while disk writes are busy, with lifecycle events forming ordering barriers. The authoritative completed command output still passes through the existing artifact storage in full. Agent messages, reasoning, command starts, completions and final answers retain their ordering and delivery semantics.

Regression checks stream 40 MiB through the driver and block the host writer until process exit while delivering 512 command notifications. They verify bounded previews, one pending update, complete final output and the final answer draining after command completion.
