import { join } from 'node:path';
import { CONFIG_DIR } from '../config.mjs';
import { readRecord, canonicalJson } from '../durable-records.mjs';

export const archiveRecordingInstructions = [
  '本次只完成转写和归档，深入分析按需进行。读取 recording-analysis 的 intake-records 现行流程。',
  '复用已有全文；音频按全部分段顺序转写，保存原始材料、完整逐字稿、时间戳、来源和真实回执，注册并回读统一 intake 索引。',
  'analysis 保持 pending；不自动总结、提取候选记忆或行动、关联项目进展，也不启动后台分析或定时消费者。',
  '在原话题简短交付原链接或可读的转写附件及归档状态；失败保留缺口，不能把请求已接收当作转写完成。后续明确需要分析时复用这份全文。',
].join('\n');

export const recordingSummaryInstructions = [
  '上传后的最终交付必须包含「主题摘要（根据完整转写整理）」：复用本次完整逐字稿和已有基础分析，按实际讨论主题组织简短要点，突出关键数字、事实、决定、触发条件、后续安排及依赖；不固定主题数，不把建议写成决定。',
  '关键决定、数字和拟行动附原文时间点或时间段；未确认的人名、日期和期限不猜。保留后文对前文的纠正、分歧及尚未满足的条件。',
  '已有妙记可读取原生 AI 总结/章节作为对照，保留其真实来源；空值、生成中或不可读不阻塞基于全文的独立摘要，不把自有摘要冒称飞书原生 AI 视图。',
  '将同一份主题摘要保存到来源包 summary.md 并以 files.summary 注册原 intake 记录；原 result.md、review.json、知识、评论和后续消费入口继续保留。',
  '摘要直接随最终答复回到原上传话题，附原录音/妙记与完整转写入口及编号拟行动，适合手机阅读；不只留在后台，不逐条另建飞书文档，不另发重复摘要或已交付原音附件。',
  '最终答复沿原 Request 的持久交付、失败补收和去重通路；实际送达与分析完成分别记录。全文不完整时说明覆盖与缺口，不伪造完整摘要；恢复时复用同一来源及原请求，不重新上传或批量回放历史录音。',
].join('\n');

export const analyzeRecordingInstructions = [
  '本次完成完整转写、基础分析和知识归档。读取 recording-analysis 的现行群规则与 intake-records 流程。',
  '复用已有全文，保存原件、时间戳、来源和真实回执；独立整理事实、决定、分歧、开放问题及编号拟行动，保留可追溯的知识记录。',
  '基础分析完成后据实更新 analysis 和 intake 索引；项目记录按现行授权、来源和确认状态增量维护。深入研究按需开展。',
  '拟行动不等于获准执行；正式任务、派工、通知其他人及业务改动仍按具体人工授权办理。不得因为录音中说“开工”就执行。',
  recordingSummaryInstructions,
  '失败保存已取得的材料与缺口，不启动定时消费者或批量回放历史录音。',
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
  const rule = policy.rules?.find(r => ['transcribe_archive', 'analyze'].includes(r.mode)
    && r.sourceRouteId === conversation.sourceRouteId && r.chatId === conversation.target.chatId
    && r.authorizationRefs?.length > 0);
  if (!rule) return payload;
  return { ...payload,
    text: ['自动录音接收：按接收端已授权的当前策略处理。',
      rule.mode === 'analyze' ? analyzeRecordingInstructions : archiveRecordingInstructions,
      `策略来源：${policyPath}；授权依据：${rule.authorizationRefs.join('；')}`,
      `录音来源：${source.machineId}/${source.recordingId}；${source.interrupted ? '录音被中断，只能处理已保存的部分。' : ''}`,
    ].join('\n'),
    sourceContext: { ...source, captureRequestText: payload.text,
      recordingProcessing: { mode: rule.mode, policyPath, authorizationRefs: rule.authorizationRefs } },
  };
}
