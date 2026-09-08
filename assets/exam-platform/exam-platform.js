(function(root){
  'use strict';

  const Scoring=root.ExamScoring||(typeof require==='function'?require('./scoring-engine.js'):null);
  if(!Scoring)throw new Error('共通採点エンジンを読み込めませんでした。');

  const clone=value=>typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));
  const get=(record,path)=>String(path).split('.').reduce((value,key)=>value==null?undefined:value[key],record);

  class ExamCatalog{
    constructor(catalog){this.catalog=clone(catalog);this.byId=new Map(this.catalog.exams.map(exam=>[exam.examId,exam]));}
    find(examId){const exam=this.byId.get(examId);return exam?clone(exam):null;}
    list(filters={}){
      return this.catalog.exams.filter(exam=>Object.entries(filters).every(([path,expected])=>{
        const actual=get(exam,path);return Array.isArray(expected)?expected.includes(actual):actual===expected;
      })).map(clone);
    }
    viewerFor(examId){
      const exam=this.byId.get(examId);if(!exam)return null;
      if(exam.viewer?.path)return clone(exam.viewer);
      const viewer=this.catalog.defaultViewer;
      return {path:`${viewer.path}?${viewer.examIdParameter}=${encodeURIComponent(examId)}`,adapterId:exam.viewer?.adapterId||'generic'};
    }
  }

  class RendererRegistry{
    constructor(fallbackId='core.text'){this.fallbackId=fallbackId;this.renderers=new Map();}
    register(rendererId,renderer){if(!rendererId||typeof renderer!=='object')throw new Error('renderer registration');this.renderers.set(rendererId,renderer);return this;}
    resolve(rendererId){return this.renderers.get(rendererId)||this.renderers.get(this.fallbackId)||null;}
    has(rendererId){return this.renderers.has(rendererId);}
  }

  class AssetRegistry{
    constructor(assetManifest={assets:[]}){this.examId=assetManifest.examId||null;this.assets=new Map((assetManifest.assets||[]).map(asset=>[asset.assetId,clone(asset)]));}
    get(assetId){const asset=this.assets.get(assetId);return asset?clone(asset):null;}
    listByRole(role){return [...this.assets.values()].filter(asset=>asset.role===role).map(clone);}
    audioCue(cue){
      const asset=this.assets.get(cue.assetId);
      if(!asset||asset.type!=='audio')throw new Error(`audio asset not found: ${cue.assetId}`);
      return {...clone(cue),asset:clone(asset)};
    }
  }

  class ExamPackageRegistry{
    constructor(){this.packages=new Map();}
    register(manifest){const report=validateManifest(manifest);if(report.errors.length)throw new Error(report.errors.join('; '));this.packages.set(manifest.examId,clone(manifest));return report;}
    get(examId){const manifest=this.packages.get(examId);return manifest?clone(manifest):null;}
  }

  const GenericScoringEngine=Scoring.CommonScoringEngine;

  class ExamAttemptStore{
    constructor(manifest,storage=root.localStorage,options={}){this.manifest=manifest;this.storage=storage;this.mode=options.mode||'practice';this.namespace=options.namespace||'current';this.key=`exam-attempt:${manifest.examId}:${this.namespace}`;this.legacyKeys=this.namespace==='current'?(manifest.persistence?.legacyStorageKeys||[]):[];}
    create(){return {schemaVersion:'1.0.0',attemptId:`attempt-${Date.now()}-${Math.random().toString(16).slice(2)}`,examId:this.manifest.examId,contentVersion:this.manifest.contentVersion,classificationVersion:this.manifest.classificationVersion,mode:this.mode,status:'draft',startedAt:null,submittedAt:null,expiresAt:null,updatedAt:new Date().toISOString(),responses:{},reviewFlags:[],timing:{elapsedSeconds:null,remainingSeconds:null},result:null,sync:{state:'local-only',revision:0}};}
    load(){try{const raw=this.storage.getItem(this.key);if(raw){const attempt=JSON.parse(raw);return attempt.examId===this.manifest.examId?attempt:this.create();}for(const legacyKey of this.legacyKeys){const legacyRaw=this.storage.getItem(legacyKey);if(!legacyRaw)continue;const legacy=JSON.parse(legacyRaw),attempt=this.create();attempt.responses=clone(legacy.responses||legacy);attempt.updatedAt=new Date().toISOString();attempt.sync.revision=1;this.storage.setItem(this.key,JSON.stringify(attempt));return attempt;}return this.create();}catch{return this.create();}}
    persist(attempt,changeType){this.storage.setItem(this.key,JSON.stringify(attempt));if(typeof root.dispatchEvent==='function'&&typeof root.CustomEvent==='function')root.dispatchEvent(new CustomEvent('exam-attempt:changed',{detail:{changeType,storageKey:this.key,attempt:clone(attempt)}}));return attempt;}
    saveTiming(timing={}){const attempt=this.load();attempt.timing={...(attempt.timing||{}),...clone(timing)};if(timing.startedAt&&!attempt.startedAt)attempt.startedAt=timing.startedAt;attempt.updatedAt=new Date().toISOString();attempt.sync.revision+=1;return this.persist(attempt,'timing');}
    saveResponses(responses){const attempt=this.load();attempt.responses=clone(responses);attempt.status='draft';attempt.result=null;attempt.submittedAt=null;attempt.updatedAt=new Date().toISOString();attempt.sync.revision+=1;return this.persist(attempt,'responses');}
    saveResult(result){const attempt=this.load();attempt.status='scored';attempt.result=clone(result);attempt.submittedAt=new Date().toISOString();attempt.updatedAt=attempt.submittedAt;attempt.sync.revision+=1;return this.persist(attempt,'result');}
    clear(){this.storage.removeItem(this.key);this.legacyKeys.forEach(key=>this.storage.removeItem(key));}
  }

  function validateManifest(manifest){
    const errors=[],warnings=[];
    ['schemaVersion','examId','contentVersion','classificationVersion','identity','subject','rendering','expected','features','scoring','assets','dataFiles','provenance','publication','publicRights'].forEach(key=>{if(manifest[key]==null)errors.push(`missing ${key}`);});
    if(manifest.identity&&manifest.identity.examFamilyId!==manifest.examSystem)warnings.push('examSystem and identity.examFamilyId differ');
    if(manifest.publication?.state==='public'&&manifest.provenance?.rightsStatus!=='cleared')errors.push('public exam requires cleared rights');
    if(manifest.publication?.state==='public'&&manifest.publicRights?.permissionStatus!=='confirmed')errors.push('public exam requires confirmed public rights notice');
    if(manifest.publication?.state==='public'&&!['confirmed-separately','not-applicable'].includes(manifest.publicRights?.thirdPartyRightsStatus))errors.push('public exam requires completed third-party rights review');
    if(manifest.publication?.state==='public'&&!manifest.dataFiles?.rightsReview)errors.push('public exam requires a rights review record');
    if(manifest.publicRights&&!String(manifest.publicRights.attribution||'').startsWith('出典：'))errors.push('public rights attribution is required');
    if(!Array.isArray(manifest.rendering?.responseTypeIds)||manifest.rendering.responseTypeIds.length===0)errors.push('responseTypeIds are required');
    if(manifest.subject?.paper==='listening'&&!manifest.rendering?.mediaTypeIds?.includes('audio'))warnings.push('listening paper should declare audio');
    return {valid:errors.length===0,errors,warnings};
  }

  const api={ExamCatalog,RendererRegistry,AssetRegistry,ExamPackageRegistry,CommonScoringEngine:Scoring.CommonScoringEngine,GenericScoringEngine,ExamAttemptStore,validateManifest,scoringEngineId:Scoring.engineId};
  root.ExamPlatform=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
