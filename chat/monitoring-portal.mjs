import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CONFIG_DIR} from '../lib/config.mjs';
// An instance-owned presentation destination; no credentials or API forwarding.
export function normalizeMonitoringPortal(value) {
 if(value?.enabled!==true)return null;
 try {const u=new URL(value.url);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)return null;
  return {url:u.href};}catch{return null}
}
export async function readMonitoringPortal(path=join(CONFIG_DIR,'monitoring-portal.json')){
 try{return normalizeMonitoringPortal(JSON.parse(await readFile(path,'utf8')))}catch{return null}
}
