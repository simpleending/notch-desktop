const logo = name => new URL(`./providers/${name}.svg`,import.meta.url).href;
const formatContext = tokens => `${Math.round(tokens/1024)}K`;
const formatSize = bytes => `${(bytes/2**30).toFixed(1)} GiB`;

/** Keep the workbench's popover focus/dismissal behavior and composer selection callback. */
export function createModelMenu(React, { Popover, PopoverTrigger, PopoverContent }, useTheme) {
  const h = React.createElement;
  return function ModelMenu(props) {
    const api = window.notchModels, { resolvedTheme } = useTheme();
    const [innerOpen,setInnerOpen] = React.useState(false), open = !!api && (props.open ?? innerOpen);
    const [tab,setTab] = React.useState('installed'), [state,setState] = React.useState(null), [hub,setHub] = React.useState(null);
    const [search,setSearch] = React.useState(''), [key,setKey] = React.useState(''), [busy,setBusy] = React.useState(false);
    const [error,setError] = React.useState(''), [confirm,setConfirm] = React.useState(null), [optional,setOptional] = React.useState(()=>{try{return localStorage.getItem('notch.models.hideHfToken')!=='1';}catch{return true;}});
    const [hubLoading,setHubLoading] = React.useState(false);
    const [cloud,setCloud]=React.useState([]),[cloudLoading,setCloudLoading]=React.useState(false),cloudRequest=React.useRef(0);
    const [extended,setExtended] = React.useState(()=>{try{return localStorage.getItem('notch.models.extendedContext')==='1';}catch{return false;}});
    const [runner,setRunner] = React.useState(''), list = React.useRef(null), request = React.useRef(0), hubRequest=React.useRef(0), interactedOutside = React.useRef(false), id = React.useId();
    const changeOpen = value => { setInnerOpen(value); props.onOpenChange?.(value); if (!value) { setKey(''); setConfirm(null); request.current++; } };
    const act = async fn => { setBusy(true); setError(''); try { await fn(); } catch (error) { setError(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'')); } finally { setBusy(false); } };
    const reload = async refresh => { const data = await api.state(refresh); setState(data); if(data.keyLoadError)setError(data.keyLoadError); return data; };
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
      setError('');
      api.state().then(data=>{if(request.current===current)setState(data);}).catch(error=>{if(request.current===current)setError(error.message);});
      return () => { request.current++; };
    },[open]);
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
    const all = state?.models || [], current = all.find(row=>row.key===props.value) || ((!props.value || props.value==='auto') ? all.find(row=>row.key===state?.defaultModel) : undefined);
    const native = props.options?.find(row=>row.value===props.value);
    const local = current && current.provider!=='openrouter';
    const contextChoices = current?.availableContextWindows.filter(tokens=>!local || tokens<=131072 || extended || current.requestedContextWindow===tokens) || [];
    const label = current?.displayName || native?.label || (props.loading?'Loading models…':props.fallbackLabel || 'Choose model');
    const provider = tab==='cloud'?'openrouter':'huggingface', connected = state?.[provider];
    const inputId = `${id}-key`;
    const connectForm = (tab==='cloud' && !connected) || (tab==='hub' && !connected && optional);
    const select = row => { if(!row.enabled || busy)return; props.onSelect(row.key); changeOpen(false); };
    const keyboard = event => {
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      const rows = [...list.current.querySelectorAll('[role=option]:not(:disabled)')]; if(!rows.length)return;
      event.preventDefault(); const index = rows.indexOf(document.activeElement);
      const next = event.key==='Home'?0:event.key==='End'?rows.length-1:event.key==='ArrowDown'?(index+1)%rows.length:(index<=0?rows.length:index)-1;
      rows[next].focus();
    };
    const tabs = [['installed','Installed'],['hub','Hugging Face'],['cloud','OpenRouter']];
    const switchTab = name => { setTab(name);setSearch('');setKey('');setConfirm(null);setError(''); };
    const filtered = tab==='hub'?(hub?.query?.toLowerCase()===search.trim().toLowerCase()?hub.models:[]):(tab==='cloud'?cloud:all.filter(row=>row.provider!=='openrouter')).filter(row=>`${row.displayName || row.repo} ${row.key || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
    return h(Popover,{open,onOpenChange:changeOpen},
      h(PopoverTrigger,{asChild:true},h('button',{id:props.triggerId,type:'button',disabled:props.disabled || !api,title:api?undefined:'Manage models in the main notch window','aria-label':props.ariaLabel || 'Model',className:`notch-model-trigger ${props.triggerClassName || ''}`},
        h('span',null,label),current?h('small',null,formatContext(current.defaultContextWindow)):null,h('span',{'aria-hidden':true},'⌄'))),
      h(PopoverContent,{side:props.side || 'top',align:props.align || 'end',forceDark:false,surface:'solid',className:'notch-model-picker','aria-label':'Choose a model',onInteractOutside:()=>{interactedOutside.current=true;},onCloseAutoFocus:event=>{if(!interactedOutside.current && props.onRestoreFocus){event.preventDefault();props.onRestoreFocus();}}},
        h('div',{className:'notch-model-tabs',role:'tablist','aria-label':'Model source'},...tabs.map(([name,title],index)=>h('button',{
          key:name,id:`${id}-${name}`,type:'button',role:'tab','aria-selected':tab===name,'aria-controls':`${id}-panel`,tabIndex:tab===name?0:-1,
          onClick:()=>switchTab(name),onKeyDown:event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=tabs[(index+(event.key==='ArrowRight'?1:2))%3][0];switchTab(next);document.getElementById(`${id}-${next}`)?.focus();}},
          name==='hub'?h('img',{src:logo('huggingface'),alt:'',width:18,height:18}):name==='cloud'?h('img',{src:logo(resolvedTheme.endsWith('-dark')?'openrouter-dark':'openrouter-light'),alt:'',width:18,height:18}):null,title))),
        h('section',{id:`${id}-panel`,role:'tabpanel','aria-labelledby':`${id}-${tab}`,className:'notch-model-panel'},
          h('p',{className:'notch-model-note'},tab==='installed'?'Runs on this computer. Memory fit is an estimate.':tab==='hub'?'Browse and search Hugging Face, newest first. Ollama uses Q4_K_M GGUF; Apple Silicon can use MLX conversions. Tool support is checked during installation.':'Browse OpenRouter chat and coding models, newest first. Connect a key to use coding tools. Provider usage may incur charges.'),
          connectForm?h('form',{className:'notch-provider-key',onSubmit:event=>{event.preventDefault();const submitted=key;setKey('');void act(async()=>{await api.connect(provider,submitted);await reload(false);});}},
            h('label',{htmlFor:inputId},tab==='hub'?'Hugging Face token (optional)':'OpenRouter API key'),
            h('div',null,h('input',{id:inputId,type:'password',value:key,autoComplete:'off',spellCheck:false,placeholder:tab==='hub'?'hf_…':'sk-or-…',onChange:event=>setKey(event.target.value),disabled:busy}),
              h('button',{type:'submit',disabled:busy || !key.trim()},busy?'Connecting…':'Connect')),
            tab==='hub'?h('div',null,h('small',null,'Public downloads need no account. A token authenticates Hub metadata requests.'),h('button',{type:'button',onClick:()=>{setOptional(false);setKey('');try{localStorage.setItem('notch.models.hideHfToken','1');}catch{}}},'Not now')):null):null,
          connected?h('div',{className:'notch-provider-status'},h('span',null,`${tab==='cloud'?'OpenRouter':'Hugging Face'} connected · ${state.persistentKeys?'encrypted on this device':'session only'}`),h('button',{type:'button',disabled:busy,onClick:()=>void act(async()=>{await api.disconnect(provider);await reload(false);})},'Disconnect')):null,
          tab==='hub' && !connected && !optional?h('button',{className:'notch-model-link',type:'button',onClick:()=>{setOptional(true);try{localStorage.removeItem('notch.models.hideHfToken');}catch{}}},'Add optional Hugging Face token'):null,
          tab==='hub' && state?.hardware?.mlxSupported?h('label',{className:'notch-model-context'},'Runtime',h('select',{'aria-label':'Local runtime',value:runner || hub?.runner || 'mlx',onChange:event=>{setRunner(event.target.value);setHub(null);setConfirm(null);},disabled:busy},h('option',{value:'mlx'},'MLX · Apple Silicon'),h('option',{value:'ollama'},'Ollama'))):null,
          h('input',{className:'notch-model-search',type:'search','aria-label':'Search models',maxLength:120,placeholder:tab==='hub'?'Search the Hub, e.g. Gemma or DeepSeek…':'Search models…',value:search,onChange:event=>{setSearch(event.target.value);setConfirm(null);},onKeyDown:keyboard}),
          h('div',{ref:list,role:'listbox','aria-label':`${tabs.find(([name])=>name===tab)[1]} models`,'aria-busy':tab==='hub'?hubLoading:tab==='cloud'?cloudLoading:false,className:'notch-model-list',onKeyDown:keyboard},
            ...filtered.map(row=>tab==='hub'?h('button',{type:'button',key:row.repo,role:'option','aria-selected':confirm?.repo===row.repo,disabled:!row.fits || busy || hubLoading || state?.job?.state==='running',onClick:()=>setConfirm(row)},
              h('strong',null,row.repo),h('small',null,`${formatSize(row.bytes)} download · ${formatSize(row.required)} estimated RAM${row.fits?'':' · exceeds available memory'}`)):
              h('button',{type:'button',key:row.key,title:row.key,role:'option','aria-selected':row.key===current?.key,disabled:!row.enabled || busy || (tab==='cloud'&&cloudLoading),onClick:()=>select(row)},
                h('strong',null,row.displayName),h('small',null,tab==='cloud'?`${formatContext(row.defaultContextWindow)} context · ${Number.isFinite(row.pricing?.input)&&Number.isFinite(row.pricing?.output)?`$${row.pricing.input.toFixed(2)} in / $${row.pricing.output.toFixed(2)} out per 1M tokens`:'see provider pricing'}${row.enabled?'':` · ${row.description}`}`:`${formatSize(row.bytes)} weights · ${formatContext(row.defaultContextWindow)} context · ${row.enabled?'local':row.description}`))),
            !filtered.length?h('p',{className:'notch-model-note'},busy || hubLoading || cloudLoading || !state?'Loading models…':tab==='hub'?'No compatible weights on this page. Try another search or load more.':'No matching models.'):null),
          tab==='hub' && hub?.query?.toLowerCase()===search.trim().toLowerCase() && Number.isSafeInteger(hub.nextPage)?h('button',{type:'button',className:'notch-model-link',disabled:hubLoading || busy,onClick:()=>void loadHub(hub.nextPage)},hubLoading?'Loading…':'Load more models'):null,
          confirm?h('div',{className:'notch-model-confirm'},h('p',null,`Download ${confirm.repo} (${formatSize(confirm.bytes)})? Model license: ${confirm.license || 'see model card'}.`),
            h('button',{type:'button',disabled:busy,onClick:()=>void act(async()=>{const status=await api.install(confirm.repo,hub.runner);setState(previous=>({...previous,...status}));setConfirm(null);})},'Download model'),h('button',{type:'button',onClick:()=>setConfirm(null)},'Cancel')):null,
          state?.job && tab==='hub'?h('div',{className:'notch-model-job',role:'status'},h('span',null,state.job.message),state.job.state==='running'?h('button',{type:'button',onClick:()=>void act(async()=>{const status=await api.cancel();setState(previous=>({...previous,...status}));})},'Cancel download'):null):null,
          tab!=='hub' && current && (tab==='cloud')===(current.provider==='openrouter')?h(React.Fragment,null,
            h('label',{className:'notch-model-context'},h('span',null,'Context limit',h('small',null,local?'Auto rechecks memory before each turn.':'Applies to the next request. History compacts automatically.')),h('select',{'aria-label':'Context limit',value:local && !current.requestedContextWindow?'auto':current.defaultContextWindow,disabled:busy || props.disabled,onChange:event=>void act(async()=>{const data=await api.context(current.key,event.target.value==='auto'?'auto':Number(event.target.value));setState(data);})},
              local?h('option',{value:'auto'},`Auto · ${formatContext(current.recommendedContextWindow || current.defaultContextWindow)}`):null,...contextChoices.map(tokens=>h('option',{key:tokens,value:tokens},formatContext(tokens))))),
            local && current.availableContextWindows.includes(262144)?h('label',{className:'notch-model-note'},h('input',{type:'checkbox',checked:extended,onChange:event=>{setExtended(event.target.checked);try{localStorage.setItem('notch.models.extendedContext',event.target.checked?'1':'0');}catch{}}}),' Show extended context (256K)'):null,
            local && current.requestedContextWindow && current.requestedContextWindow!==current.defaultContextWindow?h('p',{className:'notch-model-note'},`${formatContext(current.requestedContextWindow)} requested; reduced to ${formatContext(current.defaultContextWindow)} for current memory.`):null):null,
          h('div',{className:'notch-model-footer'},h('span',null,tab==='cloud'?`${filtered.length} models`:state?.hardware?`${formatSize(state.hardware.availableMemory)} ${state.hardware.appleSilicon?'unified memory':'RAM'} free${state.hardware.totalVram>0?` · ${formatSize(state.hardware.availableVram)} / ${formatSize(state.hardware.totalVram)} VRAM free`:''}`:''),h('button',{type:'button',disabled:busy || hubLoading || cloudLoading,onClick:()=>void act(async()=>{await reload(true);if(tab==='hub')await loadHub(0,true);if(tab==='cloud')await loadCloud(true);})},'Refresh')),
          error?h('p',{role:'alert',className:'notch-model-error'},error):null)));
  };
}
