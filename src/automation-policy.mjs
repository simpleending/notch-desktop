export const newAutomationPolicy = Object.freeze({maxRuntimeMs:20*60000,maxTokens:32768,notifications:'changes',missedRuns:'latest',retryResources:true});

export function automationPolicy(input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Choose valid automation options.');
  const result={permissionMode:input.permissionMode??'auto',maxRuntimeMs:input.maxRuntimeMs??0,maxTokens:input.maxTokens??0,notifications:input.notifications??'errors',missedRuns:input.missedRuns??'latest',retryResources:input.retryResources??true};
  if(!['auto','bypassPermissions','default','read-only'].includes(result.permissionMode))throw Error('Choose a supported automation access mode.');
  for(const [key,max,label]of [['maxRuntimeMs',86400000,'runtime'],['maxTokens',10000000,'token']])if(!Number.isSafeInteger(result[key])||result[key]<0||result[key]>max)throw Error(`Choose a valid automation ${label} limit.`);
  if(!['changes','errors','all','off'].includes(result.notifications)||!['latest','skip'].includes(result.missedRuns)||typeof result.retryResources!=='boolean')throw Error('Choose valid automation notification and recovery options.');
  return result;
}

export function automationReplay(schedule,first,now,next) {
  if(schedule.kind==='at')return{replayScheduledFor:first,missedCount:0,firstMissedScheduledFor:null,nextRunAt:null};
  if(schedule.kind==='every'){
    const count=Math.floor(Math.max(now-first,0)/schedule.everyMs)+1,last=first+(count-1)*schedule.everyMs,following=last+schedule.everyMs;
    return{replayScheduledFor:last,missedCount:count-1,firstMissedScheduledFor:count>1?first:null,nextRunAt:following<=8640000000000000?following:null};
  }
  let count=1,last=first,following=next(last);
  while(following!==null&&following<=now&&count<10000){last=following;count++;following=next(last);}
  let countAtLeast=false;
  if(following!==null&&following<=now){
    // Bound cron counting without substituting an old occurrence for the latest one.
    let low=last,high=now;
    while(low<high){const middle=Math.floor((low+high+1)/2),value=next(middle-1);if(value!==null&&value<=now)low=Math.max(middle,value);else high=middle-1;}
    last=low;countAtLeast=true;
  }
  return{replayScheduledFor:last,missedCount:countAtLeast?count:count-1,firstMissedScheduledFor:count>1?first:null,nextRunAt:next(now),countAtLeast};
}

export function automationResourceError(error) {
  return /(?:available|free|insufficient|enough|current|usable).{0,55}(?:memory|ram)|(?:memory|ram).{0,55}(?:available|fell|pressure|fit|reserve)|local model.{0,55}(?:loading|ejecting|starting)|(?:ollama|strata|colibri|local runtime).{0,40}(?:unavailable|not ready|starting)|ECONNREFUSED/i.test(String(error?.message??error));
}

export function automationNoChange(summary) {
  return /^\s*\[NO_CHANGE\](?:\s|$)/.test(summary??'');
}
