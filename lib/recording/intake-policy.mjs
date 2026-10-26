import { join } from 'node:path';
import { CONFIG_DIR } from '../config.mjs';
import { readRecord, canonicalJson } from '../durable-records.mjs';

export const archiveRecordingInstructions = [
  '本次只完成转写和归档，深入分析按需进行。读取 recording-analysis 的 intake-records 现行流程。',
  '复用已有全文；音频按全部分段顺序转写，保存原始材料、完整逐字稿、时间戳、来源和真实回执，注册并回读统一 intake 索引。',
  'analysis 保持 pending；不自动总结、提取候选记忆或行动、关联项目进展，也不启动后台分析或定时消费者。',
  '在原话题简短交付原链接或可读的转写附件及归档状态；失败保留缺口，不能把请求已接收当作转写完成。后续明确需要分析时复用这份全文。',
].join('\n');

// Receiving-instance defaults only replace the recorder's automatic template.
// Human follow-ups and other destinations retain their original request text.
export async function applyRecordingIntakePolicy(payload, session, options = {}) {
  const source = payload?.sourceContext;
  if (payload?.nativeQuestionId || source?.connector !== 'recording'
    || !source.machineId || !source.recordingId
    || payload.requestId !== `recording:${source.machineId}:${source.recordingId}`) return payload;
  if (options.priorRequest) {
    const prior = options.priorRequest;
    const { captureRequestText, recordingProcessing, ...originalSource } = prior.options.sourceContext || {};
    // A changed policy must not break recovery after an accepted reply was lost.
    // Changed caller content still reaches the normal fingerprint rejection.
    return recordingProcessing && captureRequestText === payload.text
      && canonicalJson(originalSource) === canonicalJson(source)
      ? { ...payload, text: prior.text, sourceContext: prior.options.sourceContext } : payload;
  }
  const conversation = session?.conversation;
  if (conversation?.connector !== 'feishu' || !conversation.target?.chatId) return payload;
  const policyPath = options.policyPath || join(CONFIG_DIR, 'recording-intake-policy.json');
  const policy = await readRecord(policyPath);
  if (policy?.enabled !== true) return payload;
  const rule = policy.rules?.find(r => r.mode === 'transcribe_archive'
    && r.sourceRouteId === conversation.sourceRouteId && r.chatId === conversation.target.chatId
    && r.authorizationRefs?.length > 0);
  if (!rule) return payload;
  return { ...payload,
    text: ['自动录音接收：按接收端已授权的当前策略转写归档。', archiveRecordingInstructions,
      `策略来源：${policyPath}；授权依据：${rule.authorizationRefs.join('；')}`,
      `录音来源：${source.machineId}/${source.recordingId}；${source.interrupted ? '录音被中断，只能处理已保存的部分。' : ''}`,
    ].join('\n'),
    sourceContext: { ...source, captureRequestText: payload.text,
      recordingProcessing: { mode: rule.mode, policyPath, authorizationRefs: rule.authorizationRefs } },
  };
}
