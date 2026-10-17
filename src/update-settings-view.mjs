export function createUpdateSettings(React) {
  const h=React.createElement;
  return function UpdateSettings(){
    const [state,setState]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
    React.useEffect(()=>{let alive=true;const refresh=()=>window.notchModels?.updates().then(value=>{if(alive)setState(value);}).catch(()=>{if(alive)setError('Update settings are unavailable.');});void refresh();const timer=setInterval(refresh,1500);return()=>{alive=false;clearInterval(timer);};},[]);
    const act=async(action,value)=>{setBusy(true);setError('');try{setState(await window.notchModels.updates(action,value));}catch{setError('The update action could not finish. Try again or visit GitHub releases.');}finally{setBusy(false);}};
    return h('section',{className:'notch-web-settings notch-update-settings','aria-labelledby':'notch-updates-title'},
      h('h3',{id:'notch-updates-title'},'Updates'),
      h('p',{className:'notch-appearance-copy'},'Check GitHub releases when notch opens. Updates download in the background and install after you quit normally. During Windows shutdown, installation waits for a later normal quit.'),
      state?h(React.Fragment,null,
        h('p',null,`Installed version: ${state.currentVersion}`),
        h('label',{className:'notch-setting-row'},h('span',null,h('strong',null,'Automatic updates'),h('small',null,'Check and download new stable releases on startup.')),
          h('input',{type:'checkbox','aria-label':'Automatic updates',checked:state.automatic,disabled:busy||!state.canInstall,onChange:event=>void act('automatic',event.target.checked)})),
        h('p',{role:'status'},state.message),
        state.phase==='downloading'?h('progress',{value:state.progress||0,max:100,'aria-label':'Update download progress'}):null,
        h('div',{className:'notch-update-actions'},h('button',{type:'button',disabled:busy||!state.supported||['checking','downloading'].includes(state.phase),onClick:()=>void act('check')},'Check for updates'),
          state.phase==='available'?h('button',{type:'button',disabled:busy||!state.canInstall,onClick:()=>void act('download')},'Download update'):null,
          state.phase==='ready'?h('button',{type:'button',disabled:busy||!state.canInstall,onClick:()=>void act('quit')},'Quit and install'):null)):
        h('p',{role:'status'},'Loading update settings…'),
      h('a',{href:'https://github.com/simpleending/notch-desktop/releases/latest',target:'_blank',rel:'noopener noreferrer'},'View releases on GitHub'),
      error?h('p',{role:'alert'},error):null);
  };
}
