# Pool B 重置卡审批

Pool B 的 `reset-credit` 通过 Feishu 群完成一次性人工确认。创建申请只写入待审批记录并发送群消息，不调用消费接口；只有申请人（或后续接入的明确审批人）在同一群、同一话题回复 `批准 Reset <request-id>` 后，连接器才会以原申请的幂等键调用 `reset-credit --confirm`。

申请记录默认保存在 `~/.config/remotelab/feishu-connector/pool-b-reset-approvals/`。账号必须填写 Pool B 的实际槽位，例如 `codex_a_4`；`Lucysw` 这类显示名不能直接当作槽位使用，需先核对实时账号映射。

```bash
node scripts/pool-b-reset-approval.mjs request \
  --account codex_a_4 \
  --account-label Lucysw \
  --chat-id oc_xxx \
  --thread-id omt_xxx \
  --requester-open-id ou_xxx \
  --reason '容量失败补救测试' \
  --cards-available 2
```

命令输出包含应发到群里的审批文本。群内回复 `拒绝 Reset <request-id>` 会关闭申请；过期、群或话题不匹配、非申请人回复都会拒绝执行。每个申请只带一个幂等键，执行结果和命令回执保存在本地记录中。
