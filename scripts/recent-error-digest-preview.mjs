import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { CONFIG_DIR, PUBLIC_BASE_URL } from '../lib/config.mjs';
import { digestOptions, readDigestWindow, renderRecentErrorDigest } from '../lib/recent-error-digest.mjs';
import { validateRepairReceipts, repairReports } from '../lib/recent-error-repairs.mjs';
import { recentErrorsConfig } from '../lib/recent-errors.mjs';

const {values}=parseArgs({options:{since:{type:'string'},until:{type:'string'},analyze:{type:'boolean'}}});
if (![values.since,values.until].every(v=>v && /(?:Z|[+-]\d{2}:\d{2})$/i.test(v))) throw Error('Use --since and --until with ISO timestamps including timezone');
const config=await recentErrorsConfig();
if (config?.enabled!==true) throw Error('Recent errors is not enabled');
const since=Date.parse(values.since),until=Date.parse(values.until);
const db=new DatabaseSync(join(CONFIG_DIR,'recent-errors.sqlite'),{readOnly:true});
const prepare=(store,sql)=>store.prepare(sql);
try {
  const groups=readDigestWindow(db,prepare,{since,until,now:Date.now()});
  const analyze=values.analyze ? (await import('../chat/recent-error-alerts.mjs')).analyzeRecentErrors : null;
  const {valid,invalid}=await validateRepairReceipts(config.repairs);
  const repairs=valid.length && db.prepare("SELECT 1 FROM sqlite_master WHERE name='error_repair_tracking'").get()
    ? repairReports(db,prepare,{repairs:valid,now:until-1}) : [];
  console.log(await renderRecentErrorDigest({...digestOptions(config.groupAlerts),groups,since,until,publicBase:PUBLIC_BASE_URL,analyze,repairs,invalid}) || '本期为空');
} finally { db.close(); }
