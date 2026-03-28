# Object-Storage File Assets

RemoteLab can offload large session attachments to an external S3-compatible object store instead of pushing the full file body through the main `7690` chat service.

Current MVP scope:

- browser / client asks RemoteLab for an upload intent
- client uploads the file directly to object storage via presigned `PUT`
- chat composer starts that direct upload as soon as the user picks the file, then sends only `assetId` references when the message is submitted
- RemoteLab stores a session-bound file-asset record
- session messages can attach that asset by `assetId`
- the detached runner localizes the asset to local disk right before tool execution
- successful CLI workflows can publish generated local result files back into the session as downloadable asset attachments
- downloads go through a stable RemoteLab route that redirects to object storage while preserving the original filename in the final response

This keeps large byte transfer off the main chat service while preserving the existing session/run model.

## Environment

Set these variables before starting `chat-server.mjs`:

```bash
export REMOTELAB_ASSET_STORAGE_BASE_URL="https://<storage-endpoint>/<bucket>"
export REMOTELAB_ASSET_STORAGE_REGION="auto"
export REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID="..."
export REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY="..."

# Optional
export REMOTELAB_ASSET_STORAGE_PROVIDER="s3"
export REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL="https://<cdn-or-public-bucket-origin>"
export REMOTELAB_ASSET_STORAGE_KEY_PREFIX="session-assets"
export REMOTELAB_ASSET_STORAGE_PRESIGN_TTL_SECONDS="3600"
export REMOTELAB_ASSET_DIRECT_UPLOAD_ENABLED="1"
```

Examples:

- Cloudflare R2: `https://<accountid>.r2.cloudflarestorage.com/<bucket>`
- Path-style S3: `https://s3.<region>.amazonaws.com/<bucket>`
- Virtual-host S3: `https://<bucket>.s3.<region>.amazonaws.com`
- Volcengine TOS: `https://<bucket>.tos-<region>.volces.com`

If `REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL` is set, download redirects can use that stable public origin. Otherwise RemoteLab generates fresh presigned `GET` URLs on demand.

For Volcengine TOS, set `REMOTELAB_ASSET_STORAGE_PROVIDER="tos"` unless you already use a `*.volces.com` endpoint that RemoteLab can auto-detect. TOS uses its own `X-Tos-*` signing scheme rather than AWS `X-Amz-*`, so generic S3-style presigning is not enough.

If you provide a path-style TOS base URL like `https://tos-cn-beijing.volces.com/<bucket>`, RemoteLab rewrites it to the required virtual-host form automatically.

If your bucket is private, leave `REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL` unset so downloads keep using short-lived presigned `GET` URLs.

If bucket CORS is not ready yet, set `REMOTELAB_ASSET_DIRECT_UPLOAD_ENABLED="0"`. RemoteLab still offloads server-published files and can re-publish server-ingested uploads into object storage after receipt, while the browser keeps using the older non-direct-upload path.

## Browser CORS

For browser direct uploads, the bucket must allow cross-origin `PUT` from your RemoteLab origin.

Allow at least:

- methods: `PUT`, `GET`, `HEAD`, `OPTIONS`
- headers: `content-type`
- origins: your RemoteLab app origin
- exposed headers: `etag` if you want the browser to see it

For example, if your main RemoteLab host is `https://remotelab.example.com`, that exact origin needs to be present in the bucket CORS rules before browser-direct uploads can work.

RemoteLab also extends page CSP automatically to allow the configured object-storage origins for direct uploads and media previews.

## Current limitations

- Uploads are single-request presigned `PUT`s, not resumable multipart uploads yet.
- File assets are currently session-bound for access control.
- The runner localizes attached assets just before execution; very large files still take time to pull onto the worker machine.
- Automatic result publication currently relies on detecting successful output-file paths from tool command output; highly custom workflows may still need explicit publishing hooks.
