export const INITIAL_REPLY = '正在收录，请稍候…';
export const FINAL_REPLY = '已收录到系统审核队列。';
export const ACTIVE_INITIAL_REPLY = Object.freeze({msgtype:'markdown',markdown:{content:INITIAL_REPLY}});
export const ACTIVE_FINAL_REPLY = Object.freeze({msgtype:'markdown',markdown:{content:FINAL_REPLY}});

function increment(status,key){status[key]=(status[key] || 0)+1;}

/** Persist only a bounded provider category, never the provider message or frame. */
export function providerErrorCode(error){
  const value=error?.errcode ?? error?.code ?? error?.cause?.errcode ?? error?.cause?.code ?? 'reply_failed';
  return String(value).replace(/[^A-Za-z0-9_-]/g,'').slice(0,80) || 'reply_failed';
}

/**
 * A callback reply is preferred because its final acknowledgement can replace
 * the placeholder. Some WeCom tenants reject that path even while controlled
 * active messages remain healthy, so immediately fall back to the originating
 * chat/user instead of leaving the sender without a receipt.
 */
export async function sendInitialAcknowledgement({client,pending,status,now=Date.now}){
  try {
    await client.replyStream(pending.frame,pending.streamId,INITIAL_REPLY,false);
    pending.initialReplyMode='stream';
    pending.initialSentAt=now();
    increment(status,'initial_replies_this_run');
    increment(status,'initial_stream_replies_this_run');
    status.last_initial_reply_at=new Date(pending.initialSentAt).toISOString();
    return 'stream';
  } catch(error) {
    increment(status,'initial_stream_failures_this_run');
    status.last_initial_stream_error=providerErrorCode(error);
    status.last_initial_stream_error_at=new Date(now()).toISOString();
  }

  if(pending.target){
    try {
      await client.sendMessage(pending.target,ACTIVE_INITIAL_REPLY);
      pending.initialReplyMode='active';
      pending.initialSentAt=now();
      increment(status,'initial_replies_this_run');
      increment(status,'initial_reply_fallbacks_this_run');
      status.last_initial_reply_at=new Date(pending.initialSentAt).toISOString();
      return 'active';
    } catch(error) {
      pending.initialReplyError=providerErrorCode(error);
    }
  } else pending.initialReplyError='missing_reply_target';

  increment(status,'initial_reply_failures_this_run');
  status.last_initial_reply_error=pending.initialReplyError;
  status.last_initial_reply_error_at=new Date(now()).toISOString();
  return 'failed';
}
