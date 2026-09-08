import fs from 'node:fs';
import path from 'node:path';
import AiBot from '@wecom/aibot-node-sdk';
import {readBot,atomicJson,saveMessage,disableSending} from './core.mjs';
process.umask(0o077);
const data=process.env.WECOM_RECEIVER_DATA || '/home/codex/.local/share/wecom-receiver';
fs.mkdirSync(data,{recursive:true,mode:0o700});
const status={state:'starting',started_at:new Date().toISOString(),received_this_run:0};
function update(state){status.state=state;status.updated_at=new Date().toISOString();atomicJson(path.join(data,'status.json'),status);}
const bot=readBot(process.env.WECOM_CLI_CONFIG_DIR || '/home/codex/.config/wecom');
const client=new AiBot.WSClient({botId:bot.id,secret:bot.secret,maxReconnectAttempts:-1,maxAuthFailureAttempts:2,logger:{debug(){},info(){},warn(){},error(){}}});
disableSending(client);
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
  try {if(saveMessage(path.join(data,'messages'),frame.body)){status.received_this_run++;status.last_message_at=new Date().toISOString();}update('authenticated');}
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
setInterval(()=>{status.connected=client.isConnected;status.updated_at=new Date().toISOString();atomicJson(path.join(data,'status.json'),status);},30000);
