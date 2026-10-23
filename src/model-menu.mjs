import { uiMessage } from "./ui-messages.mjs";
import {createStrataPanel} from './strata-panel.mjs';
import {createColibriPanel} from './colibri-panel.mjs';
import { createLoadingSkeleton } from './loading-skeleton.mjs';
import { OPENROUTER_FALLBACK_LIMIT, normalizeOpenRouterFallbacks } from './model-policy.mjs';
import { focusModelOption, rovingModelOption, focusModelTab, syncModelOptions } from './model-navigation.mjs';
import { withModelActivity } from './model-activity.mjs';
const logo = name => new URL(`./providers/${name}.svg`,import.meta.url).href;
const formatContext = tokens => `${Math.round(tokens/1024)}K`;
const formatSize = bytes => `${(bytes/2**30).toFixed(1)} GiB`;
export const isModelSelectable = (row, options = [], loading = false) => row.enabled && !loading && options.some(option=>option.value===row.key && !option.disabled);
export const modelSource = row => row.provider === 'openrouter' ? 'Cloud · OpenRouter' : `Local · ${{ollama:'Ollama',mlx:'MLX',colibri:'Colibri (experimental)',strata:'Strata (experimental)'}[row.provider] || row.provider}`;
export const needsLocalModelSetup = state => Array.isArray(state?.models) && !state.discoveryWarning && !state.models.some(row=>row.provider!=='openrouter' && row.enabled && row.tools!==false);
const setupWindows=new WeakSet();
export const readyModels = (rows, options, { query = '', current, recent = [] } = {}) => {
  const search = query.trim().toLowerCase();
  const order = [current, ...recent];
  const rank = key => { const index = order.indexOf(key); return index < 0 ? order.length : index; };
  return rows.filter(row => row.tools !== false && isModelSelectable(row, options) && `${row.displayName} ${row.key} ${modelSource(row)}`.toLowerCase().includes(search))
    .sort((left, right) => rank(left.key) - rank(right.key));
};
export const fallbackCandidates = (rows = [], primary, chain = []) => {
  const taken = new Set([primary, ...chain]);
  return rows.filter(row => row.provider === 'openrouter' && row.enabled && row.tools !== false && !taken.has(row.key));
};
const moveItem = (list, from, to) => {
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
};

