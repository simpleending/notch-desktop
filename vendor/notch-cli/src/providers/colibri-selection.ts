export type ColibriBackend = 'cpu' | 'vulkan' | 'cuda' | 'metal';
export interface ColibriCandidate {
  backend: ColibriBackend;
  env: Record<string, string>;
  plan: any;
  contextWindow: number;
}
export interface ColibriMeasurement { backend: ColibriBackend; millisecondsPerToken: number }

export function colibriLaunchPid(report: string): number {
  const state = JSON.parse(report);
  if (!['loading', 'ready'].includes(state?.state) || !Number.isSafeInteger(state.pid) || state.pid <= 0)
    throw new Error('The Colibri engine stopped during initialization. Trying another backend.');
  return state.pid;
}

/** A driver may silently fall back to CPU. Only label acceleration after the engine confirms it. */
export function colibriBackendReady(backend: ColibriBackend, log: string): boolean {
  if (backend === 'cpu') return true;
  if (backend === 'vulkan') return /\[VK\] (?:ready:|.*device ready, dense matrices)/i.test(log);
  if (backend === 'cuda') return /\[CUDA\] device \d+: .*(?:VRAM|sm_)/i.test(log);
  return /\[(?:K3-)?METAL\] (?:ready|mode: .*GPU|init OK)/i.test(log);
}

/** Keep useful coding space; automatic context targets 16K without forcing it on smaller machines. */
export function colibriContexts(native: number, requested?: number, minimum = 8192): number[] {
  if (!Number.isSafeInteger(native) || native < 2048) throw new Error('This model has no verified native context limit.');
  if (requested !== undefined) {
    if (!Number.isSafeInteger(requested) || requested < 2048 || requested > Math.min(native, 262144)) throw new Error('Choose a Colibri context within the verified native model limit (2K–256K).');
    return [requested];
  }
  return [262144, 131072, 65536, 32768, 16384, 12288, 8192].filter(value => value <= native && value <= Math.max(16384, minimum) && value >= minimum);
}

export function colibriRank(candidates: ColibriCandidate[], measurements: ColibriMeasurement[], recommended: ColibriBackend = 'cpu') {
  const score = (backend: ColibriBackend) => measurements.find(row => row.backend === backend && Number.isFinite(row.millisecondsPerToken) && row.millisecondsPerToken > 0)?.millisecondsPerToken ?? Infinity;
  return [...candidates].sort((a, b) => {
    const difference = score(a.backend) - score(b.backend);
    return Number.isNaN(difference) || difference === 0 ? Number(b.backend === recommended) - Number(a.backend === recommended) : difference;
  });
}

