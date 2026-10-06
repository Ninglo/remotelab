# Personal quick links in Amber

Amber places a Person's configured quick links in the bear's tool menu alongside
quota and To do. The menu starts collapsed; click the bear or its ellipsis to
expand it. A single link can point to an existing work-document directory so people
can find their outputs without searching older conversations. No document copies
or personal destination URLs are embedded in shipped code.

Use the existing authenticated `PATCH /api/people/:id` with `quickLinks`, an array
of up to six `{ label, url }` entries. An empty array removes the entries. This
uses the shared instance's existing People-management permission; it is personal
navigation, not a new resource access boundary. The destination still enforces
its own access permissions.

Labels use plain text; destinations must be absolute HTTP(S) URLs without
embedded credentials. The frontend renders only the signed-in Person's entries,
opens them in a separate tab and refreshes after People updates. Preferences
survive restarts and follow the account between browsers. Other themes do not
display the pet's links. The directory itself remains the one place to maintain
document destinations.

The bear's position and size stay in the current Person's browser, with separate
desktop and mobile layouts. This does not change the account-backed quick links.
