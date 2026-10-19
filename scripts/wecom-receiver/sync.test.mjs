import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const source=fs.readFileSync(new URL('./sync.sh',import.meta.url),'utf8');
const scratch=process.env.TMPDIR || process.env.RUNNER_TEMP || fileURLToPath(new URL('./node_modules/.cache/',import.meta.url));
const stub=`
import fs from 'node:fs';
import path from 'node:path';
const data=process.env.WECOM_RECEIVER_DATA,mode=process.env.SYNC_TEST_MODE;
fs.appendFileSync(path.join(data,'starts.jsonl'),JSON.stringify({pid:process.pid,mode,cwd:process.cwd(),data,config:process.env.SYNC_TEST_CONFIG})+'\\n');
if(mode==='ignore-term'){
  process.on('SIGTERM',()=>fs.writeFileSync(path.join(data,'term-observed'),'yes'));
  setInterval(()=>{},1000);
}
if(mode==='hold'){
  const interval=setInterval(()=>{if(fs.existsSync(path.join(data,'release'))) clearInterval(interval);},20);
}
if(mode==='error') process.exit(23);
if(mode.startsWith('upload')){
  const {syncReceiverMessages}=await import('./uploader.mjs');
  const ledger=path.join(data,'committed.json');
  const known=new Set(fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger,'utf8')) : []);
  const stall=init=>{
    init.signal.addEventListener('abort',()=>fs.writeFileSync(path.join(data,'abort-observed'),'yes'));
    fs.writeFileSync(path.join(data,'request-stalled'),'yes');
    setInterval(()=>{},1000);
    return new Promise(()=>{});
  };
  const summary=await syncReceiverMessages({dataDirectory:data,endpoint:'https://synthetic.invalid/bot-inbox',token:'synthetic',startedAt:'2026-09-08T00:00:00.000Z',fetchImpl:async(_url,init)=>{
    const records=JSON.parse(init.body).records;
    fs.appendFileSync(path.join(data,'batches.jsonl'),JSON.stringify({size:records.length})+'\\n');
    if(records.length===1 && mode==='upload-stall-before') return stall(init);
    const inserted=records.filter(record=>!known.has(record.messageId)).length;
    records.forEach(record=>known.add(record.messageId));
    fs.writeFileSync(ledger,JSON.stringify([...known]));
    if(records.length===1 && mode==='upload-stall-after') return stall(init);
    return {ok:true,status:200,json:async()=>({outcome:'committed',inserted,duplicates:records.length-inserted})};
  }});
  fs.writeSync(1,JSON.stringify(summary)+'\\n');
}else{
  fs.writeSync(1,JSON.stringify({scanned:74,skipped:74,healthReported:1,failed:0})+'\\n');
}
if(mode==='spin') while(true) {}
`;

function replaceOnce(text,before,after){
  assert.equal(text.split(before).length,2,`fixture binding: ${before}`);
  return text.replace(before,after);
}

function quote(value){return `'${value.replaceAll("'","'\\''")}'`;}

function kill(pid){
  try{process.kill(pid,'SIGKILL');}
  catch(error){if(error.code!=='ESRCH') throw error;}
}

function starts(data){
  const file=path.join(data,'starts.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse) : [];
}

function fixture(t){
  fs.mkdirSync(scratch,{recursive:true,mode:0o700});
  const root=fs.mkdtempSync(path.join(scratch,'wecom-sync-shell-'));
  const app=path.join(root,'app'),data=path.join(root,'data'),config=path.join(app,'test.env');
  fs.mkdirSync(app,{mode:0o700});fs.mkdirSync(data,{mode:0o700});
  let shell=replaceOnce(source,'APP=/home/codex/.local/wecom-receiver',`APP=${quote(app)}`);
  shell=replaceOnce(shell,'DATA=/home/codex/.local/share/wecom-receiver',`DATA=${quote(data)}`);
  if(process.platform!=='linux'){
    shell=replaceOnce(shell,'/usr/bin/flock',quote(process.env.WECOM_SYNC_TEST_FLOCK));
    shell=replaceOnce(shell,'/usr/bin/node',quote(process.execPath));
    shell=shell.replace('/usr/bin/timeout',quote(process.env.WECOM_SYNC_TEST_TIMEOUT));
  }
  const launcher=path.join(root,'sync.sh');
  fs.writeFileSync(launcher,shell,{mode:0o700});
  fs.writeFileSync(path.join(app,'sync.mjs'),stub,{mode:0o600});
  const runners=[];
  t.after(()=>{
    const active=runners.filter(run=>!run.state.exited);
    const modes=new Set(active.map(run=>run.mode));
    starts(data).filter(entry=>modes.has(entry.mode)).forEach(entry=>kill(entry.pid));
    active.forEach(run=>kill(-run.child.pid));
    fs.rmSync(root,{recursive:true});
  });
  t.diagnostic(JSON.stringify({sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),platform:process.platform,node:process.version,bindings:{app,data}}));
  return {app,data,config,runners,launcher};
}

