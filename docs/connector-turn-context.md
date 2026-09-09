# Connector metadata in turn Context

Connector inputs carry `text`, attachments and `sourceContext` independently. Text contains the normalized user content. Sender labels, platform message/thread IDs, email headers and ingestion status belong to sourceContext. Quoted document text and comment history are source context; actual email body representations remain message content.

The existing Request record freezes these inputs at admission. Feishu initial/default forks, explicit forks and continued messages use the same message-context builder. Forking selects the Session; it does not select a reduced input format. WeChat already submits separate metadata, and both email workers and GitHub intake now do so too.

For standard prompts, `buildTurnContextHook` projects this request's sourceContext through `source-context-prompt.mjs`. During preparation the manager computes the turn Context once, stores it in the Run manifest, embeds it in the private prompt block and records the identical content as the existing `manager_context` timeline event. Recovery restores a missing event from the manifest. Duplicate admission preserves the original snapshot. No extra model call is involved.

The projection never looks up the latest message in the Session and never reads `sourceDelivery`. Metadata is labelled as source data, with selected fields and escaped markup. Long strings and arrays are abbreviated for the prompt; full message metadata remains available at `/api/sessions/:id/source-context?requestId=:requestId`. Stable Session source metadata keeps its existing size limit. Message context is retained independently so a long document quotation cannot erase all of the current message's IDs.

An initial Feishu group input may have a message ID but no thread ID: the platform thread can be created only when the connector replies. Preserve that absence. Subsequent inputs carry their observed thread ID and use the existing binding mechanism.

This reuses the existing Context UI and privacy rules: guest instances do not persist manager Context, and tools explicitly configured with `promptMode: bare-user` retain their prompt contract. Already prepared Runs and Inbox handoffs replay exactly as saved; historical message text is not rewritten. New inputs use the new format after the controller and their connector process load the change.

Verification covers first/resumed prompts, default/explicit forks, clean connector text, attachment failures, queue isolation, duplicate requests, and SIGKILL recovery with a missing Context event. All fixtures use isolated instances and local fake transports.
