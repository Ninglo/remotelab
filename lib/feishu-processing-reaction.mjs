// Processing feedback follows the accepted input, independently of the model's
// social reaction and reply location. Both edges use the existing durable outbox.
export function feishuProcessingReaction(record, processingState) {
  const options = record.options || {};
  const plan = record.deliveryPlan || options.sourceDelivery;
  if (options.feishuConnectorAuthenticated !== true
      || options.sourceContext?.feishuProcessingReaction !== true
      || options.deliveryOnly || options.internalOperation || options.routingSource
      || plan?.connector !== 'feishu' || !plan.target?.messageId || plan.target.commentId) return [];
  return [{ ...plan, kind: 'reaction', processingState,
    emojiType: processingState === 'active' ? 'THINKING' : null, text: '' }];
}