function launch(f,mode){
  const state={exited:false,code:null,signal:null,stdout:'',stderr:''};
  const started=performance.now();
  const child=spawn('/bin/sh',[f.launcher],{detached:true,env:{PATH:'/usr/bin:/bin',HOME:path.dirname(f.app),TMPDIR:path.dirname(f.app),WECOM_RECEIVER_CONFIG_FILE:f.config,SYNC_TEST_MODE:mode},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>{state.stdout+=data;});
  child.stderr.on('data',data=>{state.stderr+=data;});
  const done=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>{Object.assign(state,{exited:true,code,signal});resolve();});
  });
  const run={child,state,started,done,mode};
  f.runners.push(run);
  return run;
}

async function observe(t,run,limit=55_000){
  let timer;
  await Promise.race([run.done,new Promise(resolve=>{timer=setTimeout(resolve,limit);})]);
  clearTimeout(timer);
  const receipt={mode:run.mode,...run.state,elapsedMs:Math.round(performance.now()-run.started)};
  t.diagnostic(JSON.stringify(receipt));
  return receipt;
}

async function ready(run){
  const until=performance.now()+5000;
  while(!run.state.stdout.includes('"failed":0') && performance.now()<until){
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.match(run.state.stdout,/"failed":0/,'synthetic child must print its completed summary');
}

test('completed summary followed by CPU spin exits within the process deadline and releases flock',{timeout:65_000},async t=>{
  const f=fixture(t),run=launch(f,'spin');
  await ready(run);
  const result=await observe(t,run);
  if(!result.exited){
    const blocked=await observe(t,launch(f,'success'),2000);
    assert.equal(blocked.code,1);
    assert.equal(starts(f.data).length,1,'old launcher still holds flock after the completed summary');
  }
  assert.equal(result.exited,true,'completed summary must not leave a busy worker holding flock beyond 55 seconds');
  assert.equal(result.code,124);
  assert.ok(result.elapsedMs>=44_000 && result.elapsedMs<55_000);
  assert.throws(()=>process.kill(starts(f.data)[0].pid,0),{code:'ESRCH'});
  const next=await observe(t,launch(f,'success'),5000);
  assert.equal(next.code,0);
  assert.equal(starts(f.data).length,2,'the next sync must actually start');
});

test('a child that ignores TERM is killed within the grace period and releases flock',{timeout:65_000},async t=>{
  const f=fixture(t),run=launch(f,'ignore-term');
  await ready(run);
  const result=await observe(t,run);
  assert.equal(fs.readFileSync(path.join(f.data,'term-observed'),'utf8'),'yes');
  assert.equal(result.exited,true,'TERM alone must not leave the lock held by an uncooperative child');
  assert.equal(result.code,137);
  assert.ok(result.elapsedMs>=49_000 && result.elapsedMs<55_000);
  assert.throws(()=>process.kill(starts(f.data)[0].pid,0),{code:'ESRCH'});
  assert.equal((await observe(t,launch(f,'success'),5000)).code,0);
  assert.equal(starts(f.data).length,2);
});

test('normal success preserves configuration, cwd, data directory and private file modes',async t=>{
  const f=fixture(t);
  fs.writeFileSync(f.config,'SYNC_TEST_CONFIG=synthetic-config\n',{mode:0o600});
  assert.equal((await observe(t,launch(f,'success'),5000)).code,0);
  const [entry]=starts(f.data);
  assert.equal(entry.config,'synthetic-config');
  assert.equal(entry.cwd,f.app);assert.equal(entry.data,f.data);
  assert.equal(fs.statSync(path.join(f.data,'starts.jsonl')).mode&0o777,0o600);
});

test('normal errors preserve the child exit code and release flock',async t=>{
  const f=fixture(t);
  assert.equal((await observe(t,launch(f,'error'),5000)).code,23);
  assert.equal((await observe(t,launch(f,'success'),5000)).code,0);
  assert.equal(starts(f.data).length,2);
});

test('a concurrent lock skip does not start a second child',async t=>{
  const f=fixture(t),holder=launch(f,'hold');
  await ready(holder);
  assert.equal((await observe(t,launch(f,'success'),5000)).code,1);
  assert.equal(starts(f.data).length,1);
  fs.writeFileSync(path.join(f.data,'release'),'yes');
  assert.equal((await observe(t,holder,5000)).code,0);
  assert.equal((await observe(t,launch(f,'success'),5000)).code,0);
  assert.equal(starts(f.data).length,2);
});

test('a paused uploader exits before loading configuration or starting a child',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.data,'paused'),'synthetic pause');
  fs.writeFileSync(f.config,'exit 23\n');
  assert.equal((await observe(t,launch(f,'success'),5000)).code,0);
  assert.equal(starts(f.data).length,0);
});

