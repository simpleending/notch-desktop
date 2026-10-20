import { patchFunction } from './bundle-patch.mjs';

export function patchGitPublishDialog(source) {
  if (!source.includes('function GitPublishDialog(')) return source;
  return patchFunction(source, 'GitPublishDialog', body => {
    if (body.includes('data-workspace-git-error')) return body;
    const replace = (before, after) => {
      if (body.split(before).length !== 2) throw new Error(`Git publish dialog anchor changed: ${before}`);
      body = body.replace(before, after);
    };
    replace('d1=e1?.status??null,', 'd1=e1?.status??null,[notchGitError,setNotchGitError]=reactExports.useState(null),');
    replace('n1&&(h1(""),', 'n1&&(setNotchGitError(null),h1(""),');
    replace('const V1=async Q1=>{let $1=', 'const V1=async Q1=>{setNotchGitError(null);let $1=');
    replace('catch(K1){toast.error(', 'catch(K1){setNotchGitError(workspaceGitErrorMessage(K1,c1));toast.error(');
    replace('U1=async()=>{y1(', 'U1=async()=>{setNotchGitError(null);y1(');
    replace('catch(Q1){toast.error(', 'catch(Q1){setNotchGitError(workspaceGitErrorMessage(Q1,c1));toast.error(');
    replace('J1.pushError?toast.warning', 'if(J1.pushError){setNotchGitError(c1("workspace.review.commitSucceededPushFailed")+" "+workspaceGitErrorText(J1.pushError,c1));toast.warning');
    replace('workspaceGitErrorText(J1.pushError,c1)}):toast.success', 'workspaceGitErrorText(J1.pushError,c1)})}else{toast.success');
    replace('J1.commit.summary}),s1(!1)}catch', 'J1.commit.summary});s1(!1)}}catch');
    replace('x1==="generating"?jsxRuntimeExports.jsxs', 'notchGitError?jsxRuntimeExports.jsx("div",{role:"alert",className:"text-sm text-error","data-workspace-git-error":!0,children:notchGitError}):null,x1==="generating"?jsxRuntimeExports.jsxs');
    replace('"data-workspace-git-include-unstaged":!0', '"aria-label":c1("workspace.review.includeUnstaged"),"data-workspace-git-include-unstaged":!0');
    return body;
  });
}
