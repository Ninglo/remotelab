# Codex Auth Deletion Bug Evidence

## RED command

```text
node tests/test-chat-instance-sync.mjs
```

## RED result

Exit code: `1`

```text
node:fs:441
    return binding.readFileUtf8(path, stringToFlags(options.flag));
                   ^

Error: ENOENT: no such file or directory, open '/tmp/remotelab-chat-instance-sync-DUJBIy/operator-home/.codex/auth.json'
    at readFileSync (node:fs:441:20)
    at file:///home/ubuntu/.remotelab/workspace/remotelab-feishu-v2-merge/tests/test-chat-instance-sync.mjs:71:5
    at ModuleJob.run (node:internal/modules/esm/module_job:439:25)
    at async node:internal/modules/esm/loader:633:26
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5) {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '/tmp/remotelab-chat-instance-sync-DUJBIy/operator-home/.codex/auth.json'
}

Node.js v24.16.0
```

The test uses a disposable HOME. The failure proves that `sync --instance-root`
deleted the caller HOME's Codex auth when the sync source had no Codex auth.
