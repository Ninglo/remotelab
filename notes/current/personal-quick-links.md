# Personal quick links in Amber

Amber places a Person's configured quick links below the pet's quota and To do
buttons. A single link can point to an existing work-document directory so people
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
