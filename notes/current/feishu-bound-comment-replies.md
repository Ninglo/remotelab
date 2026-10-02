# Bound document replies stay in the document

A user bound a project document to an existing Feishu topic Session. A real comment was admitted and answered, but the final reply appeared only in the topic. The comment API still returned only the human inputs. Successful intake and a processing reaction therefore did not prove comment delivery. A Session-specific maintenance instruction also disappeared when the chat connector refreshed its configured instructions.

New document bindings now capture an explicit comment reply destination on each input. The Session keeps its original chat conversation and serial queue; only this request's final answer goes to the original document comment. Runtime instructions use the current input's surface, request plain text, and prevent an additional manual reply. Handling rules travel with the comment rather than depending on mutable Session instructions. Body edits remain subject to the existing task authorization and preserve comment anchors.

Existing bindings keep their legacy manual-reply behavior until explicitly migrated with `bind --reply-mode comment`. Policy changes preserve the intake cursor and do not reroute already admitted work. Tests cover original-Session execution, exact comment and Bot matching, durable outbox deduplication, receipt isolation, progress suppression, and unchanged legacy workflows.
