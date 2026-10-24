const glyphs={
  'workspace-code':['M8 5 2 12l6 7M16 5l6 7-6 7M14 3l-4 18','Code'],
  'workspace-browser':['M3 5h18v14H3zM3 9h18M6 7h1m2 0h1M8 15l3-3 3 3 3-3','Browser'],
  'workspace-review':['M5 3h9l5 5v13H5zM14 3v5h5M8 13h5m-2-2v4M8 18h8','Review'],
  'workspace-terminal':['M3 4h18v16H3zM7 9l3 3-3 3m6 0h4','Terminal'],
  'workspace-sidechat':['M3 4h13v10H8l-5 4V4Zm7 13h6l5 4V10h-2','Side chat'],
};

export function diamondLayout(point,viewport,size=288){
  const extent=Math.max(120,Math.min(size,viewport.width-24,viewport.height-80));
  const half=extent/2,clamp=(value,min,max)=>Math.max(min,Math.min(value,max));
  return {size:extent,x:clamp(point.x,half+12,viewport.width-half-12)-point.x-half,
    y:clamp(point.y,half+56,viewport.height-half-12)-point.y-half};
}

/** Radix owns dismissal, focus, typeahead and selection; Notch owns the layout and artwork. */
export function createDiamondMenu(React,{Root,Trigger,Portal,Content,Item}){
  const h=React.createElement;
  return function DiamondMenu({children,items,open,defaultOpen=false,onOpenChange,onSelect,triggerClassName='',contentClassName=''}){
    const [localOpen,setOpen]=React.useState(defaultOpen),[point,setPoint]=React.useState({x:160,y:200});
    const [viewport,setViewport]=React.useState(()=>({width:window.innerWidth,height:window.innerHeight}));
    const exempt=React.useRef(false),opening=React.useRef(null),shown=open??localOpen;
    const change=value=>{if(value&&exempt.current)return;setOpen(value);onOpenChange?.(value);if(!value)opening.current=null;};
    const locate=event=>{setPoint({x:event.clientX,y:event.clientY});setViewport({width:window.innerWidth,height:window.innerHeight});};
    React.useEffect(()=>{if(!shown)return;const resize=()=>setViewport({width:window.innerWidth,height:window.innerHeight});window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[shown]);
    const layout=diamondLayout(point,viewport),positions={'workspace-code':[50,25],'workspace-browser':[75,50],'workspace-terminal':[50,75],'workspace-sidechat':[25,50],'workspace-review':[50,50]};
    return h(Root,{open:shown,onOpenChange:change},
      h(Trigger,{asChild:true},h('div',{className:triggerClassName,
        onContextMenuCapture:event=>{
          if(event.target.closest?.('[data-radial-menu-context-menu-exempt]')){exempt.current=true;queueMicrotask(()=>exempt.current=false);return;}
          locate(event);opening.current=event.button===2?{x:event.clientX,y:event.clientY}:null;
        },
        onPointerDownCapture:event=>{if(event.pointerType==='touch'||event.pointerType==='pen')locate(event);},
      },children)),
      shown&&items.length?h(Portal,null,h(Content,{asChild:true,avoidCollisions:false},h('div',{
        className:`notch-diamond-menu ${contentClassName}`,'aria-label':'Task actions',
        style:{width:layout.size,height:layout.size,marginLeft:layout.x,marginTop:layout.y},
        onPointerMoveCapture:event=>{const start=opening.current;if(start&&(event.clientX-start.x)**2+(event.clientY-start.y)**2>=16)opening.current=null;},
        onPointerUpCapture:event=>{if(event.button===2&&opening.current){opening.current=null;event.preventDefault();event.stopPropagation();}},
      },h('svg',{className:'notch-diamond-plate',viewBox:'0 0 288 288','aria-hidden':true},h('path',{d:'M144 3 285 144 144 285 3 144Z'})),
      ...items.map((item,index)=>{
        const [x,y]=positions[item.id]||[50,50],glyph=glyphs[item.id];
        return h(Item,{key:item.id,disabled:item.disabled,'aria-label':item.label,title:item.label,
          className:'notch-diamond-action','data-danger':item.tone==='danger'||undefined,style:{left:`${x}%`,top:`${y}%`},
          onSelect:()=>onSelect?.(item)},
          h('svg',{width:21,height:21,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:glyph?.[0]||'M12 3 21 12 12 21 3 12Z'})),
          h('span',null,glyph?.[1]||item.label));
      })))):null);
  };
}