function sourceDigests(directory){
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex')]));
}

function uploadFixture(f){
  fs.copyFileSync(new URL('./sync.mjs',import.meta.url),path.join(f.app,'uploader.mjs'));
  fs.copyFileSync(new URL('./core.mjs',import.meta.url),path.join(f.app,'core.mjs'));
  const messages=path.join(f.data,'messages');fs.mkdirSync(messages);
  for(let n=0;n<51;n++){
    fs.writeFileSync(path.join(messages,`${String(n).padStart(3,'0')}.json`),JSON.stringify({received_at:'2026-09-09T00:01:00.000Z',message:{aibotid:'synthetic-bot',msgid:`synthetic-${n}`,msgtype:'text',chatid:'synthetic-chat',from:{userid:'synthetic-user'},text:{content:'synthetic'}}}));
  }
  return messages;
}

for(const phase of ['before','after']){
  test(`a deadline ${phase} server commit retains batch state, withholds unknown acknowledgements and permits idempotent retry`,{timeout:65_000},async t=>{
    const f=fixture(t),messages=uploadFixture(f),original=sourceDigests(messages);
    assert.equal((await observe(t,launch(f,`upload-stall-${phase}`))).code,124);
    assert.equal(fs.readFileSync(path.join(f.data,'abort-observed'),'utf8'),'yes');
    assert.equal(fs.readFileSync(path.join(f.data,'request-stalled'),'utf8'),'yes');
    const state=JSON.parse(fs.readFileSync(path.join(f.data,'sync-state.json'),'utf8')).entries;
    assert.equal(Object.keys(state).length,50);
    assert.ok(Object.values(state).every(entry=>entry.status==='committed'));
    assert.equal(fs.readdirSync(path.join(f.data,'acknowledgements')).length,50);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.data,'committed.json'),'utf8')).length,phase==='before' ? 50 : 51);
    assert.deepEqual(sourceDigests(messages),original);
    const retried=await observe(t,launch(f,'upload-retry'),5000);
    assert.equal(retried.code,0);
    const summary=JSON.parse(retried.stdout);
    assert.equal(summary.inserted,phase==='before' ? 1 : 0);
    assert.equal(summary.duplicates,phase==='after' ? 1 : 0);
    assert.equal(summary.skipped,50);assert.equal(summary.acknowledged,1);assert.equal(summary.failed,0);
    assert.equal(fs.readdirSync(path.join(f.data,'acknowledgements')).length,51);
    const repeated=await observe(t,launch(f,'upload-retry'),5000);
    assert.equal(repeated.code,0);assert.equal(JSON.parse(repeated.stdout).skipped,51);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.data,'committed.json'),'utf8')).length,51);
    assert.deepEqual(fs.readFileSync(path.join(f.data,'batches.jsonl'),'utf8').trim().split('\n').map(JSON.parse).map(batch=>batch.size),[50,1,1]);
    assert.deepEqual(sourceDigests(messages),original);
  });
}
