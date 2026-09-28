# Feishu project-linked context pilot

An instance may explicitly pair one discussion chat with one work chat in its
Feishu Connector config:

```json
{
  "projectLinks": [{
    "projectId": "example-project",
    "discussionChatId": "oc_discussion",
    "discussionChatName": "Example discussion group",
    "workChatId": "oc_work",
    "handoffCards": false
  }]
}
```

On a new message in the work chat, the Connector adds up to 20 recent human
messages from the paired discussion chat to that message's source context. It
uses only allowed events already stored by this Connector, looks back at most
24 hours and at most 2 MiB of the event log, and limits the text to about 6,000
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

For a selected project link, `handoffCards: true` enables the discussion-group
handoff trial. The quick classifier nominates only a clear decision to start
work; the Connector then retrieves up to 100 messages (48,000 characters) from
the source chat or thread and checks the decision again before posting a card
under the source message. Clicking **Move to work group** creates one work-chat
topic and a Session bound to it, with the retrieved discussion and source link.
Clicking **Continue discussion** closes that proposal. Persistent records and
stable Feishu message UUIDs prevent repeated clicks or restarts from opening
duplicate topics. Unbound discussion-thread replies can nominate a handoff
without receiving reply-status reactions. On confirmation, current group
membership is checked again; the work-group members must all be in the
discussion group before source content is transferred. This requires
`card.action.trigger` callbacks enabled for the
app in the Feishu Developer Console. The proposal uses Card JSON 2.0 callback
buttons; the existing Connector WebSocket handles
those callbacks. If callbacks are not enabled, cards can display but buttons
will not reach the Connector. A detected candidate is only a suggestion: no
work topic is created until a human clicks the card.
