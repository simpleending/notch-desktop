import { uiMessage } from "./ui-messages.mjs";
import { focusModelOption, rovingModelOption, syncModelOptions } from './model-navigation.mjs';

export function createColibriPanel(React) {
  const h=React.createElement;
  return function ColibriPanel({api,job,onStatus,onInstalled,cached,onCatalog}) {
    const [catalog,setCatalog]=React.useState(cached),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[selected,setSelected]=React.useState(null);
    const list=React.useRef(null),confirmation=React.useRef(null),returnFocus=React.useRef(null);
    React.useEffect(()=>syncModelOptions(list.current));
    React.useEffect(()=>{if(selected)confirmation.current?.focus();else if(returnFocus.current){[...(list.current?.querySelectorAll('[role=option]')||[])].find(row=>row.dataset.modelId===returnFocus.current)?.focus();returnFocus.current=null;}},[selected]);
    const reload=async()=>{const value=await api.colibri('catalog');setCatalog(value);onCatalog(value);return value;};
    React.useEffect(()=>{let alive=true;api.colibri('catalog').then(value=>{if(alive){setCatalog(value);onCatalog(value);}}).catch(error=>{if(alive)setError(error.message);});return()=>{alive=false;};},[job?.state]);
    const act=async(action,model)=>{setBusy(true);setError('');try{const value=action==='cancel'?await api.cancel():await api.colibri(action,model);if(action==='catalog'){setCatalog(value);onCatalog(value);}else if(action==='unload'){setCatalog(value);await onInstalled(false);}else onStatus(value);setSelected(null);}catch(error){setError(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''));}finally{setBusy(false);}};
    const working=busy||job?.state==='running';
    const memory=catalog?.models?.[0]?.memory;
    return h(React.Fragment,null,
      h('p',{className:'notch-model-note'},'Experimental local engine. Colibri streams model experts from disk. A model can fit in RAM and still respond slowly; a fast SSD helps. Ollama remains the default.'),
      !catalog?h('p',{role:'status'},'Checking Colibri…'):!catalog.installed?h(React.Fragment,null,
        h('p',{className:'notch-model-note'},'Set up the isolated engine (under 16 MB). Requires 64-bit Python 3.10+. Model weights download separately after you choose one.'),
        h('button',{type:'button',disabled:working,onClick:()=>void act('setup')},'Set up Colibri (experimental)')):h(React.Fragment,null,
        h('div',{className:'notch-provider-status'},h('span',null,`Colibri ${catalog.version} · ${catalog.running?'loaded':'unloaded'}${catalog.backend?` · ${catalog.backend==='cpu'?'CPU':catalog.backend}`:''}`),h('button',{type:'button',disabled:working,onClick:()=>void act('unload')},'Unload model')),
        h('div',{className:'notch-provider-status'},h('span',{role:'status'},memory?`${(memory.availableBytes/1e9).toFixed(1)} GB available of ${(memory.totalBytes/1e9).toFixed(1)} GB usable RAM · ${(memory.reserveBytes/1e9).toFixed(1)} GB reserved for other apps`:'Available RAM could not be verified.'),h('button',{type:'button',disabled:working,onClick:()=>void act('catalog')},'Refresh memory')),
        h('p',{className:'notch-model-note'},'Memory estimates use the RAM currently available. Download size is the disk space needed to store the model. Longer conversations need more memory. Available memory is checked again before loading. Downloads resume if interrupted. Models are checked for coding-tool support before they can be selected.'),
        selected?h('div',{ref:confirmation,tabIndex:-1,className:'notch-model-confirm',role:'group','aria-label':'Confirm Colibri model download'},
          h('strong',null,selected.name),h('p',null,`${selected.download_gb} GB download · ${selected.ram_min_gb} GB minimum / ${selected.ram_good_gb} GB recommended RAM. ${selected.license_note||'Review the model license before use.'}`),
          h('strong',null,uiMessage(selected.fitLabel)),h('p',null,uiMessage(selected.reason)),h('button',{type:'button',disabled:working||!selected.fits,onClick:()=>void act('install',selected.id)},'Download and validate'),h('button',{type:'button',disabled:working,onClick:()=>setSelected(null)},'Back to models')):
          h('div',{ref:list,className:'notch-model-list',role:'listbox','aria-label':'Colibri coding models',onKeyDown:event=>focusModelOption(event,list.current),onFocus:event=>rovingModelOption(event,list.current)},...(catalog.models||[]).map((row,index)=>h('button',{type:'button',role:'option',key:row.id,'data-model-id':row.id,tabIndex:index===0?0:-1,'aria-selected':false,disabled:working,onClick:()=>{returnFocus.current=row.id;setSelected(row);}},
            h('strong',null,row.name),h('small',null,`${row.fitLabel} · ${row.download_gb} GB download · ${row.ram_min_gb} GB minimum / ${row.ram_good_gb} GB recommended RAM`),h('small',null,uiMessage(row.reason)))))),
      job?.runner==='colibri'?h('div',{className:'notch-model-job',role:job.state==='failed'?'alert':'status'},h('div',null,h('strong',null,job.repo),h('p',null,uiMessage(job.message, 'Model status details are unavailable. Refresh to check again.')),job.state==='running'?h('progress',{'aria-label':'Colibri setup progress'}):null),
        job.state==='running'?h('button',{type:'button',disabled:busy,onClick:()=>void act('cancel')},'Cancel'):job.state==='complete'?h('button',{type:'button',disabled:busy,onClick:async()=>{try{await reload();await onInstalled(true);}catch(error){setError(error.message);}}},'Refresh installed models'):null):null,
      error?h('p',{className:'notch-model-error',role:'alert'},uiMessage(error)):null);
  };
}
