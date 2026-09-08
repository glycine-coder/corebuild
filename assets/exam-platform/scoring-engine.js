(function(root){
  'use strict';

  const clone=value=>value==null?value:(typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value)));
  const numeric=value=>value==null||value===''?null:Number(value);
  const sameSet=(left=[],right=[])=>{
    const a=[...left].map(Number).sort((x,y)=>x-y),b=[...right].map(Number).sort((x,y)=>x-y);
    return a.length===b.length&&a.every((value,index)=>value===b[index]);
  };

  function answeredSlots(definition,value){
    if(definition.type==='single-choice')return value==null||value===''?0:1;
    if(Array.isArray(value))return value.filter(entry=>entry!=null&&entry!=='').length;
    return 0;
  }

  function responseCorrect(definition,value){
    if(definition.type==='single-choice')return numeric(value)===numeric(definition.correct);
    if(definition.type==='multi-select-unordered')return sameSet(value||[],definition.correct||[]);
    if(definition.type==='ordering')return Array.isArray(value)&&value.length===(definition.correct||[]).length&&value.every((entry,index)=>numeric(entry)===numeric(definition.correct[index]));
    return false;
  }

  function categoriesFor(unit,responses){
    if(Array.isArray(unit.categoryIds))return unit.categoryIds;
    return [...new Set((unit.responseKeys||[]).flatMap(key=>responses[key]?.categoryIds||[]))];
  }

  function buildPrototypeResponses(answerModel,choiceCounts={},mode='random',random=Math.random){
    if(!answerModel?.responses)throw new Error('invalid answer model');
    const shuffle=values=>{const result=[...values];for(let index=result.length-1;index>0;index-=1){const swapIndex=Math.floor(random()*(index+1));[result[index],result[swapIndex]]=[result[swapIndex],result[index]];}return result;};
    return Object.fromEntries(Object.entries(answerModel.responses).map(([key,definition])=>{
      if(mode==='perfect')return[key,clone(definition.correct)];
      const correctValues=(Array.isArray(definition.correct)?definition.correct:[definition.correct]).map(Number);
      const choiceCount=Number(choiceCounts[key])||Math.max(...correctValues);
      if(!Number.isInteger(choiceCount)||choiceCount<1)throw new Error(`missing choice count: ${key}`);
      const candidates=Array.from({length:choiceCount},(_,index)=>index+1);
      if(definition.type==='single-choice')return[key,candidates[Math.floor(random()*candidates.length)]];
      const length=definition.type==='multi-select-unordered'?correctValues.length:definition.answerNumbers.length;
      if(length>choiceCount)throw new Error(`choice count is too small: ${key}`);
      return[key,shuffle(candidates).slice(0,length)];
    }));
  }

  class CommonScoringEngine{
    constructor(answerModel){
      this.model=clone(answerModel);
      if(!this.model||!this.model.responses||!Array.isArray(this.model.scoringUnits))throw new Error('invalid answer model');
    }
    answeredCount(responses={}){
      return Object.entries(this.model.responses).reduce((total,[key,definition])=>total+answeredSlots(definition,responses[key]),0);
    }
    isComplete(responses={}){return this.answeredCount(responses)===this.model.answerSlotCount;}
    correctResponseKeys(responses={}){
      return Object.entries(this.model.responses).filter(([key,definition])=>responseCorrect(definition,responses[key])).map(([key])=>key);
    }
    correctValue(responseKey){return clone(this.model.responses[responseKey]?.correct);}
    isChoiceCorrect(responseKey,choice){
      const definition=this.model.responses[responseKey];
      if(!definition)return false;
      if(definition.type==='multi-select-unordered')return (definition.correct||[]).map(Number).includes(Number(choice));
      return definition.type==='single-choice'&&numeric(definition.correct)===numeric(choice);
    }
    score(responses={}){
      const correctKeys=new Set(this.correctResponseKeys(responses));
      const responseOutcomes={},slotOutcomes={};
      let correctSlots=0,score=0;
      Object.entries(this.model.responses).forEach(([key,definition])=>{
        const value=responses[key],answered=answeredSlots(definition,value),correct=correctKeys.has(key);
        responseOutcomes[key]=answered===0?'unanswered':(correct?'correct':'incorrect');
        if(definition.type==='multi-select-unordered'&&definition.slotScoring==='per-correct-choice'){
          const selected=(value||[]).map(Number),expected=(definition.correct||[]).map(Number);
          definition.answerNumbers.forEach((number,index)=>{
            const choice=expected[index],matched=selected.includes(choice);
            slotOutcomes[String(number)]=matched?'match':(selected.length>index?'mismatch':'unanswered');
            if(matched)correctSlots+=1;
          });
        }else{
          definition.answerNumbers.forEach((number,index)=>{
            const hasValue=definition.type==='single-choice'?answered>0:(Array.isArray(value)&&value[index]!=null&&value[index]!=='');
            slotOutcomes[String(number)]=!hasValue?'unanswered':(correct?'match':'mismatch');
          });
          if(correct)correctSlots+=definition.answerNumbers.length;
        }
      });

      const categoryScores={},unitOutcomes={};
      const addCategory=(categoryIds,points,maxPoints,correctCount,responseCount)=>categoryIds.forEach(categoryId=>{
        const row=categoryScores[categoryId]||(categoryScores[categoryId]={score:0,maxScore:0,correctCount:0,responseCount:0});
        row.score+=points;row.maxScore+=maxPoints;row.correctCount+=correctCount;row.responseCount+=responseCount;
      });
      const units=this.model.scoringUnits.map(unit=>{
        const rule=unit.ruleId||unit.rule||unit.mode||'all-correct';
        let awardedPoints=0,status='incorrect',unitCorrect=false,matchedCount=0,responseCount=unit.responseKeys.length;
        if(rule==='per-correct-choice'){
          const definition=this.model.responses[unit.responseKeys[0]],selected=(responses[unit.responseKeys[0]]||[]).map(Number),expected=(definition.correct||[]).map(Number);
          matchedCount=expected.filter(choice=>selected.includes(choice)).length;responseCount=expected.length;
          awardedPoints=matchedCount*Number(unit.pointsPerCorrectChoice||0);
          unitCorrect=sameSet(selected,expected);status=unitCorrect?'correct':(awardedPoints>0?'partial':'incorrect');
        }else{
          unitCorrect=unit.responseKeys.every(key=>correctKeys.has(key));
          awardedPoints=unitCorrect?Number(unit.points):0;status=unitCorrect?'correct':'incorrect';matchedCount=unitCorrect?unit.responseKeys.length:0;
        }
        score+=awardedPoints;
        const outcome={status,awardedPoints,maxPoints:Number(unit.points)};unitOutcomes[unit.unitId]=outcome;
        addCategory(categoriesFor(unit,this.model.responses),awardedPoints,Number(unit.points),matchedCount,responseCount);
        return {...unit,correct:unitCorrect,status,awardedPoints};
      });
      return {
        score,maxScore:this.model.maxScore,correctSlots,answerSlotCount:this.model.answerSlotCount,
        correctCount:correctSlots,responseCount:this.model.answerSlotCount,
        correctResponseKeys:[...correctKeys],units,categoryScores,responseOutcomes,slotOutcomes,unitOutcomes
      };
    }
  }

  const api={engineId:'common-scoring-engine-v1',CommonScoringEngine,responseCorrect,answeredSlots,sameSet,buildPrototypeResponses};
  root.ExamScoring=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
