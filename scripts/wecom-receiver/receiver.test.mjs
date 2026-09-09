import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readBot,saveMessage,disableSending,restrictSending,botMessageId,acknowledgementFilePath,replyTarget} from './core.mjs';
test('encrypted CLI credentials are read without changing their files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wecom-test-'));
 try{const key=crypto.randomBytes(32),nonce=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,nonce);
 const input={bot:{id:'test',secret:'synthetic'}};const data=Buffer.concat([nonce,c.update(JSON.stringify(input)),c.final(),c.getAuthTag()]);
 fs.writeFileSync(path.join(dir,'.encryption_key'),key.toString('base64'));fs.writeFileSync(path.join(dir,'credentials.enc'),data);
 assert.deepEqual(readBot(dir),input.bot);assert.deepEqual(fs.readFileSync(path.join(dir,'credentials.enc')),data);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('persist once across restarts; hostile msgids cannot escape directory; no reply capability persisted',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wecom-test-'));
 try{const b={msgid:'../../escape',aibotid:'test',text:{content:'synthetic'},response_url:'secret-send-url'};
 assert.equal(saveMessage(dir,b),true);assert.equal(saveMessage(dir,b),false);
 const files=fs.readdirSync(dir);assert.equal(files.length,1);const p=path.join(dir,files[0]);
 const saved=JSON.parse(fs.readFileSync(p));assert.equal(saved.message.response_url,undefined);assert.equal(saved.message.text.content,'synthetic');assert.equal(fs.statSync(p).mode&0o777,0o600);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('sending methods fail closed except explicitly allowed acknowledgement methods',()=>{
 const c={};
 disableSending(c);
 assert.throws(()=>c.sendMessage('x',{}),/receive_only/);
 assert.throws(()=>c.reply({},{}),/receive_only/);
 assert.throws(()=>c.replyStream({},'stream','text'),/receive_only/);
 const allowed={replyStream(){},sendMessage(){}};
 restrictSending(allowed,{allow:['replyStream','sendMessage']});
 assert.doesNotThrow(()=>allowed.replyStream({},'stream','text'));
 assert.doesNotThrow(()=>allowed.sendMessage('chat',{}));
 assert.throws(()=>allowed.reply({},{}),/receive_only/);
});

test('acknowledgements use bounded message ids and only address the originating chat',()=>{
 const id=botMessageId({aibotid:'test-bot',msgid:'message-1'});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wecom-ack-'));
 try {
  assert.match(id,/^bot:[a-f0-9]{64}$/);
  assert.equal(path.basename(acknowledgementFilePath(dir,id)),`${id.slice(4)}.json`);
  assert.throws(()=>acknowledgementFilePath(dir,'bot:../escape'),/invalid_acknowledgement_id/);
  assert.equal(replyTarget({chattype:'group',chatid:'room-1',from:{userid:'sender-1'}}),'room-1');
  assert.equal(replyTarget({chattype:'single',from:{userid:'sender-1'}}),'sender-1');
  assert.equal(replyTarget({chattype:'group',from:{userid:'sender-1'}}),'');
 } finally { fs.rmSync(dir,{recursive:true}); }
});

test('storage limits preserve existing messages and reject oversized callbacks',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wecom-test-'));
 try{assert.equal(saveMessage(dir,{msgid:'first',aibotid:'test',text:{content:'keep'}}),true);
 assert.throws(()=>saveMessage(dir,{msgid:'next',aibotid:'test'},{maxBytes:1}),/storage_limit/);
 assert.throws(()=>saveMessage(dir,{msgid:'large',text:{content:'x'.repeat(1024*1024)}}),/payload_limit/);
 assert.equal(fs.readdirSync(dir).length,1);
 }finally{fs.rmSync(dir,{recursive:true});}
});
