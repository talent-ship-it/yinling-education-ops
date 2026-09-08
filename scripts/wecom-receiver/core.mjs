import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function readBot(dir) {
  const key=Buffer.from(fs.readFileSync(path.join(dir,'.encryption_key'),'utf8').trim(),'base64');
  const data=fs.readFileSync(path.join(dir,'credentials.enc'));
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
  decipher.setAuthTag(data.subarray(-16));
  const clear=Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]);
  const creds=JSON.parse(clear.toString()); clear.fill(0); key.fill(0);
  if(!creds.bot?.id || !creds.bot?.secret) throw new Error('missing_bot_credentials');
  return creds.bot;
}
export function atomicJson(file,value) {
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  const fd=fs.openSync(tmp,'wx',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(value)+'\n'); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
  fs.renameSync(tmp,file);
}
const storageUsage=new Map();
export function saveMessage(dir,body,{maxBytes=512*1024*1024}={}) {
  if(typeof body?.msgid!=='string' || !body.msgid) throw new Error('missing_msgid');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,crypto.createHash('sha256').update(String(body.aibotid)+'\0'+body.msgid).digest('hex')+'.json');
  if(fs.existsSync(file)) return false;
  // Only one process is permitted by the launcher's flock. Store callbacks privately;
  // response_url is a temporary send capability and is intentionally not persisted.
  const {response_url: ignored,...message}=body;
  void ignored;
  const record={received_at:new Date().toISOString(),message};
  const bytes=Buffer.byteLength(JSON.stringify(record))+1;
  if(bytes>1024*1024) throw new Error('payload_limit');
  if(!storageUsage.has(dir)) {
    let total=0;
    for(const name of fs.readdirSync(dir)) total+=fs.statSync(path.join(dir,name)).size;
    storageUsage.set(dir,total);
  }
  const disk=fs.statfsSync(dir);
  if(storageUsage.get(dir)+bytes>maxBytes || disk.bavail*disk.bsize<1024*1024*1024+bytes) throw new Error('storage_limit');
  atomicJson(file,record);
  storageUsage.set(dir,storageUsage.get(dir)+bytes);
  return true;
}
export function disableSending(client) {
  for(const method of ['reply','replyStream','replyWelcome','replyTemplateCard','replyStreamWithCard','updateTemplateCard','sendMessage','uploadMedia','replyMedia','sendMediaMessage']) {
    client[method]=()=>{throw new Error('receive_only');};
  }
}
