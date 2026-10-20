import { feishuResponseError } from './delivery-errors.mjs';

export const CARD_RENEWAL_AGE_MS = 13 * 86400_000;
export const CARD_RENEWAL_NOTICE = '旧卡片已满13天，更换新卡片';
export const isFeishuCardExpired = error =>
  Number(error?.feishuCode ?? error?.response?.data?.code ?? error?.code) === 230031;

// Legacy records must use the provider's creation time, not a new local age.
export async function readCardCreatedAt(runtime, messageId) {
  const result = await runtime.appClient.im.v1.message.get({ path: { message_id: messageId } });
  if (result?.code) throw feishuResponseError(result, '卡片发送时间读取失败。');
  const item = result?.data?.items?.find(item => item.message_id === messageId);
  const createdAt = Number(item?.create_time);
  if (!(createdAt > 0) || createdAt > Date.now() + 5000) throw new Error('卡片原发送时间不可核实，未更换卡片。');
  return createdAt;
}
