import { createHash } from 'node:crypto';

export const learningFacets=['pacing','dialogue','setup_payoff','framing','sound','finishing','general'] as const;
export type LearningFacet=typeof learningFacets[number];
export type LearningMetadata={
  facet:LearningFacet;formats:string[];subjects:string[];
  signal:'reference'|'explicit_feedback'|'approved_revision'|'manual_export';
  eventID:string;independenceKey:string;explicitReusable?:boolean;occurredAt?:string;
  reinforcesIDs?:string[];supersedesIDs?:string[];
};
export type MemoryContext={formats?:string[];subjects?:string[];facets?:LearningFacet[];sourceContext?:string};
export type Strength='weak'|'moderate'|'strong';
export function normalized(value:string):string {return value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
const formatAliases:Record<string,string>={tiktok:'short_form',reels:'short_form',reel:'short_form',shorts:'short_form','short form':'short_form'};
const subjectAliases:Record<string,string>={aviation:'flight',flying:'flight',flights:'flight',golfing:'golf','golf swings':'golf','golf swing':'golf'};
const aliases={...formatAliases,...subjectAliases};
function category(value:string):string {const n=normalized(value);return aliases[n]??n;}
export function normalizeLearning(value:LearningMetadata):LearningMetadata {
  if(!learningFacets.includes(value.facet)||!['reference','explicit_feedback','approved_revision','manual_export'].includes(value.signal))throw new Error('Invalid learning classification');
  if(!value.eventID?.trim()||!value.independenceKey?.trim())throw new Error('Learning must identify its event and independent example');
  if(value.occurredAt!==undefined&&(typeof value.occurredAt!=='string'||!Number.isFinite(Date.parse(value.occurredAt))))throw new Error('Invalid learning event time');
  const categories=(items:string[])=>{
    if(!Array.isArray(items)||items.length>12||items.some(x=>typeof x!=='string'||!x.trim()||x.length>100))throw new Error('Invalid learning applicability');
    return [...new Set(items.map(category))].sort();
  };
  const links=(ids:string[]|undefined)=>{
    if(ids===undefined)return [];
    if(!Array.isArray(ids)||ids.length>12||ids.some(x=>typeof x!=='string'||!x.trim()))throw new Error('Invalid learning relationship');
    return [...new Set(ids)];
  };
  return {facet:value.facet,formats:categories(value.formats),subjects:categories(value.subjects),signal:value.signal,
    eventID:value.eventID,independenceKey:value.independenceKey,explicitReusable:value.signal==='explicit_feedback'&&value.explicitReusable===true,
    ...(value.occurredAt?{occurredAt:new Date(value.occurredAt).toISOString()}:{}),
    reinforcesIDs:links(value.reinforcesIDs),supersedesIDs:links(value.supersedesIDs)};
}
export function learningContextKey(kind:string,scope:string|null,learning:LearningMetadata|undefined,context:string):string {
  return JSON.stringify([kind,scope,learning?[learning.facet,learning.formats,learning.subjects]:normalized(context)]);
}
export function defaultRuleKey(contextKey:string,statement:string):string {
  // Decimal points, ranges and signs change numeric instructions. Preserve
  // them in identity while still ignoring ordinary typographic punctuation.
  const semanticNumbers=statement.normalize('NFKC').replace(/(?<=\d)[.,](?=\d)/g,m=>m==='.'?' decimal ':' comma ')
    .replace(/(?<=\d)\s*[-‐‑‒–—]\s*(?=\d)/g,' through ')
    .replace(/(^|\s)[-−](?=\d)/g,' negative ');
  return createHash('sha256').update(JSON.stringify([contextKey,normalized(semanticNumbers)])).digest('hex');
}
export function evidenceStrength(kind:string,signals:LearningMetadata[],supportCount:number,legacy:Strength[]):Strength {
  // A model's confidence is not evidence of a user's preference.
  if(kind==='personal_lesson'&&signals.some(s=>s.signal==='explicit_feedback'&&s.explicitReusable))return 'strong';
  if(supportCount>=2)return 'moderate';
  if(signals.length)return 'weak';
  return legacy.includes('strong')?'strong':legacy.includes('moderate')?'moderate':'weak';
}
const facetWords:Record<LearningFacet,string[]>={
  pacing:['pace','pacing','fast','faster','slow','slower','shorter','longer','length','duration','seconds','trim','cut'],
  dialogue:['dialogue','speech','talk','talking','sentence','sentences','word','words','reaction','voice'],
  setup_payoff:['story','chronological','chronology','setup','payoff','before','after','reaction','follow through','followthrough','landing','swing'],
  framing:['frame','framing','crop','portrait','landscape','vertical','horizontal','zoom'],
  sound:['sound','audio','music','volume','mute','loud','quiet'],
  finishing:['text','overlay','caption','title','transition','speed','rotation'],general:[]};
export function requestContext(brief:string,context:MemoryContext={}):{text:string;requestedText:string;facets:Set<LearningFacet>;formats:Set<string>;subjects:Set<string>} {
  const text=normalized([brief,context.sourceContext??''].join(' '));
  const requestedText=normalized(brief);
  const contains=(word:string)=>(' '+text+' ').includes(' '+normalized(word)+' ');
  const facets=new Set(context.facets??[]);
  for(const [facet,words] of Object.entries(facetWords))if(words.some(contains))facets.add(facet as LearningFacet);
  const formats=new Set((context.formats??[]).map(category));
  const subjects=new Set((context.subjects??[]).map(category));
  // Scene evidence can establish the subject, but it cannot choose the output
  // format. A source mentioning TikTok is not a request for a TikTok edit.
  for(const [alias,canonical] of Object.entries(formatAliases))if((' '+requestedText+' ').includes(' '+alias+' '))formats.add(canonical);
  for(const [alias,canonical] of Object.entries(subjectAliases))if(contains(alias))subjects.add(canonical);
  return {text,requestedText,facets,formats,subjects};
}
export function matchesApplicability(learning:LearningMetadata|undefined,request:ReturnType<typeof requestContext>):boolean {
  if(!learning)return true;
  // Recognize direct category exclusions only. "Do not cut off the golf
  // follow-through" negates an operation, not the golf subject. General intent
  // and semantic contradictions remain the planner's job, not a regex parser.
  const excluded=(value:string)=>{
    const terms=[normalized(value),...Object.entries(aliases).filter(([,v])=>v===value).map(([alias])=>alias)];
    let last=-1,negative=false;
    for(const term of terms){
      const needle=' '+term+' ',haystack=' '+request.requestedText+' ';let position=haystack.indexOf(needle);
      while(position!==-1){
        if(position>last){
          last=position;negative=/(?:^| )(?:no|not|without|avoid|exclude|skip)(?: (?:a|an|the|any|using))? $|(?:^| )(?:not|don t) (?:use|include|follow)(?: (?:a|an|the|any))? $/.test(haystack.slice(0,position+1));
        }
        position=haystack.indexOf(needle,position+1);
      }
    }
    return negative;
  };
  const matches=(values:string[],known:Set<string>,text:string)=>!values.length||values.some(v=>!excluded(v)&&(known.has(v)||(' '+text+' ').includes(' '+normalized(v)+' ')));
  return matches(learning.formats,request.formats,request.requestedText)&&matches(learning.subjects,request.subjects,request.text);
}
