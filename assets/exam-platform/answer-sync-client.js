(function(root){
  'use strict';
  const config=root.AnswerCollectionConfig||{};
  const state={context:null,timer:null,pendingAttempt:null,lastError:null,consent:null};
  const params=new URLSearchParams(location.search);
  const isManagementHost=(config.allowedManagementHosts||[]).includes(location.hostname);
  const isPublicStagingHost=(config.allowedPublicStagingHosts||[]).includes(location.hostname);
  const managementRequested=params.get('answerSync')===config.managementQueryValue;
  const publicStagingRequested=params.get('answerSync')===config.publicStagingQueryValue;
  const channel=managementRequested?'management':publicStagingRequested?'public-staging':null;
  const modeAllowed=channel==='management'?isManagementHost:channel==='public-staging'?isPublicStagingHost:false;
  const enabled=Boolean(!config.publicCollectionEnabled&&modeAllowed&&channel);
  const storageKey=name=>channel==='public-staging'?config[`publicStaging${name}`]:config[name.charAt(0).toLowerCase()+name.slice(1)];
  const endpoint=()=>String(sessionStorage.getItem(storageKey('EndpointSessionKey'))||'').replace(/\/$/,'');
  const apiKey=()=>sessionStorage.getItem(channel==='public-staging'?config.publicStagingIngestKeySessionKey:config.apiKeySessionKey)||'';
  const readConsent=()=>{try{const value=JSON.parse(sessionStorage.getItem(config.consentSessionKey)||'null');return value?.policyVersion===config.consentPolicyVersion&&value?.status==='accepted'?value:null;}catch{return null;}};
  const meaningful=value=>Array.isArray(value)?value.some(entry=>entry!==null&&entry!==''&&entry!==undefined):value!==null&&value!==''&&value!==undefined;
  const responseRegistry=(exam,answers)=>{
    const unitsByResponse={};
    (answers.scoringUnits||[]).forEach(unit=>(unit.responseKeys||[]).forEach(key=>{(unitsByResponse[key]||(unitsByResponse[key]=[])).push(unit.unitId);}));
    const registry={};
    (exam.sections||[]).forEach(section=>(section.questions||[]).forEach(question=>{
      const components=question.components||[{responseKey:question.responseKey}];
      components.forEach(component=>{const key=component.responseKey,definition=answers.responses?.[key]||{};if(key)registry[key]={responseId:key,questionId:question.questionId||key,sectionId:section.sectionId||section.number||null,slotIds:(definition.answerNumbers||[]).map(String),scoringUnitIds:unitsByResponse[key]||[]};});
    }));
    return registry;
  };
  const buildPayload=attempt=>{
    const context=state.context||{},registry=context.registry||{},saved=attempt.responses||{};
    const {responses:_localResponses,...attemptMetadata}=attempt;
    const responseIds=new Set([...Object.keys(registry),...Object.keys(saved)]);
    const rows=[...responseIds].map(responseId=>{const answer=Object.prototype.hasOwnProperty.call(saved,responseId)?saved[responseId]:null;return {...(registry[responseId]||{responseId,questionId:responseId,sectionId:null,slotIds:[],scoringUnitIds:[]}),answer,isAnswered:meaningful(answer),answeredAt:null};});
    const payload={schemaVersion:'1.0.0',requestId:`${attempt.attemptId}:${attempt.sync?.revision||0}`,sentAt:new Date().toISOString(),source:{channel,isTestData:true,origin:location.origin,clientBuild:'answer-sync-v1.1'},attempt:{...attemptMetadata,responseIdentityRegistryVersion:context.responseIdentityRegistryVersion||null,scoringModelVersion:context.scoringModelVersion||null,namespace:context.namespace||'current'},responses:rows};
    if(channel==='public-staging')payload.consent=state.consent||readConsent();
    return payload;
  };
  const queueKey=attempt=>`answer-collection:outbox:${attempt.attemptId}`;
  const saveQueue=payload=>localStorage.setItem(queueKey(payload.attempt),JSON.stringify(payload));
  const removeQueue=payload=>{const key=queueKey(payload.attempt);try{const current=JSON.parse(localStorage.getItem(key)||'null');if(current?.requestId===payload.requestId)localStorage.removeItem(key);}catch{localStorage.removeItem(key);}};
  async function transmit(payload){
    if(!enabled)return {state:'disabled'};
    if(!endpoint()||!apiKey())return {state:'unconfigured'};
    if(channel==='public-staging'&&!state.consent)return {state:'consent-required'};
    const path=channel==='public-staging'?'/v1/public/attempts/sync':'/v1/attempts/sync';
    const keyHeader=channel==='public-staging'?'x-staging-key':'x-management-key';
    const response=await fetch(`${endpoint()}${path}`,{method:'POST',headers:{'content-type':'application/json',[keyHeader]:apiKey()},body:JSON.stringify(payload)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(body.error||`回答保存API: ${response.status}`);
    removeQueue(payload);state.lastError=null;root.dispatchEvent(new CustomEvent('answer-sync:status',{detail:{state:'synced',receipt:body}}));return body;
  }
  async function flush(payload){try{return await transmit(payload);}catch(error){state.lastError=error;root.dispatchEvent(new CustomEvent('answer-sync:status',{detail:{state:'error',message:error.message}}));return {state:'error',error};}}
  function schedule(attempt,immediate=false){if(!enabled||!state.context||(channel==='public-staging'&&!state.consent))return;const payload=buildPayload(attempt);saveQueue(payload);state.pendingAttempt=attempt;clearTimeout(state.timer);state.timer=setTimeout(()=>flush(payload),immediate?0:700);}
  function showConsent(){
    if(channel!=='public-staging'||state.consent||document.getElementById('answerSyncConsent'))return;
    const overlay=document.createElement('div');overlay.id='answerSyncConsent';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.innerHTML='<div class="answer-sync-consent"><p class="answer-sync-consent-eyebrow">非公開・試験運用</p><h2>回答データ保存の確認</h2><p>この管理用テストでは、回答内容、正誤、得点、試験・設問ID、回答時刻を、検証専用のCloudflare D1へ保存します。氏名やメールアドレスは収集しません。</p><ul><li>保存目的：回答保存機能と集計方法の品質確認</li><li>保存区分：本番統計に含めない試験データ</li><li>同意しなくても問題は利用できます</li></ul><div class="answer-sync-consent-actions"><button type="button" data-consent="declined">保存せず続ける</button><button type="button" data-consent="accepted" class="primary">同意して続行</button></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click',event=>{const action=event.target.closest('[data-consent]')?.dataset.consent;if(!action)return;if(action==='accepted'){state.consent={status:'accepted',policyVersion:config.consentPolicyVersion,acceptedAt:new Date().toISOString(),purposes:['answer-storage','quality-assurance']};sessionStorage.setItem(config.consentSessionKey,JSON.stringify(state.consent));root.dispatchEvent(new CustomEvent('answer-sync:consent',{detail:{status:'accepted'}}));}else{sessionStorage.removeItem(config.consentSessionKey);root.dispatchEvent(new CustomEvent('answer-sync:consent',{detail:{status:'declined'}}));}overlay.remove();});
  }
  function configure({manifest,exam,answers,namespace}){state.consent=readConsent();state.context={registry:responseRegistry(exam,answers),responseIdentityRegistryVersion:manifest.responseIdentityRegistryVersion||manifest.contentVersion||null,scoringModelVersion:answers.schemaVersion||manifest.scoring?.model||null,namespace};if(enabled&&channel==='public-staging'&&!state.consent)showConsent();if(enabled&&(channel!=='public-staging'||state.consent)){Object.keys(localStorage).filter(key=>key.startsWith('answer-collection:outbox:')).forEach(key=>{try{const queued=JSON.parse(localStorage.getItem(key));if(queued?.source?.channel===channel)flush(queued);}catch{}});}return status();}
  function status(){return {enabled,channel,publicCollectionEnabled:Boolean(config.publicCollectionEnabled),managementHost:isManagementHost,publicStagingHost:isPublicStagingHost,consentAccepted:Boolean(state.consent),configured:Boolean(endpoint()&&apiKey()),endpoint:endpoint(),lastError:state.lastError?.message||null};}
  root.addEventListener('exam-attempt:changed',event=>schedule(event.detail?.attempt,event.detail?.changeType==='result'));
  root.ExamAnswerSync={configure,status,flushPending:()=>state.pendingAttempt?flush(buildPayload(state.pendingAttempt)):Promise.resolve({state:'empty'}),buildPayload};
})(window);
