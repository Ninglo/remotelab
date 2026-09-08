#!/usr/bin/env node
import {
  loadUpgradePlan,
  executeRequestUpgrade,
} from "../lib/request-state-upgrade.mjs";
export async function runRequestStateUpgradeCommand(
  args,
  stdout = process.stdout,
) {
  if (args.includes("--help") || !args.length) {
    stdout.write(
      "Usage: remotelab upgrade-state <apply|rollback|status> --plan <instance-plan.json>\nApply resumes the same journal after interruption. See docs/request-state-upgrade.md.\n",
    );
    return 0;
  }
  if (args.length !== 3 || args[1] !== "--plan")
    throw new Error("Expected <apply|rollback|status> --plan <file>");
  const result = await executeRequestUpgrade(
    await loadUpgradePlan(args[2]),
    args[0],
  );
  stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}
import { pathToFileURL } from "node:url";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await runRequestStateUpgradeCommand(
      process.argv.slice(2),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
