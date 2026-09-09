import fs from 'node:fs';
import path from 'node:path';
import AiBot,{generateReqId} from '@wecom/aibot-node-sdk';
import {readBot,atomicJson,saveMessage,restrictSending,botMessageId,replyTarget} from './core.mjs';
process.umask(0o077);
const data=process.env.WECOM_RECEIVER_DATA || '/home/codex/.local/share/wecom-receiver';
fs.mkdirSync(data,{recursive:true,mode:0o700});
const messagesDirectory=path.join(data,'messages');
const acknowledgementsDirectory=path.join(data,'acknowledgements');
fs.mkdirSync(acknowledgementsDirectory,{recursive:true,mode:0o700});
const status={state:'starting',started_at:new Date().toISOString(),received_this_run:0,initial_replies_this_run:0,acknowledgements_this_run:0,acknowledgement_failures_this_run:0};
function update(state){status.state=state;status.updated_at=new Date().toISOString();atomicJson(path.join(data,'status.json'),status);}
const INITIAL_REPLY='正在收录，请稍候…';
const FINAL_REPLY='已收录到系统审核队列。';
const ACTIVE_REPLY={msgtype:'markdown',markdown:{content:FINAL_REPLY}};
const STREAM_REPLY_TTL_MS=5*60*1000;
const ACK_FILE_TTL_MS=15*60*1000;
const pendingReplies=new Map();
const acknowledgementAttempts=new Map();
let acknowledgementLoopBusy=false;
function errorCode(error){return String(error?.code || 'reply_failed').replace(/[^A-Za-z0-9_-]/g,'').slice(0,80) || 'reply_failed';}
function idFromAckName(name){const match=/^([a-f0-9]{64})\.json$/.exec(name);return match ? `bot:${match[1]}` : '';}
function sourceTarget(id){
  const file=path.join(messagesDirectory,`${id.slice(4)}.json`);
  try{return replyTarget(JSON.parse(fs.readFileSync(file,'utf8')).message);}catch{return '';}
}
function queueReply(frame){
  try {
    const id=botMessageId(frame?.body);
    const pending={frame,streamId:generateReqId('archive'),target:replyTarget(frame.body),receivedAt:Date.now()};
    pendingReplies.set(id,pending);
    return [id,pending];
  } catch { return []; }
}
async function sendInitialReply(pending){
  try {
    await client.replyStream(pending.frame,pending.streamId,INITIAL_REPLY,false);
    pending.initialSentAt=Date.now();
    status.initial_replies_this_run+=1;
  } catch(error) {
    pending.initialReplyError=errorCode(error);
    status.initial_reply_failures_this_run=(status.initial_reply_failures_this_run || 0)+1;
  }
  update('authenticated');
}
function removeAcknowledgement(file,id){
  try { fs.unlinkSync(file); } catch(error) { if(error?.code!=='ENOENT') throw error; }
  pendingReplies.delete(id);
  acknowledgementAttempts.delete(id);
}
async function flushAcknowledgements(){
  if(acknowledgementLoopBusy) return;
  acknowledgementLoopBusy=true;
  try {
    let names=[];
    try { names=fs.readdirSync(acknowledgementsDirectory).filter(name=>name.endsWith('.json')).sort(); } catch { return; }
    for(const name of names){
      const id=idFromAckName(name);
      const file=path.join(acknowledgementsDirectory,name);
      if(!id) continue;
      let stat;
      try { stat=fs.statSync(file); } catch { continue; }
      const pending=pendingReplies.get(id);
      const age=Date.now()-stat.mtimeMs;
      if(!pending && age>ACK_FILE_TTL_MS){
        try { fs.unlinkSync(file); } catch(error) { if(error?.code!=='ENOENT') status.acknowledgement_failures_this_run+=1; }
        continue;
      }
      let payload;
      try { payload=JSON.parse(fs.readFileSync(file,'utf8')); } catch { continue; }
      if(payload?.messageId!==id){
        if(age>ACK_FILE_TTL_MS){try{fs.unlinkSync(file);}catch{}}
        continue;
      }
      const attempt=acknowledgementAttempts.get(id) || {count:0,nextAt:0};
      if(attempt.nextAt>Date.now()) continue;
      const target=pending?.target || sourceTarget(id);
      try {
        if(pending && !pending.initialReplyError && Date.now()-pending.receivedAt<STREAM_REPLY_TTL_MS){
          await client.replyStream(pending.frame,pending.streamId,FINAL_REPLY,true);
        } else {
          if(!target) { if(age>ACK_FILE_TTL_MS) removeAcknowledgement(file,id); continue; }
          await client.sendMessage(target,ACTIVE_REPLY);
        }
        removeAcknowledgement(file,id);
        status.acknowledgements_this_run+=1;
        status.last_acknowledgement_at=new Date().toISOString();
      } catch(error){
        const count=attempt.count+1;
        acknowledgementAttempts.set(id,{count,nextAt:Date.now()+Math.min(60000,1000*2**Math.min(count,5))});
        status.acknowledgement_failures_this_run+=1;
        status.last_acknowledgement_error=errorCode(error);
      }
      update('authenticated');
    }
  } finally { acknowledgementLoopBusy=false; }
}
const bot=readBot(process.env.WECOM_CLI_CONFIG_DIR || '/home/codex/.config/wecom');
const client=new AiBot.WSClient({botId:bot.id,secret:bot.secret,maxReconnectAttempts:-1,maxAuthFailureAttempts:2,logger:{debug(){},info(){},warn(){},error(){}}});
// The receiver is still receive-only for all business actions. The only two
// enabled methods are used with fixed acknowledgement bodies below: the
// immediate stream placeholder and its post-commit update/fallback.
restrictSending(client,{allow:['replyStream','sendMessage']});
client.on('connected',()=>update('connected'));
client.on('authenticated',()=>{status.authenticated_at=new Date().toISOString();update('authenticated');});
client.on('disconnected',()=>update('disconnected'));
client.on('reconnecting',()=>update('reconnecting'));
client.on('error',e=>{
  status.error_code=String(e.code || 'sdk_error').replace(/[^A-Za-z0-9_-]/g,'').slice(0,80);
  if(e.code==='WS_AUTH_FAILURE_EXHAUSTED' || e.code==='WS_RECONNECT_EXHAUSTED') {
    // Release flock so the next keepalive reloads potentially rotated credentials.
    client.disconnect();update('terminal_connection_error');process.exit(1);
  }
  update('error');
});
client.on('message',frame=>{
  try {
    if(saveMessage(messagesDirectory,frame.body)){
      status.received_this_run++;
      status.last_message_at=new Date().toISOString();
      const [id,pending]=queueReply(frame);
      if(id && pending) void sendInitialReply(pending);
    }
    update('authenticated');
  }
  catch { fs.writeFileSync(path.join(data,'paused'),'Storage failure or quota reached. Inspect storage before resuming.\n',{mode:0o600});client.disconnect();update('storage_error');process.exit(1); }
});
client.on('event',frame=>{
  // Do not reconnect in a battle with a receiver deliberately started elsewhere.
  if(frame.body?.event?.eventtype==='disconnected_event'){
    fs.writeFileSync(path.join(data,'paused'),'Another receiver subscribed. Inspect before removing this marker.\n',{mode:0o600});
    client.disconnect();update('paused_duplicate_connection');process.exit(0);
  }
});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{client.disconnect();update('stopped');process.exit(0);});
update('starting');client.connect();
setInterval(()=>{void flushAcknowledgements();},2000);
setInterval(()=>{status.connected=client.isConnected;status.updated_at=new Date().toISOString();atomicJson(path.join(data,'status.json'),status);},30000);
