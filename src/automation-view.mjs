import { uiMessage } from "./ui-messages.mjs";
import {newAutomationPolicy} from './automation-policy.mjs';

export function createAutomationViews(React){
  const h=React.createElement,api=(action,value)=>window.notchModels.automations(action,value);
  const box={display:'grid',gap:12,fontSize:12,lineHeight:1.6},control={width:'100%',padding:'7px 9px',border:'1px solid var(--notch-line)',borderRadius:7,background:'var(--notch-panel)',color:'inherit',font:'inherit'};
  const button=(label,onClick,disabled=false)=>h('button',{type:'button',onClick,disabled,style:{...control,width:'auto',cursor:'pointer'}},label);
  function Options({value,onChange,taskId,schedule}){
    const [message,setMessage]=React.useState(''),[saving,setSaving]=React.useState(false);
    const field=(label,node,help)=>h('label',{style:{display:'grid',gap:4}},h('span',{style:{fontWeight:500}},label),node,help&&h('span',{style:{opacity:.65}},help));
    const select=(key,choices)=>h('select',{'aria-label':key==='notifications'?'Notifications':'After Notch was closed',style:control,value:value[key],onChange:event=>onChange({...value,[key]:event.target.value})},choices.map(([id,label])=>h('option',{key:id,value:id},label)));
    return h('section',{'aria-label':'Automation run options',style:box},
      h('h3',{style:{fontWeight:600,margin:'4px 0 0'}},'Run options'),
      field('Time limit (minutes)',h('input',{'aria-label':'Time limit (minutes)',type:'number',min:0,max:1440,step:1,style:control,value:value.maxRuntimeMs/60000,onChange:event=>onChange({...value,maxRuntimeMs:Math.round(Number(event.target.value)*60000)})}),'0 allows unlimited time, including waiting for a model.'),
      field('Token budget',h('input',{'aria-label':'Token budget',type:'number',min:0,max:10000000,step:1,style:control,value:value.maxTokens,onChange:event=>onChange({...value,maxTokens:Number(event.target.value)})}),'Input and output tokens across the run. 0 allows unlimited tokens.'),
      field('Notifications',select('notifications',[['changes','Changed results and errors'],['errors','Errors only'],['all','Every completed run'],['off','Off']]),'Repeated identical errors stay quiet. Begin unchanged reports with [NO_CHANGE] to suppress them.'),
      field('After Notch was closed',select('missedRuns',[['latest','Run the latest missed occurrence'],['skip','Skip missed occurrences']]),'Older missed occurrences are recorded in history. Notch must be open to run automations.'),
      h('label',{style:{display:'flex',alignItems:'start',gap:8}},h('input',{type:'checkbox',checked:value.retryResources,onChange:event=>onChange({...value,retryResources:event.target.checked})}),'Wait up to 5 minutes for a busy local model or available memory'),
      h(Preview,{schedule}),
      taskId&&button(saving?'Saving preset…':'Save current automation as preset',async()=>{setSaving(true);setMessage('');try{await api('savePreset',taskId);setMessage('Saved. Find it in Presets.');}catch(error){setMessage(error.message);}finally{setSaving(false);}},saving),
      taskId&&h('span',{style:{opacity:.65}},'Presets use the last saved task. Save edits before creating a preset.'),
      message&&h('p',{role:'status',style:{margin:0}},uiMessage(message, "Status details are unavailable. Refresh to check again.")));
  }
  function Preview({schedule}){
    const [result,setResult]=React.useState(null);const key=JSON.stringify(schedule);
    React.useEffect(()=>{let disposed=false;setResult(null);const timer=setTimeout(()=>{if(schedule?.error){setResult({error:schedule.error});return;}api('preview',schedule).then(value=>{if(!disposed)setResult(value);},error=>{if(!disposed)setResult({error:error.message});});},250);return()=>{disposed=true;clearTimeout(timer);};},[key]);
    return h('div',{'aria-live':'polite',style:{...box,gap:5}},h('strong',null,'Next scheduled runs'),!result?'Checking schedule…':result.error?h('span',null,uiMessage(result.error)):h(React.Fragment,null,h('span',{style:{opacity:.65}},result.timeZone),h('ol',{style:{margin:0,paddingLeft:20}},result.runs.map(time=>h('li',{key:time},new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:result.timeZone}).format(time))))));
  }
  function Status(){
    const [status,setStatus]=React.useState(null);
    React.useEffect(()=>{let disposed=false,timer;async function refresh(){try{const value=await api('status');if(!disposed)setStatus(value);}catch(error){if(!disposed)setStatus({schedulerError:error.message,active:[]});}finally{if(!disposed)timer=setTimeout(refresh,3000);}}void refresh();return()=>{disposed=true;clearTimeout(timer);};},[]);
    if(!status||!status.schedulerError&&!status.active.length)return null;
    return h('section',{'aria-label':'Automation activity','aria-live':'polite',style:{...box,marginBottom:16,padding:12,border:'1px solid var(--border-secondary, #8884)',borderRadius:8}},status.schedulerError&&h('p',{role:'alert',style:{margin:0}},uiMessage(status.schedulerError)),status.active.map(run=>h('div',{key:run.runId},h('strong',null,run.name),h('span',null,uiMessage(' · '+run.message)),run.tokens>0&&h('span',{style:{opacity:.65}},' · '+run.tokens.toLocaleString()+' tokens'))));
  }
  function Presets({onChanged}){
    const [presets,setPresets]=React.useState([]),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
    React.useEffect(()=>{let disposed=false;api('catalog').then(value=>{if(!disposed)setPresets(value.modes.coding.filter(row=>row.id.startsWith('saved-')));},error=>{if(!disposed)setError(error.message);});return()=>{disposed=true;};},[]);
    if(!presets.length&&!error)return null;
    return h('details',{style:{...box,marginTop:20}},h('summary',null,'Manage saved presets'),presets.map(row=>h('div',{key:row.id,style:{display:'flex',justifyContent:'space-between',gap:12,marginTop:10}},h('span',null,row.name['en-US']),button('Remove preset',async()=>{setBusy(true);setError('');try{await api('deletePreset',row.id);setPresets(list=>list.filter(item=>item.id!==row.id));await onChanged?.();}catch(error){setError(error.message);}finally{setBusy(false);}},busy))),error&&h('p',{role:'alert'},uiMessage(error)));
  }
  function History({component:Component,...props}){
    const [offset,setOffset]=React.useState(0),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),generation=React.useRef(0);
    React.useEffect(()=>{generation.current++;setOffset(0);setError('');setBusy(false);},[props.taskId,props.status]);
    const query=props.service.local.lastRunLogQuery;
    React.useEffect(()=>{if(!query?.offset){generation.current++;setOffset(0);setBusy(false);}},[query]);
    async function page(next){const request=++generation.current;setBusy(true);setError('');try{const taskId=props.taskId?.replace(/^local:/,'');await props.service.local.loadRunLogs({taskId,status:props.status,limit:100,offset:next});if(request===generation.current)setOffset(next);}catch(error){if(request===generation.current)setError(error.message);}finally{if(request===generation.current)setBusy(false);}}
    return h(React.Fragment,null,h(Component,props),h('nav',{'aria-label':'Automation history pages',style:{display:'flex',gap:12,alignItems:'center',marginTop:16}},button('Newer runs',()=>page(Math.max(0,offset-100)),busy||props.loading||offset===0),h('span',null,'Page '+(offset/100+1)),button('Older runs',()=>page(offset+100),busy||props.loading||props.logs.length<100)),error&&h('p',{role:'alert'},uiMessage(error)));
  }
  function Storage(){
    const [result,setResult]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
    async function run(action){setBusy(true);setError('');try{setResult(await window.notchModels.maintenance(action));}catch(error){setError(error.message);}finally{setBusy(false);}}
    const available=result?.flatMap(row=>row.available.filter(version=>!row.removed.includes(version)).map(version=>row.provider+' '+version))??[];
    return h('section',{style:{...box,marginTop:24},'aria-label':'Runtime storage'},h('h3',{style:{fontWeight:600,margin:0}},'Runtime storage'),h('p',{style:{margin:0,opacity:.7}},'Review unused engine versions. The current and previous versions, active engines, unrecognized folders, and your models are kept.'),button(busy?'Checking…':'Review unused runtimes',()=>run('review'),busy),result&&h('p',{role:'status',style:{margin:0}},result.some(row=>row.removed.length)?'Removed unused runtime versions.':available.length?available.join(', '):'No safely removable runtime versions found.'),available.length>0&&button('Remove unused runtimes',()=>run('clean'),busy),error&&h('p',{role:'alert'},uiMessage(error)));
  }
  return{Options,Status,Presets,History,Storage,newPolicy:newAutomationPolicy};
}