/** Keep the workbench's popover focus/dismissal behavior and composer selection callback. */
export function createModelMenu(React, { Popover, PopoverTrigger, PopoverContent }, useTheme) {
  const h = React.createElement;
  const ColibriPanel=createColibriPanel(React),StrataPanel=createStrataPanel(React);
  const LoadingSkeleton=createLoadingSkeleton(React);
  return function ModelMenu(props) {
    const api = window.notchModels, { resolvedTheme } = useTheme();
    const [innerOpen,setInnerOpen] = React.useState(false), open = !!api && (props.open ?? innerOpen);
    const [tab,setTab] = React.useState(props.manageOnly ? 'installed' : 'ready'), [state,setState] = React.useState(null), [hub,setHub] = React.useState(null);
    const [stateLoading,setStateLoading] = React.useState(true);
    const [recent,setRecent] = React.useState(()=>{try{const saved=JSON.parse(localStorage.getItem('notch.models.recent') || '[]');return Array.isArray(saved)?saved.filter(key=>typeof key==='string').slice(0,5):[];}catch{return [];}});
    const [search,setSearch] = React.useState(''), [key,setKey] = React.useState(''), [busy,setBusy] = React.useState(false);
    const [error,setError] = React.useState(''), [confirm,setConfirm] = React.useState(null), [optional,setOptional] = React.useState(()=>{try{return localStorage.getItem('notch.models.hideHfToken')!=='1';}catch{return true;}});
    const [hubLoading,setHubLoading] = React.useState(false);
    const [runtimeMessage,setRuntimeMessage]=React.useState('');
    const [runtimeKey,setRuntimeKey]=React.useState('');
    const [colibri,setColibri]=React.useState(null);
    const [strata,setStrata]=React.useState(null);
    const [cloud,setCloud]=React.useState([]),[cloudLoading,setCloudLoading]=React.useState(false),cloudRequest=React.useRef(0);
    const [extended,setExtended] = React.useState(()=>{try{return localStorage.getItem('notch.models.extendedContext')==='1';}catch{return false;}});
    const [fallbacksOpen,setFallbacksOpen] = React.useState(false), [pickingFallback,setPickingFallback] = React.useState(false);
    const [runner,setRunner] = React.useState(''), list = React.useRef(null), request = React.useRef(0), hubRequest=React.useRef(0), interactedOutside = React.useRef(false), id = React.useId();
    const confirmation = React.useRef(null), returnFocus = React.useRef(null), searchInput = React.useRef(null), focusSearch = React.useRef(false);
    const setupOpening=React.useRef(false);
    React.useEffect(() => syncModelOptions(list.current));
    React.useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [search, tab, runner]);
    React.useEffect(() => { if(open){setTab(props.manageOnly || setupOpening.current ? 'installed' : 'ready');setupOpening.current=false;setSearch('');} }, [open,props.manageOnly]);
    React.useEffect(() => { if(focusSearch.current){searchInput.current?.focus();focusSearch.current=false;} }, [tab]);
    React.useEffect(() => {
      if (confirm) confirmation.current?.focus();
      else if (returnFocus.current) {
        if (tab === 'hub') { const target = returnFocus.current; if (target.isConnected && !target.disabled) target.focus(); else searchInput.current?.focus(); }
        returnFocus.current = null;
      }
    }, [confirm, tab]);
    const changeOpen = value => { setInnerOpen(value); props.onOpenChange?.(value); if (!value) { setKey(''); setConfirm(null); setFallbacksOpen(false); setPickingFallback(false); request.current++; } };
    const act = async fn => { setBusy(true); setError(''); try { await fn(); } catch (error) { setError(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'')); } finally { setBusy(false); } };
    const reload = async refresh => { setStateLoading(true);try{const data = await api.state(refresh); setState(data); if(data.keyLoadError)setError(data.keyLoadError); return data;}finally{setStateLoading(false);} };
    const loadHub=async (page=0,force=false)=>{
      const current=++hubRequest.current;setHubLoading(true);setError('');
      try {
        const data=await api.hub(runner || undefined,{query:search,page,force});if(current!==hubRequest.current)return;
        setHub(previous=>page && previous?.query===data.query?{...data,models:[...new Map([...previous.models,...data.models].map(row=>[row.repo,row])).values()]}:data);
        if(data.warning)setError(data.warning);
      } catch(error){if(current===hubRequest.current)setError(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''));}
      finally {if(current===hubRequest.current)setHubLoading(false);}
    };
    const loadCloud=async(force=false)=>{
      const current=++cloudRequest.current;setCloudLoading(true);setError('');
      try{const rows=await api.cloud(force);if(current===cloudRequest.current)setCloud(rows);}
      catch(error){if(current===cloudRequest.current)setError(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''));}
      finally{if(current===cloudRequest.current)setCloudLoading(false);}
    };
    React.useEffect(() => {
      if (!api) return;
      if (open) interactedOutside.current = false;
      const current = ++request.current;
      setError('');setStateLoading(true);
      api.state().then(data=>{if(request.current===current){setState(data);
        if(!props.manageOnly && !props.loading && !props.disabled && !setupWindows.has(window) && needsLocalModelSetup(data)){
          setupWindows.add(window);setupOpening.current=true;setTab('installed');changeOpen(true);
        }
        if(open && data.models.some(row=>row.enabled && !props.options?.some(option=>option.value===row.key)))props.onOpenChange?.(true);
      }}).catch(error=>{if(request.current===current)setError(error.message);}).finally(()=>{if(request.current===current)setStateLoading(false);});
      return () => { request.current++; };
    },[open,props.loading,props.disabled]);
    React.useEffect(() => {
      hubRequest.current++;if (!open || tab!=='hub') { setHubLoading(false); return; }
      setHubLoading(true);setError('');const timer=setTimeout(()=>void loadHub(),search?350:0);
      return ()=>{clearTimeout(timer);hubRequest.current++;};
    },[open,tab,runner,search,state?.huggingface]);
    React.useEffect(()=>{
      if(!open || tab!=='cloud'){setCloudLoading(false);return;}
      void loadCloud();return()=>{cloudRequest.current++;};
    },[open,tab,state?.openrouter]);
    React.useEffect(() => {
      if (!open || state?.job?.state!=='running') return;
      let cancelled = false;
      const timer = setInterval(()=>api.status().then(status=>{if(!cancelled)setState(previous=>({...previous,...status}));}).catch(()=>{}),1000);
      return ()=>{cancelled=true;clearInterval(timer);};
    },[open,state?.job?.state]);
    const displayError=error||state?.keyLoadError||state?.discoveryWarning;
    const all = state?.models || [], current = all.find(row=>row.key===props.value) || ((!props.value || props.value==='auto') ? all.find(row=>row.key===state?.defaultModel) : undefined);
    const native = props.options?.find(row=>row.value===props.value);
    const local = current && current.provider!=='openrouter';
    const contextChoices = current?.availableContextWindows.filter(tokens=>!local || tokens<=131072 || extended || current.requestedContextWindow===tokens) || [];
    const label = current?.displayName || native?.label || (props.loading?'Loading models…':props.fallbackLabel || 'Choose model');
    const provider = tab==='cloud'?'openrouter':'huggingface', connected = state?.[provider];
    const job = state?.job;
    const inputId = `${id}-key`;
    const connectForm = (tab==='cloud' && !connected) || (tab==='hub' && !connected && optional);
    const selectable = row => props.manageOnly ? row.enabled && !props.loading : isModelSelectable(row,props.options,props.loading);
    const chain = current?.provider==='openrouter' ? normalizeOpenRouterFallbacks(current.key, state?.fallbacks?.[current.key]) : [];
    const loaded=all.filter(row=>row.key!=='auto'&&row.provider!=='openrouter'&&row.running);
    const changeRuntime=(row,action)=>act(async()=>{
      setRuntimeKey(row.key);
      setRuntimeMessage(`${action==='eject'||row.running?'Ejecting':'Loading'} ${row.displayName}…`);
      try{
        const data=await withModelActivity(()=>api.runtime(action,row.key));setState(data);
        if(data.loaded){await props.onSelect(row.key);if(!props.manageOnly){const next=[row.key,...recent.filter(key=>key!==row.key)].slice(0,5);setRecent(next);try{localStorage.setItem('notch.models.recent',JSON.stringify(next));}catch{}changeOpen(false);}}
      }finally{setRuntimeMessage('');setRuntimeKey('');}
    });
    const saveFallbacks = ids => act(async()=>{ const data=await api.fallbacks(current.key, ids); setState(data); });
    const select = row => {
      if(busy)return;
      if(pickingFallback && current?.provider==='openrouter'){
        if(row.provider!=='openrouter' || !row.enabled)return;
        const next=normalizeOpenRouterFallbacks(current.key,[...chain,row.key]);
        if(next.length===chain.length)return;
        void act(async()=>{ const data=await api.fallbacks(current.key,next); setState(data); setPickingFallback(false); });
        return;
      }
      if(!selectable(row))return;
      if(row.provider!=='openrouter'){void changeRuntime(row,'toggle');return;}
      props.onSelect(row.key); if(!props.manageOnly){const next=[row.key,...recent.filter(key=>key!==row.key)].slice(0,5);setRecent(next);try{localStorage.setItem('notch.models.recent',JSON.stringify(next));}catch{}changeOpen(false);}
    };
    const keyboard = event => focusModelOption(event, list.current);
    const tabs = [['installed','Installed'],['hub','Hugging Face'],['cloud','OpenRouter'],['colibri','Colibri'],['strata','Strata']];
    const switchTab = name => { focusSearch.current=name==='ready' || tab==='ready';setTab(name);setSearch('');setKey('');setConfirm(null);setError(''); setFallbacksOpen(false); setPickingFallback(false); };
    const cloudRows = pickingFallback ? fallbackCandidates(cloud, current?.key, chain) : cloud;
    const filtered = tab==='ready'?readyModels(all,props.options,{query:search,current:current?.key,recent}):tab==='hub'?(hub?.query?.toLowerCase()===search.trim().toLowerCase()?hub.models:[]):(tab==='cloud'?cloudRows:all.filter(row=>row.provider!=='openrouter')).filter(row=>`${row.displayName || row.repo} ${row.key || ''} ${modelSource(row)}`.toLowerCase().includes(search.trim().toLowerCase()));
    const loading = tab==='hub'?hubLoading:tab==='cloud'?cloudLoading:stateLoading || !!props.loading;
    const showSkeleton = loading && !filtered.length && !displayError;
    const disabledRow = row => busy || (tab === 'hub' ? hubLoading || job?.state === 'running' : (pickingFallback ? !row.enabled : !selectable(row)) || tab === 'cloud' && cloudLoading);
    const firstOption = filtered.find(row => row.key === current?.key && !disabledRow(row)) || filtered.find(row => !disabledRow(row));
    const sourceIcon = row => row.provider==='openrouter'?h('img',{src:logo(resolvedTheme?.endsWith('-dark')?'openrouter-dark':'openrouter-light'),alt:'',width:14,height:14}):h('svg',{'aria-hidden':true,width:14,height:14,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'},h('path',{d:row.provider==='colibri'?'M8 3v3m8-3v3M8 18v3m8-3v3M3 8h3m12 0h3M3 16h3m12 0h3M6 6h12v12H6zM10 10h4v4h-4z':'M3 4h18v13H3zM8 21h8m-4-4v4'}));
    return h(Popover,{open,onOpenChange:changeOpen},
      h(PopoverTrigger,{asChild:true},h('button',{id:props.triggerId,type:'button',disabled:props.disabled || !api,title:api?undefined:'Manage models in the main notch window','aria-label':props.ariaLabel || 'Model',className:`notch-model-trigger ${props.triggerClassName || ''}`},
        h('span',{'aria-live':'polite'},runtimeMessage||label),current?h('small',null,`${formatContext(current.defaultContextWindow)}${current.running?' · Loaded':''}${chain.length?` · ${chain.length} fallback${chain.length===1?'':'s'}`:''}`):null,h('span',{'aria-hidden':true},'⌄'))),
      h(PopoverContent,{side:props.side || 'top',align:props.align || 'end',collisionPadding:{top:56,right:16,bottom:16,left:16},forceDark:false,surface:'solid',className:'notch-model-picker','aria-label':'Choose a model',onInteractOutside:()=>{interactedOutside.current=true;},onCloseAutoFocus:event=>{if(!interactedOutside.current && props.onRestoreFocus){event.preventDefault();props.onRestoreFocus();}}},
        tab!=='ready'?h('div',{className:'notch-model-manager-header'},!props.manageOnly?h('button',{type:'button',className:'notch-model-link',onClick:()=>switchTab('ready')},'← Back to models'):null,h('strong',null,'Manage models')):null,
        ['ready','installed'].includes(tab)&&loaded.length?h('div',{className:'notch-loaded-models',role:'group','aria-label':'Loaded local models'},...loaded.map(row=>h('div',{key:row.key},h('span',null,h('strong',null,row.displayName),h('small',null,'Loaded')),h('button',{type:'button',title:'Eject from memory; keep downloaded files','aria-label':`Eject ${row.displayName}`,disabled:busy||props.disabled,onClick:()=>void changeRuntime(row,'eject')},h('svg',{'aria-hidden':true,width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7},h('path',{d:'m5 14 7-9 7 9H5Zm0 4h14v3H5z'})))))):null,
        runtimeMessage?h('p',{role:'status',className:'notch-model-runtime-status'},runtimeMessage):null,
        tab!=='ready'?h('div',{className:'notch-model-tabs',role:'tablist','aria-label':'Model source'},...tabs.map(([name,title],index)=>h('button',{
          key:name,id:`${id}-${name}`,type:'button',role:'tab','aria-selected':tab===name,'aria-controls':`${id}-panel`,tabIndex:tab===name?0:-1,
          onClick:()=>switchTab(name),onKeyDown:focusModelTab},
          name==='hub'?h('img',{src:logo('huggingface'),alt:'',width:18,height:18}):name==='cloud'?h('img',{src:logo(resolvedTheme?.endsWith('-dark')?'openrouter-dark':'openrouter-light'),alt:'',width:18,height:18}):null,title))):null,
        tab==='strata'?h('section',{id:`${id}-panel`,role:'tabpanel','aria-labelledby':`${id}-${tab}`,className:'notch-model-panel'},h(StrataPanel,{api,job,cached:strata,onCatalog:setStrata,onStatus:value=>setState(previous=>({...previous,...value})),onInstalled:async show=>{await reload(true);props.onOpenChange?.(true);if(show)switchTab('installed');}})):
        tab==='colibri'?h('section',{id:`${id}-panel`,role:'tabpanel','aria-labelledby':`${id}-${tab}`,className:'notch-model-panel'},h(ColibriPanel,{api,job,cached:colibri,onCatalog:setColibri,onStatus:value=>setState(previous=>({...previous,...value})),onInstalled:async show=>{await reload(true);props.onOpenChange?.(true);if(show)switchTab('installed');}})):h('section',{id:`${id}-panel`,role:tab==='ready'?undefined:'tabpanel','aria-labelledby':tab==='ready'?undefined:`${id}-${tab}`,className:'notch-model-panel'},
          tab!=='ready'?h('p',{className:'notch-model-note'},tab==='installed'?'Local models. Memory fit is an estimate.':tab==='hub'?'Download local models. Memory and coding-tool support are checked before use.':'Cloud models via OpenRouter. Connect a key to use them; provider charges apply.'):null,
          connectForm?h('form',{className:'notch-provider-key',onSubmit:event=>{event.preventDefault();const submitted=key;setKey('');void act(async()=>{await api.connect(provider,submitted);await reload(false);});}},
            h('label',{htmlFor:inputId},tab==='hub'?'Hugging Face token (optional)':'OpenRouter API key'),
            h('div',null,h('input',{id:inputId,type:'password',value:key,autoComplete:'off',spellCheck:false,placeholder:tab==='hub'?'hf_…':'sk-or-…',onChange:event=>setKey(event.target.value),disabled:busy}),
              h('button',{type:'submit',disabled:busy || !key.trim()},busy?'Connecting…':'Connect')),
            tab==='hub'?h('div',null,h('small',null,'Public downloads need no account. A token authenticates Hub metadata requests.'),h('button',{type:'button',onClick:()=>{setOptional(false);setKey('');try{localStorage.setItem('notch.models.hideHfToken','1');}catch{}}},'Not now')):null):null,
          connected && ['hub','cloud'].includes(tab)?h('div',{className:'notch-provider-status'},h('span',null,`${tab==='cloud'?'OpenRouter':'Hugging Face'} connected · ${state.persistentKeys?'encrypted on this device':'session only'}`),h('button',{type:'button',disabled:busy,onClick:()=>void act(async()=>{await api.disconnect(provider);await reload(false);})},'Disconnect')):null,
          tab==='hub' && !connected && !optional?h('button',{className:'notch-model-link',type:'button',onClick:()=>{setOptional(true);try{localStorage.removeItem('notch.models.hideHfToken');}catch{}}},'Add optional Hugging Face token'):null,
          tab==='hub' && state?.hardware?.mlxSupported?h('label',{className:'notch-model-context'},'Runtime',h('select',{'aria-label':'Local runtime',value:runner || hub?.runner || 'mlx',onChange:event=>{setRunner(event.target.value);setHub(null);setConfirm(null);},disabled:busy},h('option',{value:'mlx'},'MLX · Apple Silicon'),h('option',{value:'ollama'},'Ollama'))):null,
          h('input',{ref:searchInput,className:'notch-model-search',type:'search','aria-label':pickingFallback?'Search fallback models':tab==='ready'?'Search ready models':'Search models',maxLength:120,placeholder:tab==='hub'?'Search the Hub, e.g. Gemma or DeepSeek…':pickingFallback?'Search a fallback model…':tab==='ready'?'Search ready models…':'Search models…',value:search,onChange:event=>{setSearch(event.target.value);setConfirm(null);},onKeyDown:keyboard}),
          tab==='hub' && confirm?h('div',{ref:confirmation,tabIndex:-1,className:'notch-model-confirm',role:'group','aria-label':'Confirm model download'},
            h('strong',null,confirm.repo),h('p',null,`${formatSize(confirm.bytes)} download · ${formatSize(confirm.required)} estimated memory. License: ${confirm.license || 'see model card'}.`),
            h('p',null,`${hub.runner==='mlx'?'MLX':'Ollama'} downloads the model files without loading them. Memory and context are checked when you load it.${confirm.fits?'':' This model exceeds currently available memory; you can download it now and free memory before loading.'}`),
            h('button',{type:'button',disabled:busy || job?.state==='running',onClick:()=>void act(async()=>{const status=await api.install(confirm.repo,hub.runner);setState(previous=>({...previous,...status}));setConfirm(null);})},busy?'Preparing download…':'Download model'),h('button',{type:'button',disabled:busy,onClick:()=>setConfirm(null)},'Back to models')):null,
          job && tab==='hub'?h('div',{className:'notch-model-job',role:job.state==='failed'?'alert':'status'},
            h('div',null,h('strong',null,job.repo),h('p',null,uiMessage(job.message, 'Model status details are unavailable. Refresh to check again.')),job.state==='running'?h('progress',{'aria-label':'Model download progress',max:100,...(Number.isFinite(job.percent)?{value:job.percent}:{})}):null),
            job.state==='running'?h('button',{type:'button',disabled:busy,onClick:()=>void act(async()=>{const status=await api.cancel();setState(previous=>({...previous,...status}));})},'Cancel download'):job.state==='complete'?h('button',{type:'button',disabled:busy,onClick:()=>void act(async()=>{await reload(true);props.onOpenChange?.(true);switchTab('installed');})},'Show installed models'):null):null,
          h('div',{ref:list,role:'listbox','aria-label':pickingFallback?'Fallback models':tab==='ready'?'Ready models':`${tabs.find(([name])=>name===tab)[1]} models`,'aria-busy':loading,hidden:showSkeleton || tab==='hub' && !!confirm,className:'notch-model-list',onKeyDown:keyboard,onFocus:event=>rovingModelOption(event,list.current)},
            ...filtered.map(row=>tab==='hub'?h('button',{type:'button',key:row.repo,role:'option',tabIndex:row===firstOption?0:-1,'aria-label':`Download ${row.repo}`,title:row.fits?'Review download and runtime requirements':'Review memory requirements',className:'notch-hub-model','aria-selected':confirm?.repo===row.repo,disabled:disabledRow(row),onClick:event=>{returnFocus.current=event.currentTarget;setConfirm(row);}},
              h('span',{className:'notch-hub-model-info'},h('strong',null,row.repo),h('small',{className:'notch-model-source'},h('img',{src:logo('huggingface'),alt:'',width:14,height:14}),'Hugging Face · Local download'),h('small',null,`${formatSize(row.bytes)} download · ${formatSize(row.required)} estimated memory${row.fits?'':' · exceeds available memory'}`)),
              h('svg',{'aria-hidden':true,width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round',className:'notch-model-download-icon'},h('path',{d:'M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4'}))):
              h('button',{type:'button',key:row.key,title:row.key,role:'option',tabIndex:row===firstOption?0:-1,'aria-selected':!pickingFallback && row.key===current?.key,'aria-busy':row.key===runtimeKey,disabled:disabledRow(row),onClick:()=>select(row)},
                h('span',{className:'notch-model-title'},h('strong',null,row.displayName),row.running?h('small',null,'Loaded · click to eject'):null,!pickingFallback && row.key===current?.key?h('span',{'aria-hidden':true},'✓'):null),
                h('small',{className:'notch-model-source'},sourceIcon(row),modelSource(row)),
                h('small',null,tab==='cloud'?`${formatContext(row.defaultContextWindow)} context · ${Number.isFinite(row.pricing?.input)&&Number.isFinite(row.pricing?.output)?`$${row.pricing.input.toFixed(2)} in / $${row.pricing.output.toFixed(2)} out per 1M tokens`:'see provider pricing'}${row.enabled?'':` · ${row.description}`}`:`${formatContext(row.defaultContextWindow)} context${Number.isFinite(row.bytes)?` · ${formatSize(row.bytes)} weights`:''}${row.enabled?'':` · ${row.description}`}`)))),
          showSkeleton && !confirm?h(LoadingSkeleton,{label:'Loading models…'}):null,
          !filtered.length && !loading && !displayError && !confirm?h('p',{className:'notch-model-note'},tab==='ready'?(search?'No matching ready models.':'No models are ready. Open Manage models to download a model or connect OpenRouter.'):tab==='hub'?'No compatible weights on this page. Try another search or load more.':pickingFallback?'No other tool-capable OpenRouter models match.':'No matching models.'):null,
          loading && filtered.length?h('p',{role:'status',className:'notch-model-note'},'Updating models…'):null,
          tab==='hub' && !confirm && hub?.query?.toLowerCase()===search.trim().toLowerCase() && Number.isSafeInteger(hub.nextPage)?h('button',{type:'button',className:'notch-model-link',disabled:hubLoading || busy,onClick:()=>void loadHub(hub.nextPage)},hubLoading?'Loading…':'Load more models'):null,
          tab!=='ready' && tab!=='hub' && current && (tab==='cloud')===(current.provider==='openrouter')?h(React.Fragment,null,
            h('label',{className:'notch-model-context'},h('span',null,'Context limit',h('small',null,local?'Automatic mode checks available memory before each request.':'Applies to the next request. Earlier messages are summarized automatically when needed.')),h('select',{'aria-label':'Context limit',value:local && !current.requestedContextWindow?'auto':current.defaultContextWindow,disabled:busy || props.disabled,onChange:event=>void act(async()=>{const data=await api.context(current.key,event.target.value==='auto'?'auto':Number(event.target.value));setState(data);})},
              local?h('option',{value:'auto'},`Auto · ${formatContext(current.recommendedContextWindow || current.defaultContextWindow)}`):null,...contextChoices.map(tokens=>h('option',{key:tokens,value:tokens},formatContext(tokens))))),
            local && current.availableContextWindows.includes(262144)?h('label',{className:'notch-model-note'},h('input',{type:'checkbox',checked:extended,onChange:event=>{setExtended(event.target.checked);try{localStorage.setItem('notch.models.extendedContext',event.target.checked?'1':'0');}catch{}}}),' Show extended context (256K)'):null,
            local && current.requestedContextWindow && current.requestedContextWindow!==current.defaultContextWindow?h('p',{className:'notch-model-note'},`${formatContext(current.requestedContextWindow)} requested; reduced to ${formatContext(current.defaultContextWindow)} for current memory.`):null,
            tab==='cloud'?h('div',{className:'notch-fallback-panel'},
              h('button',{type:'button',className:'notch-model-link notch-fallback-toggle','aria-expanded':fallbacksOpen,disabled:busy || props.disabled,onClick:()=>{setFallbacksOpen(visible=>!visible);setPickingFallback(false);}}, chain.length?`Fallbacks · ${chain.length}`:'Fallbacks'),
              fallbacksOpen?h('div',{className:'notch-fallback-chain',role:'group','aria-label':'OpenRouter fallback order'},
                h('p',null,'If this model fails, notch tries these models in order. Your provider charges for the model that responds.'),
                h('ol',{className:'notch-fallback-nodes'},
                  h('li',{className:'notch-fallback-node','data-primary':true},
                    h('span',{className:'notch-fallback-rail','aria-hidden':true},h('span',{className:'notch-fallback-dot'}),h('span',{className:'notch-fallback-line'})),
                    h('div',{className:'notch-fallback-card'},h('strong',null,current.displayName),h('small',null,'Primary')),
                    h('span',{className:'notch-fallback-actions'})),
                  ...chain.map((key,index)=>{
                    const row=cloud.find(item=>item.key===key) || all.find(item=>item.key===key);
                    return h('li',{key,className:'notch-fallback-node'},
                      h('span',{className:'notch-fallback-rail','aria-hidden':true},h('span',{className:'notch-fallback-dot'}),index<chain.length-1 || chain.length<OPENROUTER_FALLBACK_LIMIT?h('span',{className:'notch-fallback-line'}):null),
                      h('div',{className:'notch-fallback-card'},h('strong',null,row?.displayName || key.replace(/^openrouter\//,'')),h('small',null,`Fallback ${index+1}`)),
                      h('span',{className:'notch-fallback-actions'},
                        h('button',{type:'button','aria-label':'Move earlier',disabled:busy || index===0,onClick:()=>void saveFallbacks(moveItem(chain,index,index-1))},'↑'),
                        h('button',{type:'button','aria-label':'Move later',disabled:busy || index===chain.length-1,onClick:()=>void saveFallbacks(moveItem(chain,index,index+1))},'↓'),
                        h('button',{type:'button','aria-label':'Remove fallback',disabled:busy,onClick:()=>void saveFallbacks(chain.filter(item=>item!==key))},'×')));
                  }),
                  chain.length<OPENROUTER_FALLBACK_LIMIT?h('li',{className:'notch-fallback-node'},
                    h('span',{className:'notch-fallback-rail','aria-hidden':true},h('span',{className:'notch-fallback-dot notch-fallback-dot-empty'})),
                    h('button',{type:'button',className:'notch-fallback-slot','aria-pressed':pickingFallback,disabled:busy,onClick:()=>setPickingFallback(value=>!value)}, pickingFallback?'Choose a model in the list':'Add fallback')):null)):null):null):null,
          h('div',{className:'notch-model-footer'},tab==='ready'?h('button',{type:'button',className:'notch-model-link',onClick:()=>switchTab('installed')},'Manage models…'):h('span',null,tab==='cloud'?`${filtered.length} models`:state?.hardware?`${formatSize(state.hardware.availableMemory)} ${state.hardware.appleSilicon?'unified memory':'RAM'} free${state.hardware.totalVram>0?` · ${formatSize(state.hardware.availableVram)} / ${formatSize(state.hardware.totalVram)} VRAM free`:''}`:''),h('button',{type:'button',disabled:busy || loading,onClick:()=>void act(async()=>{await reload(true);if(tab==='hub')await loadHub(0,true);if(tab==='cloud')await loadCloud(true);})},'Refresh')),
          displayError?h('p',{role:'alert',className:'notch-model-error'},uiMessage(displayError)):null)));
  };
}
