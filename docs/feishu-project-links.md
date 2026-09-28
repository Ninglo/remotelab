# Feishu project-linked context pilot

An instance may explicitly pair one discussion chat with one work chat in its
Feishu Connector config:

```json
{
  "projectLinks": [{
    "projectId": "example-project",
    "discussionChatId": "oc_discussion",
    "discussionChatName": "Example discussion group",
    "workChatId": "oc_work"
  }]
}
```

On a new message in the work chat, the Connector adds up to eight recent human
messages from the paired discussion chat to that message's source context. It
uses only allowed events already stored by this Connector, looks back at most
24 hours and at most 2 MiB of the event log, and limits the text to about 3,600
characters. Thread replies are included when they arrived as Connector events;
each excerpt carries its original message ID and chat or thread link. A failed
context read does not block the current message.

The direction is deliberately discussion to work. Work-chat messages are not
copied into the larger discussion chat, and the feature does not create a new
project ledger, send messages between chats, or change the scheduled daily
review's source whitelist. The imported text is a lead for the receiving Agent,
not a fresh instruction or an accepted project decision. Verify original
messages before relying on a decision or changing permissions or execution.

This is a time-bounded context pilot. It is not a full message archive or a
replacement for the project ledger. Messages absent from the Connector event
log, attachments, older discussion, and later edits or recalls may require a
fresh source read.
