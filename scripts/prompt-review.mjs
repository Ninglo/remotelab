#!/usr/bin/env node
import { launchPromptReview, runPromptReview, readPromptReview } from '../chat/prompt-review.mjs';
import { initUsageLedger, closeUsageLedger } from '../chat/usage-ledger.mjs';

try {
  if (process.argv.includes('--launch')) console.log(JSON.stringify(await launchPromptReview()));
  else if (process.argv.includes('--status')) {
    const { rows, ...summary } = await readPromptReview(); console.log(JSON.stringify(summary));
  } else {
    await initUsageLedger();
    const result = await runPromptReview({ onProgress: progress => console.log(JSON.stringify(progress)) });
    console.log(JSON.stringify(result));
    await closeUsageLedger();
  }
} catch (error) {
  console.error(`Prompt review failed (${error.code || error.name || 'unknown'}); failed inputs remain unreviewed.`);
  process.exitCode = 1;
}