/** Probe the shipped engine, not vendor names or the upstream integrated-GPU allowlist. No model is loaded. */
export const COLIBRI_PLANNER = String.raw`
import sys,json,os,platform
sys.path.insert(0,sys.argv[1])
import setup_hw,setup_flow
from family_registry import resolve_model
from resource_plan import build_plan,discover_gpus
model=sys.argv[2]; contexts=json.loads(sys.argv[3])
family=resolve_model(model).descriptor if model else None
engine=setup_flow.engine_path(sys.argv[1],family) if family else None
hw=setup_hw.detect(model or None)
cpu_env={'COLI_VULKAN':'0','COLI_CUDA':'0','COLI_METAL':'0','K3_METAL':'0','K3_CUDA':'0'}
cpu_ok=platform.machine().lower() in ('arm64','aarch64') or 'avx2' in hw['cpu'].get('features',[])
options=[{'backend':'cpu','label':'CPU','available':cpu_ok,'reason':'Supported CPU; memory is checked before loading.' if cpu_ok else 'Colibri x64 requires an AVX2-capable CPU.'}]
backends=[('cpu',cpu_env)] if cpu_ok else []
vk=(hw.get('gpu') or {}).get('vulkan')
vk_ok=bool(cpu_ok and vk and family and setup_flow.prebuilt_runs(family,'vulkan',sys.argv[1]))
options.append({'backend':'vulkan','label':'Vulkan · AMD / Intel / NVIDIA','available':vk_ok,'reason':
    ('A compatible Vulkan GPU and model engine were detected. Acceleration is confirmed when loading.' if vk_ok else
     'The CPU does not meet Colibri requirements.' if not cpu_ok else
     'No compatible Vulkan 1.2+ GPU driver answered. CPU inference remains available.' if not vk else
     'Choose a Colibri model to check its GPU engine.' if not family else
     'This model engine has no installed Vulkan build or matching shaders.')})
if vk_ok:
    backends.append(('vulkan',dict(cpu_env,**setup_flow.run_environment('vulkan',engine,family,hw))))
cards=(hw.get('gpu') or {}).get('nvidia') or []
floor=setup_flow.WINDOWS_CUDA_FLOOR if sys.platform=='win32' else 0
cuda_cards=[card for card in cards if (setup_hw.compute_cap_sm(card.get('compute_cap')) or 0)>=floor]
cuda_family=bool(family and family.id in (setup_flow.WINDOWS_CUDA_ENGINES if sys.platform=='win32' else setup_flow.CUDA_ENGINES))
cuda_ok=bool(cpu_ok and cuda_cards and cuda_family and setup_flow.prebuilt_runs(family,'cuda',sys.argv[1]))
options.append({'backend':'cuda','label':'CUDA · NVIDIA','available':cuda_ok,'reason':
    ('Compatible NVIDIA GPU and CUDA model engine detected.' if cuda_ok else
     'The CPU does not meet Colibri requirements.' if not cpu_ok else
     'No NVIDIA CUDA GPU was detected. AMD GPUs use Vulkan.' if not cards else
     'The official Windows CUDA package requires compute capability 8.0+ (RTX 30 series or newer); use Vulkan on older cards.' if not cuda_cards else
     'Choose a Colibri model to check CUDA support.' if not family else
     'Colibri 2.0.0 has no supported CUDA engine for this model on this platform.' if not cuda_family else
     'The CUDA engine package is not installed. Update engine support; Vulkan or CPU remains available.')})
if cuda_ok:
    indices=','.join(str(card['index']) for card in cuda_cards)
    backends.append(('cuda',dict(cpu_env,COLI_CUDA='1',K3_CUDA='1',COLI_GPUS=indices)))
metal_ok=bool(cpu_ok and sys.platform=='darwin' and family and family.id in ('glm','inkling','kimi') and setup_flow.binary_links(engine,(b'Metal.framework',)))
options.append({'backend':'metal','label':'Metal · Apple','available':metal_ok,'reason':
    ('The selected model has an Apple Metal engine.' if metal_ok else
     'Metal is available only on Apple Silicon.' if sys.platform!='darwin' else
     'Choose a Colibri model to check Metal support.' if not family else
     'This model has no supported Metal engine in the installed release.')})
if metal_ok:
    backends.append(('metal',dict(cpu_env,COLI_METAL='1',K3_METAL='1')))
recommended='cpu'
if family:
    decision=setup_flow.choose_backend(hw,family,setup_flow.toolchain())
    recommended=decision['backend'] if any(b==decision['backend'] for b,e in backends) else 'cpu'
gpu_identity=[{key:d.get(key) for key in ('name','type','vendor_id','device_id','api_version','device_local_bytes')} for d in hw['vulkan']['devices']]
identity={'cpu':hw['cpu'],'os':platform.platform(),'memory':hw['memory']['total'],'vulkan':gpu_identity,'nvidia':cards,'engine':(os.stat(engine).st_size,os.stat(engine).st_mtime_ns) if engine else None,'model':model,'config':resolve_model(model).config if family else None,'backends':[b for b,e in backends]}
identity['weights']=sorted((entry.name,entry.stat().st_size,entry.stat().st_mtime_ns) for entry in os.scandir(model) if entry.is_file() and entry.name.endswith(('.safetensors','.qpack'))) if model else []
# Free memory changes between launches; it must never be part of a cached speed result.
identity['nvidia']=[{k:c.get(k) for k in ('name','compute_cap','driver','total_bytes')} for c in cards]
if sys.platform=='win32':
    identity['drivers']=setup_hw._run(['powershell.exe','-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress'],timeout=10)
base=dict(os.environ); plans=[]
for context in contexts:
    for backend,env in backends:
        os.environ.clear();os.environ.update(base);os.environ.update(env)
        try:
            gpus=[gpu for gpu in discover_gpus() if str(gpu['index']) in env.get('COLI_GPUS','').split(',')] if backend=='cuda' else []
            plan=build_plan(model,context=context,gpus=gpus,env=dict(os.environ),physical_cpus=hw['cpu'].get('physical_cores'))
            # Tensor names are unnecessary to admit a launch and can exceed the process-output limit.
            plan.get('model',{}).pop('dense_tensors',None)
            plans.append({'backend':backend,'env':env,'plan':plan,'contextWindow':context})
        except (OSError,ValueError,KeyError) as error:
            plans.append({'backend':backend,'env':env,'plan':{'error':str(error)},'contextWindow':context})
os.environ.clear();os.environ.update(base)
detected_gpu=vk.get('name') if vk else cards[0].get('name') if cards else next((d.get('name') for d in hw['vulkan']['devices'] if d.get('type') in ('discrete','integrated')),None)
print(json.dumps({'identity':identity,'gpu':detected_gpu,'plans':plans,'backends':options,'recommendedBackend':recommended},default=str))
`;
