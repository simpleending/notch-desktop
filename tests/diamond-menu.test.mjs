import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diamondLayout,createDiamondMenu} from '../src/diamond-menu.mjs';
import {patchSecondaryArtwork} from '../src/workbench-patch.mjs';

test('diamond menu stays within the workbench at every viewport edge',()=>{
  for(const viewport of [{width:900,height:600},{width:360,height:400}])for(const x of [0,viewport.width/2,viewport.width])for(const y of [0,viewport.height/2,viewport.height]){
    const layout=diamondLayout({x,y},viewport),left=x+layout.x,top=y+layout.y;
    assert(left>=12&&top>=56);assert(left+layout.size<=viewport.width-12);assert(top+layout.size<=viewport.height-12);
  }
});

test('diamond actions use distinct artwork while preserving labels, disabled state and selection',()=>{
  const React={useState:value=>[typeof value==='function'?value():value,()=>{}],useEffect:()=>{},useRef:value=>({current:value}),createElement:(type,props,...children)=>({type,props:props||{},children})};
  const previous=globalThis.window;globalThis.window={innerWidth:900,innerHeight:600};
  try{
    const Menu=createDiamondMenu(React,{Root:'root',Trigger:'trigger',Portal:'portal',Content:'content',Item:'item'});
    let selected;const items=['code','browser','review','terminal','sidechat'].map((id,index)=>({id:'workspace-'+id,label:'Action '+id,disabled:index===2,icon:'old-icon'}));
    const tree=Menu({items,open:true,onSelect:item=>selected=item});
    const flatten=node=>[node,...node.children.flat(Infinity).filter(child=>child&&typeof child==='object').flatMap(flatten)];
    const nodes=flatten(tree),actions=nodes.filter(node=>node.type==='item');
    assert.equal(actions.length,5);assert.equal(actions[2].props.disabled,true);
    assert.deepEqual(actions[2].props.style,{left:'50%',top:'50%'});
    assert.deepEqual(actions[3].props.style,{left:'50%',top:'75%'});
    const withoutReview=flatten(Menu({items:items.filter(item=>item.id!=='workspace-review'),open:true})).filter(node=>node.type==='item');
    assert.deepEqual(withoutReview.find(node=>node.props['aria-label']==='Action terminal').props.style,actions[3].props.style);
    assert.deepEqual(actions.map(node=>node.props['aria-label']),items.map(item=>item.label));
    actions[3].props.onSelect();assert.equal(selected,items[3]);
    assert.equal(new Set(actions.map(node=>node.children[0].children[0].props.d)).size,5);
    assert(!JSON.stringify(tree).includes('old-icon'));
  }finally{globalThis.window=previous;}
});

test('workbench replaces the inherited ring once and retains the menu contract',()=>{
  const source='function RadialMenu(props){return oldCircle(props)}';
  const patched=patchSecondaryArtwork(source);assert(!patched.includes('oldCircle'));
  assert(patched.includes('createDiamondMenu'));assert.equal(patchSecondaryArtwork(patched),patched);
});
