import {uiMessage} from './ui-messages.mjs';
import {focusModelOption,rovingModelOption,syncModelOptions} from './model-navigation.mjs';
export function createStrataPanel(React){
  const h=React.createElement;
  return function StrataPanel({api,job,onStatus,onInstalled,cached,onCatalog}){
    const [catalog,setCatalog]=React.useState(cached),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[selected,setSelected]=React.useState(null);
    const list=React.useRef(null);
    React.useEffect(()=>syncModelOptions(list.current));
    const refresh=async()=>{const value=await api.strata('catalog');setCatalog(value);onCatalog(value);return value;};
    React.useEffect(()=>{let alive=true;api.strata('catalog').then(value=>{if(alive){setCatalog(value);onCatalog(value);}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[job?.state]);
    const act=async(action,value)=>{setBusy(true);setError('');try{
      const result=action==='cancel'?await api.cancel():await api.strata(action,value);
      if(['catalog','unload','directory'].includes(action)){setCatalog(result);onCatalog(result);if(action==='unload')await onInstalled(false);}else onStatus(result);
      setSelected(null);
    }catch(e){setError(e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''));}finally{setBusy(false);}};
    const working=busy||job?.state==='running';
    return h('section',{className:'notch-engine-panel','aria-label':'Experimental Strata'},
      h('p',{className:'notch-model-note'},'Strata · experimental. Runs supported Qwen MoE models with CUDA, AMD HIP or Apple Metal. Hardware and free memory are checked before loading. Speed benchmarks are off.'),
      !catalog?h('p',{role:'status'},'Checking Strata…'):!catalog.installed?
        h('button',{type:'button',className:'notch-engine-setup',disabled:working,onClick:()=>void act('setup')},'Set up Strata control runtime'):
        h(React.Fragment,null,
          h('p',{className:'notch-model-note'},`Strata ${catalog.version} · ${catalog.running?'loaded':'unloaded'}${catalog.gpu?` · ${catalog.gpu}`:''}`),
          h('p',{className:'notch-model-note'},uiMessage(catalog.reason)),
          h('fieldset',{className:'notch-engine-backends'},h('legend',null,'Detected backend support'),
            ...(catalog.backends||[]).map(row=>h('label',{key:row.backend},
              h('input',{type:'radio',name:'strata-backend',checked:!!row.available,disabled:true,readOnly:true}),h('span',null,h('strong',null,row.backend.toUpperCase()),h('small',null,uiMessage(row.available?'Detected automatically':row.reason)))))),
          h('div',{className:'notch-engine-path'},h('strong',null,'Model folder'),h('code',null,catalog.dataDirectory),h('small',null,`${((catalog.freeDiskBytes||0)/1e9).toFixed(1)} GB free. Existing downloads stay where they are.`)),
          h('div',{className:'notch-engine-actions'},
            h('button',{type:'button',disabled:working,onClick:()=>void act('directory')},'Choose model folder'),
            h('button',{type:'button',disabled:working,onClick:()=>void act('catalog')},'Refresh hardware and memory'),
            h('button',{type:'button',disabled:working||!catalog.running,onClick:()=>void act('unload')},'Unload Strata')),
          selected?h('div',{className:'notch-model-confirm',role:'group','aria-label':'Confirm Strata model download'},
            h('strong',null,selected.name),h('p',null,`About ${selected.download_gb} GB of model files, plus engine and helper files. Existing chats and other models are retained.`),
            h('p',null,uiMessage(selected.reason)),h('button',{type:'button',disabled:working||!selected.fits,onClick:()=>void act('install',selected.id)},'Download model'),
            h('button',{type:'button',disabled:working,onClick:()=>setSelected(null)},'Back')):
            h('div',{ref:list,className:'notch-model-list',role:'listbox','aria-label':'Experimental Strata models',onKeyDown:event=>focusModelOption(event,list.current),onFocus:event=>rovingModelOption(event,list.current)},...(catalog.models||[]).map(row=>
              h('button',{key:row.id,type:'button',role:'option','aria-selected':false,tabIndex:row===(catalog.models||[]).find(item=>item.fits)?0:-1,disabled:working||!row.fits,title:uiMessage(row.reason),onClick:()=>setSelected(row)},
                h('strong',null,row.name),h('small',null,`${row.download_gb} GB · ${row.contextWindow?`${row.contextWindow.toLocaleString()} tokens`:'No safe automatic context'}`),h('small',null,uiMessage(row.reason)))))),
      job?.runner==='strata'?h('div',{className:'notch-model-job',role:job.state==='failed'?'alert':'status'},
        h('p',null,uiMessage(job.message)),job.state==='running'?h('button',{type:'button',disabled:busy,onClick:()=>void act('cancel')},'Cancel'):
        job.state==='complete'?h('button',{type:'button',disabled:busy,onClick:async()=>{try{await refresh();await onInstalled(true);}catch(e){setError(e.message);}}},'Refresh installed models'):null):null,
      error?h('p',{className:'notch-model-error',role:'alert'},uiMessage(error)):null);
  };
}
