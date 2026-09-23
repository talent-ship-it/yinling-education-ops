const INITIAL_REPLY = '正在收录，请稍候…';
const FINAL_REPLY = '已收录到系统审核队列。';
export const ACTIVE_INITIAL_REPLY = Object.freeze({msgtype:'markdown',markdown:{content:INITIAL_REPLY}});
export const ACTIVE_FINAL_REPLY = Object.freeze({msgtype:'markdown',markdown:{content:FINAL_REPLY}});
const STREAM_REPLY_TTL_MS=5*60*1000;

function increment(status,key){status[key]=(status[key] || 0)+1;}

function objectField(value,key){
  if(!value || typeof value!=='object' || Array.isArray(value)) return undefined;
  return value[key];
}

function defined(value){return value!==undefined && value!==null;}

function providerCodeValue(error){
  const cause=objectField(error,'cause');
  return [
    objectField(error,'errcode'),
    objectField(error,'code'),
    objectField(cause,'errcode'),
    objectField(cause,'code'),
  ].find(defined);
}

/** Persist only a bounded provider category, never the provider message or frame. */
export function providerErrorCode(error){
  const cleaned=String(providerCodeValue(error) ?? 'reply_failed').replace(/[^A-Za-z0-9_-]/g,'').slice(0,80);
  return cleaned || 'reply_failed';
}

function providerAckRejected(error){
  const cause=objectField(error,'cause');
  return [objectField(error,'errcode'),objectField(cause,'errcode')].some(defined);
}

function providerErrorMessage(error){
  const value=objectField(error,'message');
  return typeof value==='string' ? value : '';
}

/** Missing acknowledgements occur after the SDK has sent bytes. Redelivery is
 * safe only when the provider explicitly rejected the frame or the pinned SDK
 * proves it never reached the socket. */
export function providerDeliveryDisposition(error){
  if(providerAckRejected(error)) return 'rejected';
  const message=providerErrorMessage(error);
  if(message==='WebSocket not connected, unable to send data'
    || /^Reply queue for reqId .+ exceeds max size \([0-9]+\)$/u.test(message)) return 'definitely_unsent';
  return 'uncertain';
}

function recordUncertainInitial(pending,status,mode,now){
  pending.initialReplyMode=mode;
  pending.initialSentAt=now();
  pending.initialReplyError='reply_delivery_uncertain';
  increment(status,'initial_reply_uncertain_this_run');
  status.last_initial_reply_error='reply_delivery_uncertain';
  status.last_initial_reply_error_at=new Date(pending.initialSentAt).toISOString();
  return 'uncertain';
}

function recordInitialSuccess(pending,status,mode,now){
  pending.initialReplyMode=mode;
  pending.initialSentAt=now();
  increment(status,'initial_replies_this_run');
  increment(status,mode==='stream' ? 'initial_stream_replies_this_run' : 'initial_reply_fallbacks_this_run');
  status.last_initial_reply_at=new Date(pending.initialSentAt).toISOString();
  return mode;
}

function recordInitialFailure(pending,status,now){
  increment(status,'initial_reply_failures_this_run');
  status.last_initial_reply_error=pending.initialReplyError;
  status.last_initial_reply_error_at=new Date(now()).toISOString();
  return 'failed';
}

async function attemptInitialStream(client,pending,status,now){
  try {
    await client.replyStream(pending.frame,pending.streamId,INITIAL_REPLY,false);
    return recordInitialSuccess(pending,status,'stream',now);
  } catch(error) {
    increment(status,'initial_stream_failures_this_run');
    status.last_initial_stream_error=providerErrorCode(error);
    status.last_initial_stream_error_at=new Date(now()).toISOString();
    return providerDeliveryDisposition(error)==='uncertain'
      ? recordUncertainInitial(pending,status,'stream_uncertain',now)
      : 'fallback';
  }
}

async function attemptInitialActive(client,pending,status,now){
  if(!pending.target){
    pending.initialReplyError='missing_reply_target';
    return recordInitialFailure(pending,status,now);
  }
  try {
    await client.sendMessage(pending.target,ACTIVE_INITIAL_REPLY);
    return recordInitialSuccess(pending,status,'active',now);
  } catch(error) {
    if(providerDeliveryDisposition(error)==='uncertain'){
      return recordUncertainInitial(pending,status,'active_uncertain',now);
    }
    pending.initialReplyError=providerErrorCode(error);
    return recordInitialFailure(pending,status,now);
  }
}

/**
 * A callback reply is preferred because its final acknowledgement can replace
 * the placeholder. Some WeCom tenants reject that path even while controlled
 * active messages remain healthy, so immediately fall back to the originating
 * chat/user instead of leaving the sender without a receipt.
 */
export async function sendInitialAcknowledgement({client,pending,status,now=Date.now}){
  pending.initialReplyState='pending';
  try {
    const streamOutcome=await attemptInitialStream(client,pending,status,now);
    return streamOutcome==='fallback'
      ? attemptInitialActive(client,pending,status,now)
      : streamOutcome;
  } finally {
    pending.initialReplyState='settled';
  }
}

function initialReplyPending(pending){
  return Boolean(pending) && pending.initialReplyState!=='settled';
}

function liveStreamReply(pending,now){
  return pending?.initialReplyMode==='stream' && now-pending.receivedAt<STREAM_REPLY_TTL_MS;
}

function finalAcknowledgementPlan(pending,target,now){
  if(initialReplyPending(pending)) return 'deferred';
  if(liveStreamReply(pending,now)) return 'stream';
  return target ? 'active' : 'missing_target';
}

const FINAL_ACKNOWLEDGEMENT_DELIVERY=Object.freeze({
  deferred:async()=> 'deferred',
  missing_target:async()=> 'missing_target',
  stream:async({client,pending})=>{
    await client.replyStream(pending.frame,pending.streamId,FINAL_REPLY,true);
    return 'sent';
  },
  active:async({client,target})=>{
    await client.sendMessage(target,ACTIVE_FINAL_REPLY);
    return 'sent';
  },
});

/** The committed receipt must never overtake an unresolved initial receipt. */
export async function sendFinalAcknowledgement({client,pending,target,now=Date.now}){
  try {
    return await FINAL_ACKNOWLEDGEMENT_DELIVERY[finalAcknowledgementPlan(pending,target,now())]({
      client,pending,target,
    });
  } catch(error) {
    if(providerDeliveryDisposition(error)==='uncertain') return 'uncertain';
    throw error;
  }
}
