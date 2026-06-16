# WhatsApp Business Connector Setup

This connector targets **WhatsApp Business Platform Cloud API**.

Current first-pass scope:

- receive inbound webhook messages
- map one WhatsApp user thread to one RemoteLab session
- wait for RemoteLab reply publication
- send plain-text replies back through Cloud API
- expose a small internal binding surface inside RemoteLab

Not included yet:

- template-message sends
- media uploads / downloads
- multi-number routing inside one connector runtime
- delivery analytics or status-thread projection

## What You Need From Meta

- a Meta app with WhatsApp enabled
- one WhatsApp Business Account (`WABA ID`)
- one business phone number (`Phone Number ID`)
- an access token with `whatsapp_business_messaging`
- a webhook verify token you choose
- ideally the app secret as well, so webhook POST signatures can be verified

## Product Shape

The intended shape is:

- keep Meta app, webhook, token handling, and routing on the platform side
- keep the internal bind page small
- keep later user-facing onboarding even smaller

This internal page is for the platform owner or operator connecting one WhatsApp Business number. It is **not** for downstream chat contacts.

## Internal Bind Page

Open:

- `/connectors/whatsapp-business`

The page will auto-start the local connector runtime if needed.

Prepare only:

- `verify token` — required
- `phone number ID` — required
- `access token` — required
- `app secret` — recommended
- `WABA ID` — optional

The page shows the exact webhook URL to paste into Meta.

## Where To Get Each Value

### Verify token

You choose this value yourself. Meta does **not** generate it for you.

Use any random secret string, save it in RemoteLab, then paste the exact same string into the Meta webhook verification form.

### Phone number ID

Find it in one of these places:

- `Meta App Dashboard > WhatsApp > Quickstart`
- `Meta App Dashboard > WhatsApp > API Setup`
- `WhatsApp Manager` phone number details

### Access token

For testing:

- use the temporary token shown in `Meta App Dashboard > WhatsApp > Quickstart` or `API Setup`

For production:

- use a system-user token with at least `whatsapp_business_messaging`
- usually also include `whatsapp_business_management`
- `business_management` may also be needed when working with business portfolio resources

Meta's Cloud API overview currently lists these token types for Cloud API: system user access tokens, business integration system user access tokens, and user access tokens.

### App secret

Find it in:

- `Meta App Dashboard > Settings > Basic`

This is recommended because it allows RemoteLab to verify webhook POST signatures.

### WABA ID

Find it in:

- `Meta App Dashboard > WhatsApp > Quickstart` account information
- `Meta App Dashboard > WhatsApp > API Setup`
- `WhatsApp Manager`

This is optional for the current connector. It is only needed if you want the connector page to call the `subscribed_apps` endpoint for you.

For the new minimal mode, you can leave `WABA ID` blank in the first pass and come back to it later.

## Meta Dashboard Steps

1. Paste the callback URL shown in RemoteLab into the WhatsApp webhook settings.
2. Paste the same verify token.
3. Subscribe the app to the `messages` field.
4. Subscribe the app to the `messages` field in Meta.
5. If you later need `subscribed_apps`, save the `WABA ID` and run that call from backend tooling instead of exposing another user-facing control.

## Local Runtime

Manual foreground run:

```bash
npm run whatsapp:connect
```

Managed background run:

```bash
npm run whatsapp:connect:instance
```

Status:

```bash
node scripts/whatsapp-business-connector.mjs status --json
```

## Notes

- Public webhook ingress uses the normal RemoteLab domain under `/connectors/whatsapp-business/webhook`.
- The connector declares that webhook path as public; the rest of the setup surface remains owner-only.
- Free-form reply messages work well for inbound conversations. Proactive outbound or business-initiated messaging will need template support in a later pass.

## Product Guidance

Keep this page internal and minimal. Do not expose advanced runtime settings or token plumbing in later user-facing flows.
