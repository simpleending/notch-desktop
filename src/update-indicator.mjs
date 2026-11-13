import {uiMessage} from './ui-messages.mjs';
export function createUpdateIndicator(React) {
  const h=React.createElement;
  return function UpdateIndicator(){
    const [state,setState]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
    const acting=React.useRef(false),revision=React.useRef(0);
    React.useEffect(()=>{
      let alive=true;
      const refresh=async()=>{if(acting.current)return;const request=++revision.current;try{const value=await window.notchModels.updates();if(alive&&request===revision.current)setState(value);}catch{/* Keep the last valid status during transient IPC failures. */}};
      void refresh();const timer=setInterval(refresh,1000);
      return()=>{alive=false;clearInterval(timer);};
    },[]);
    if(!state?.supported||!state.canInstall||!['downloading','ready','available','error'].includes(state.phase))return null;
    const downloading=state.phase==='downloading',ready=state.phase==='ready';
    const label=ready?'Update':state.phase==='available'?'Download update':'Retry update';
    const action=async()=>{if(acting.current)return;acting.current=true;revision.current++;setBusy(true);setError('');try{setState(await window.notchModels.updates(ready?'quit':state.phase==='available'?'download':'check'));}catch{setError('Update unavailable. Try again.');}finally{acting.current=false;setBusy(false);}};
    return h('div',{className:'notch-update-indicator'},downloading?
      h('span',{role:'status',className:'notch-update-download',title:`Downloading update ${state.latestVersion||''} — ${state.progress||0}%`,'aria-label':`Downloading update: ${state.progress||0}%`},
        h('svg',{viewBox:'0 0 20 20',width:16,height:16,fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true},h('path',{d:'M10 3v9m-4-4 4 4 4-4M4 14v3h12v-3'})),h('span',null,`${state.progress||0}%`)):
      h('button',{type:'button',disabled:busy,onClick:action,title:ready?'Install update and restart Notch':label,'aria-label':ready?'Update and restart Notch':label},busy?'Please wait…':label),
      error?h('span',{role:'alert'},uiMessage(error)):null);
  };
}
