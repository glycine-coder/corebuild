(function(root){
  'use strict';
  const config=root.AnswerCollectionConfig||{};
  const state={context:null,timer:null,pendingAttempt:null,lastError:null,consent:null};
  const params=new URLSearchParams(location.search);
  const isPublicHost=(config.allowedPublicHosts||[]).includes(location.hostname);
  const isManagementHost=(config.allowedManagementHosts||[]).includes(location.hostname);
  const isPublicStagingHost=(config.allowedPublicStagingHosts||[]).includes(location.hostname);
  const managementRequested=params.get('answerSync')===config.managementQueryValue;
  const publicStagingRequested=params.get('answerSync')===config.publicStagingQueryValue;
  const channel=config.publicCollectionEnabled&&isPublicHost?'public':managementRequested?'management':publicStagingRequested?'public-staging':null;
  const modeAllowed=channel==='public'?isPublicHost:channel==='management'?isManagementHost:channel==='public-staging'?isPublicStagingHost:false;
  const enabled=Boolean(channel==='public'?config.publicCollectionEnabled&&modeAllowed:!config.publicCollectionEnabled&&modeAllowed&&channel);
  const storageKey=name=>channel==='public-staging'?config[`publicStaging${name}`]:config[name.charAt(0).toLowerCase()+name.slice(1)];
  const endpoint=()=>String(channel==='public'?config.publicEndpointDefault:sessionStorage.getItem(storageKey('EndpointSessionKey'))||'').replace(/\/$/,'');
  const apiKey=()=>sessionStorage.getItem(channel==='public-staging'?config.publicStagingIngestKeySessionKey:config.apiKeySessionKey)||'';
  const consentStorage=()=>channel==='public'?localStorage:sessionStorage;
  const consentKey=()=>channel==='public'?config.publicConsentStorageKey:config.consentSessionKey;
  const consentPolicyVersion=()=>channel==='public'?config.publicConsentPolicyVersion:config.consentPolicyVersion;
  const readConsent=()=>{try{const value=JSON.parse(consentStorage().getItem(consentKey())||'null');return value?.policyVersion===consentPolicyVersion()&&['accepted','declined'].includes(value?.status)?value:null;}catch{return null;}};
  const consentAccepted=()=>state.consent?.status==='accepted';
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
    const payload={schemaVersion:'1.0.0',requestId:`${attempt.attemptId}:${attempt.sync?.revision||0}`,sentAt:new Date().toISOString(),source:{channel,isTestData:channel!=='public',origin:location.origin,clientBuild:'answer-sync-v2.0'},attempt:{...attemptMetadata,createdAt:attemptMetadata.createdAt||attemptMetadata.updatedAt,responseIdentityRegistryVersion:context.responseIdentityRegistryVersion||null,scoringModelVersion:context.scoringModelVersion||null,namespace:context.namespace||'current'},responses:rows};
    if(channel==='public'||channel==='public-staging')payload.consent=state.consent||readConsent();
    return payload;
  };
  const queueKey=attempt=>`answer-collection:outbox:${attempt.attemptId}`;
  const saveQueue=payload=>localStorage.setItem(queueKey(payload.attempt),JSON.stringify(payload));
  const removeQueue=payload=>{const key=queueKey(payload.attempt);try{const current=JSON.parse(localStorage.getItem(key)||'null');if(current?.requestId===payload.requestId)localStorage.removeItem(key);}catch{localStorage.removeItem(key);}};
  async function transmit(payload){
    if(!enabled)return {state:'disabled'};
    if(!endpoint()||(channel!=='public'&&!apiKey()))return {state:'unconfigured'};
    if((channel==='public'||channel==='public-staging')&&!consentAccepted())return {state:'consent-required'};
    const path=channel==='public'||channel==='public-staging'?'/v1/public/attempts/sync':'/v1/attempts/sync';
    const headers={'content-type':'application/json'};
    if(channel==='public-staging')headers['x-staging-key']=apiKey();
    if(channel==='management')headers['x-management-key']=apiKey();
    const response=await fetch(`${endpoint()}${path}`,{method:'POST',headers,body:JSON.stringify(payload)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(body.error||`回答保存API: ${response.status}`);
    removeQueue(payload);state.lastError=null;root.dispatchEvent(new CustomEvent('answer-sync:status',{detail:{state:'synced',receipt:body}}));return body;
  }
  async function flush(payload){try{return await transmit(payload);}catch(error){state.lastError=error;root.dispatchEvent(new CustomEvent('answer-sync:status',{detail:{state:'error',message:error.message}}));return {state:'error',error};}}
  function schedule(attempt,immediate=false){if(!enabled||!state.context||((channel==='public'||channel==='public-staging')&&!consentAccepted()))return;const payload=buildPayload(attempt);saveQueue(payload);state.pendingAttempt=attempt;clearTimeout(state.timer);state.timer=setTimeout(()=>flush(payload),immediate?0:700);}
  function showConsent(){
    if((channel!=='public'&&channel!=='public-staging')||state.consent||document.getElementById('answerSyncConsent'))return;
    const overlay=document.createElement('div');overlay.id='answerSyncConsent';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.innerHTML=channel==='public'?'<div class="answer-sync-consent"><h2>回答データの保存</h2><p>問題の改善と学習機能の向上に役立てるため、回答内容の保存にご協力ください。</p><p>氏名やメールアドレスなど、個人を直接特定する情報は収集しません。</p><ul><li>同意しなくても、すべての問題を利用できます</li><li>詳しくは<a href="privacy.html" target="_blank" rel="noopener">回答データの取扱方針</a>をご確認ください</li></ul><div class="answer-sync-consent-actions"><button type="button" data-consent="declined">同意しない</button><button type="button" data-consent="accepted" class="primary">同意する</button></div></div>':'<div class="answer-sync-consent"><p class="answer-sync-consent-eyebrow">非公開・試験運用</p><h2>回答データ保存の確認</h2><p>この管理用テストでは、回答内容、正誤、得点、試験・設問ID、回答時刻を、検証専用のCloudflare D1へ保存します。氏名やメールアドレスは収集しません。</p><ul><li>保存目的：回答保存機能と集計方法の品質確認</li><li>保存区分：本番統計に含めない試験データ</li><li>同意しなくても問題は利用できます</li></ul><div class="answer-sync-consent-actions"><button type="button" data-consent="declined">同意しない</button><button type="button" data-consent="accepted" class="primary">同意する</button></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click',event=>{const action=event.target.closest('[data-consent]')?.dataset.consent;if(!action)return;if(action==='accepted'){state.consent={status:'accepted',policyVersion:consentPolicyVersion(),acceptedAt:new Date().toISOString(),purposes:['answer-storage','quality-assurance']};}else{state.consent={status:'declined',policyVersion:consentPolicyVersion(),declinedAt:new Date().toISOString(),purposes:[]};}consentStorage().setItem(consentKey(),JSON.stringify(state.consent));root.dispatchEvent(new CustomEvent('answer-sync:consent',{detail:{status:state.consent.status}}));overlay.remove();});
  }
  function configure({manifest,exam,answers,namespace}){state.consent=readConsent();state.context={registry:responseRegistry(exam,answers),responseIdentityRegistryVersion:manifest.responseIdentityRegistryVersion||manifest.contentVersion||null,scoringModelVersion:answers.schemaVersion||manifest.scoring?.model||null,namespace};if(enabled&&(channel==='public'||channel==='public-staging')&&!state.consent)showConsent();if(enabled&&((channel!=='public'&&channel!=='public-staging')||consentAccepted())){Object.keys(localStorage).filter(key=>key.startsWith('answer-collection:outbox:')).forEach(key=>{try{const queued=JSON.parse(localStorage.getItem(key));if(queued?.source?.channel===channel)flush(queued);}catch{}});}return status();}
  function status(){return {enabled,channel,publicCollectionEnabled:Boolean(config.publicCollectionEnabled),publicHost:isPublicHost,managementHost:isManagementHost,publicStagingHost:isPublicStagingHost,consentAccepted:consentAccepted(),consentStatus:state.consent?.status||null,configured:Boolean(endpoint()&&(channel==='public'||apiKey())),endpoint:endpoint(),lastError:state.lastError?.message||null};}
  root.addEventListener('exam-attempt:changed',event=>schedule(event.detail?.attempt,event.detail?.changeType==='result'));
  root.ExamAnswerSync={configure,status,flushPending:()=>state.pendingAttempt?flush(buildPayload(state.pendingAttempt)):Promise.resolve({state:'empty'}),buildPayload};
})(window);
