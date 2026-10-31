import {formatDirection,formatSeenAt} from './core.js';
export function addMessage(chat, role, text, {pending=false,error=false}={}) {
  const nearEnd=chat.scrollHeight-chat.scrollTop-chat.clientHeight<100;
  const article=document.createElement('article'); article.className=`message ${role}${pending?' pending':''}${error?' error':''}`;
  const heading=document.createElement('div');heading.className='message-heading';
  const avatar=document.createElement('span');avatar.className='message-avatar';avatar.textContent=role==='user'?'Y':'✦';
  const label=document.createElement('span');label.textContent=role==='user'?'You':'Assistant';heading.append(avatar,label);
  const body=document.createElement('div');body.className='message-body';body.textContent=text;
  article.append(heading,body);chat.append(article);
  if(nearEnd) chat.scrollTop=chat.scrollHeight;
  return {element:article,body,update(text,isError=false){article.classList.remove('pending');article.classList.toggle('error',isError);body.textContent=text;}};
}
export function renderAnswer(message,result,profile) {
  if(/\bstub\b/i.test(result.answer)) {
    message.update('The assistant is connected, but image recognition is still using the starter placeholder. Real object search and calibrated directions need the backend integration.');
    return;
  }
  const direction=formatDirection(result.direction,profile);
  if(direction) {
    message.update(direction);message.body.classList.add('direction-result');
    const meta=document.createElement('div');meta.className='message-meta';
    meta.textContent=`${result.direction.historical===false?'Current observation':'Last seen: '+formatSeenAt(result.direction.last_seen_ts)} · Relative to glasses facing · Straight-line distance, not a walking route`;
    message.element.append(meta);return;
  }
  const statuses={pose_required:'Look at the reference marker so I can restore your position and direction.',range_unknown:'I cannot establish the distance yet. Scan the object from another position with the reference in view.',ambiguous:'There is more than one possible match. Describe the colour or another distinguishing feature.',not_seen:'I have not seen that object yet. Start capturing and scan your workspace.',calibration_invalid:'Your location setup needs to be checked. Open calibration to continue.'};
  const fallback=statuses[result.direction?.status]||'Angle and distance are unavailable. Complete calibration and keep the reference in view while locating an object.';
  // Legacy model prose is not a substitute for validated geometry.
  if(result.direction || result.kind==='find' || result.kind==='retrace') message.update(fallback);
  else {message.update(result.answer||fallback);const note=document.createElement('div');note.className='message-meta';note.textContent='No validated angle or distance supplied.';message.element.append(note);}
}
