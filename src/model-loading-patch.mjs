import { patchFunction } from './bundle-patch.mjs';

function replace(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Composer model loading anchor changed.');
  return source.replace(before, after);
}

export function patchModelLoading(source) {
  if (source.includes('/* notch model loading */') || !source.includes('function useChatModelSelector(')) return source;
  // A cached unavailable selection must enter loading during background revalidation too.
  if (source.includes('preserveReadyState:s1.get().models.length>0')) source = replace(source,
    'preserveReadyState:s1.get().models.length>0',
    'preserveReadyState:s1.get().models.some(model=>model.key===s1.get().selectedModel&&model.enabled)');
  source = patchFunction(source, 'useChatModelSelector', body => {
    body = replace(body, 'S1=m1&&p1.isLoading&&!M1',
      'notchRefresh=reactExports.useCallback(()=>r1.refresh(a1,u1,l1),[r1,a1,u1,l1]),notchModelBusy=useModelActivity(reactExports,l1==="local"?notchRefresh:null),S1=m1&&(p1.isLoading&&(!M1||!M1.enabled)||notchModelBusy&&l1==="local"&&!w1?.startsWith("openrouter/"))');
    body = replace(body, 'A1=m1&&!p1.isLoading&&', 'A1=m1&&!S1&&!p1.isLoading&&');
    body = replace(body, 'j1=!!(m1&&w1&&', 'j1=!!(m1&&!S1&&w1&&');
    return replace(body, 'modelError:j1?', 'modelError:S1?null:j1?');
  });
  source = patchFunction(source, 'ChatComposer', body => {
    body = replace(body, '_6=L2?jsxRuntimeExports.jsx(SuggestionBanner,', '_6=o2?reactExports.createElement(NotchModelLoadingDots):L2?jsxRuntimeExports.jsx(SuggestionBanner,');
    // Adding/removing a status must not remount the picker in the middle of a load.
    return replace(body, 'G0=!!(l0||_6)', 'G0=!0');
  });
  return '/* notch model loading */\nimport {useModelActivity,createModelLoadingDots} from "./model-activity.mjs";\n' + source + '\nconst NotchModelLoadingDots=createModelLoadingDots(reactExports);\n';
}
