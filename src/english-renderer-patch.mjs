import { parse } from 'acorn';
import { rebrandWorkbenchText } from './bundle-patch.mjs';

const translations = new Map(Object.entries({
  '还有 ': '', ' 个标签': ' more tags', '关闭标签': 'Close tag', '收起 ': 'Collapse ', '展开 ': 'Expand ',
  '清除': 'Clear', '删除终端 ': 'Delete terminal ', '调整侧导航宽度': 'Resize sidebar', '关闭提示': 'Dismiss notice',
  ' 代码块': ' code block', '加载中…': 'Loading…', '描述你想完成的工作…': 'Describe what you want to do…',
  '选择文件夹': 'Choose folder', '所选文件夹': 'Selected folder',
  '允许 notchSpace 访问并修改“': 'Allow notch to access and modify files in "', '”中的文件？': '"?',
  '此权限适用于该目录中的全部文件和子目录。notchSpace 可以读取、更新和永久删除文件， 并在需要时向已连接的工具提供相关文件内容。请只允许访问你信任的文件夹。': 'This permission covers all files and subfolders in this folder. notch can read, update, and permanently delete files, and provide relevant file contents to connected tools when needed. Only grant access to folders you trust.',
  '取消': 'Cancel', '始终允许': 'Always allow', '允许一次': 'Allow once', '添加文件夹': 'Add folder',
  '更换文件夹': 'Change folder', '移除文件夹': 'Remove folder', '访问权限': 'Access permissions',
  '默认权限': 'Default permissions', '模型等级': 'Model tier', '正在读取模型…': 'Loading models…',
  '自动选择': 'Choose automatically', '添加上下文': 'Add context', '移除上下文': 'Remove context',
  '相关 Prompt 建议': 'Related prompt suggestions', '目的地预览导航': 'Preview navigation', '重试': 'Retry',
  '已压缩上下文': 'Context compressed', '高危操作': 'High-risk operation', '此操作需要你的确认。': 'This action needs your approval.',
  '关闭': 'Close', '收起': 'Collapse', '展开完整内容': 'Expand full content', '正在分析命令意图...': 'Analyzing the command…',
  '允许': 'Allow', '产品': 'Product', '操作': 'Action', '作用域': 'Scope', '风险等级': 'Risk level',
  'notch 需要以下权限完成任务': 'notch needs these permissions to complete the task',
  '即将访问需要授权的数据': 'This action accesses data that requires authorization', '查看更多权限配置': 'More permission settings',
  '飞书工作台': 'Lark Workspace', '授权范围': 'Authorization scope', '状态': 'Status',
  '等待用户在浏览器中授权': 'Waiting for authorization in your browser',
  '飞书 CLI 命令需要以下权限，请在浏览器中完成授权。': 'This Lark CLI command needs these permissions. Complete authorization in your browser.',
  '已自动打开授权页面。如未弹出浏览器，可复制下方链接并手动打开。': 'The authorization page has opened in your browser. If it did not open, copy the link below and open it manually.',
  '已复制': 'Copied', '复制授权链接': 'Copy authorization link', '正在分析': 'Analyzing',
  '首次启动 Onboarding 开关不可用。': 'The first-launch setup setting is unavailable.',
  'Discussion Agent 执行轮询已评估': 'Discussion agent execution poll evaluated',
  '当前宿主不支持讨论详情管理。': 'Discussion management is unavailable in this environment.',
  'Discussion 数据暂时不可用。': 'Discussion data is temporarily unavailable.', '终端暂时不可用。': 'The terminal is temporarily unavailable.',
  '暂时无法读取模型列表。': 'The model list could not be loaded. Try again.',
  '不支持该图片格式，仅支持 PNG、JPG、GIF 和 WebP 图片。': 'This image format is not supported. Choose a PNG, JPG, GIF, or WebP image.',
  '当前会话不支持文件夹附件，请选择文件。': 'This conversation does not support folder attachments. Choose files instead.',
  '未命名图片': 'Untitled image', '剪贴板图片': 'Clipboard image', '未命名文件': 'Untitled file',
  '无法读取这个文件或文件夹的磁盘路径。': 'The disk path for this file or folder could not be read.',
  '粘贴的文本.txt': 'Pasted text.txt', '网页注释': 'Web annotation', '消息无法解析': 'The message could not be parsed',
  '语法高亮 Worker 不可用：': 'Syntax highlighting worker unavailable: ', 'Tool UI 已注册：': 'Tool UI already registered: ',
  '图片数据格式无效。': 'Invalid image data.', '浏览器未完成剪贴板写入。': 'The browser could not write to the clipboard.',
  'Command ID 不能为空。': 'Command ID must not be empty.', '当前上下文无法执行 Command：': 'Cannot run this command in the current context: ',
  '无法粘贴这条速记。': 'This quick note could not be pasted.', '当前宿主不支持录音纪要。': 'Recording notes are unavailable in this environment.',
  '协作资源 ID 无效。': 'Invalid collaboration resource ID.', '协作 Project ID 无效。': 'Invalid collaboration project ID.',
  '请选择未来的执行时间。': 'Choose a future run time.', '重复间隔必须为 1 到 525600 分钟。': 'The repeat interval must be between 1 and 525600 minutes.',
  '分钟': 'Minutes', '执行时间无效。': 'Invalid run time.', '至少选择一个星期。': 'Choose at least one day of the week.',
  '日期': 'Date', '无效。': ' is invalid.', '请选择自动化时区。': 'Choose a time zone for the automation.',
  '自动化时区无效。': 'Invalid automation time zone.', '讨论引用 ID 无效。': 'Invalid discussion reference ID.',
  '讨论引用类型无效。': 'Invalid discussion reference type.', '讨论引用标签无效。': 'Invalid discussion reference label.',
  '已请求 ': 'Requested ', '会话控制状态观察返回了错误的身份。': 'The session control watcher returned a mismatched identity.',
  '更新会话控制状态': 'Update session control state', '当前宿主暂不支持会话交接。': 'Conversation handoff is unavailable in this environment.',
  '这条 Assistant 回复当前不可反馈。': 'Feedback is unavailable for this assistant reply.',
  '恢复兼容会话控制状态': 'Restore compatible session control state', '应用会话控制状态': 'Apply session control state',
  '会话暂时无法打开，请重试。': 'The conversation could not be opened. Try again.', 'Workspace 暂时不可用。': 'The workspace is temporarily unavailable.',
  'Keybinding 必须包含 Command ID、按键和安全的修饰键。': 'A keyboard shortcut must include a command ID, a key, and safe modifier keys.',
  ' 执行失败': ' failed', 'SVG 包含不支持的文档声明。': 'The SVG contains an unsupported document declaration.',
  'SVG 无法解析。': 'The SVG could not be parsed.', '文件不是有效的 SVG。': 'This file is not a valid SVG.',
  '无法创建头像画布。': 'The avatar canvas could not be created.', '无法创建 Emoji 画布。': 'The emoji canvas could not be created.',
  '头像图标渲染失败。': 'The avatar icon could not be rendered.', '调整任务与工作区宽度': 'Resize task and workspace',
  '远程工作区缺少根目录。': 'The remote workspace has no root folder.', 'Remote SSH Host 不存在或已经归档。': 'The SSH host does not exist or has been archived.',
  '新标签页': 'New tab', '预览 Runtime 已注册：': 'Preview runtime already registered: ',
  'SVG 不是有效的 UTF-8 文本。': 'The SVG is not valid UTF-8 text.', '不支持的图片格式。': 'Unsupported image format.',
  '今天': 'Today', '昨天': 'Yesterday', '本周': 'This week', '本月': 'This month', '面包屑': 'Breadcrumb',
  '中文': 'Chinese', '英文': 'English', 'Diff 暂时无法读取。': 'The diff could not be loaded. Try again.',
  '文件暂时无法读取。': 'The file could not be read. Try again.', '文件变更暂时无法审阅。': 'The file changes could not be reviewed. Try again.',
  'Git 状态暂时无法读取。': 'Git status could not be loaded. Try again.', '目录暂时无法读取。': 'The folder could not be read. Try again.',
  '文件夹不属于当前工作区。': 'This folder is outside the current workspace.', '文件夹路径无效。': 'Invalid folder path.',
  '文件夹暂时无法读取。': 'The folder could not be read. Try again.', '文件夹不存在或无法访问。': 'The folder does not exist or cannot be accessed.',
  '请先保存或放弃当前修改，再使用其他编码重新打开文件。': 'Save or discard your changes before reopening the file with another encoding.',
  '当前会话不可用。': 'This conversation is unavailable.', '文件不属于当前工作区。': 'This file is outside the current workspace.',
  '当前会话已切换。': 'The active conversation has changed.', '工作区目录不可用。': 'The workspace folder is unavailable.',
  'Turn Review 会话不可用。': 'The review session is unavailable.', '文件暂时无法保存。': 'The file could not be saved. Try again.',
  '当前环境不支持语音输入。': 'Voice input is unavailable in this environment.', '语音识别未能正常结束，请重试。': 'Speech recognition did not finish correctly. Try again.',
  '当前环境不支持声纹录制。': 'Voiceprint recording is unavailable in this environment.', '声纹录制已取消。': 'Voiceprint recording was cancelled.',
  '当前环境不支持实时语音。': 'Live Voice is unavailable in this environment.', '当前环境不支持声纹识别。': 'Voiceprint recognition is unavailable in this environment.',
  '请求为空': 'The request is empty', '内置浏览器暂时不可用，请稍后重试。': 'The built-in browser is temporarily unavailable. Try again.',
  '来源链接无效。': 'Invalid source link.', '来源链接仅支持 HTTP 或 HTTPS。': 'Source links must use HTTP or HTTPS.',
  '速记板暂时不可用。': 'Quick notes are temporarily unavailable.', '工作区文件索引加载失败。': 'The workspace file index could not be loaded.',
  '会话状态不可用。': 'The conversation status is unavailable.', '自动化能力仅支持桌面端。': 'Automation capabilities require the desktop app.',
  '自动化仅支持桌面端。': 'Automations require the desktop app.', '执行记录仅支持桌面端。': 'Run history requires the desktop app.',
  '自动化会话仅支持桌面端。': 'Automation conversations require the desktop app.', '自动化设置仅支持桌面端。': 'Automation settings require the desktop app.',
  '自动化模板仅支持桌面端。': 'Automation templates require the desktop app.', '保持唤醒设置仅支持桌面端。': 'The keep-awake setting requires the desktop app.',
  '这个操作正在进行。': 'This action is already in progress.', '自动化暂时不可用。': 'Automations are temporarily unavailable.',
  '远端工作目录没有写入权限。': 'The remote workspace folder is not writable.', '远程工作区信息不完整。': 'Remote workspace details are incomplete.',
  '当前宿主不支持导入记忆。': 'Memory import is unavailable in this environment.', '记忆导入失败，请稍后重试。': 'Memory import failed. Try again.',
  'notchWork 迁移失败，请稍后重试。': 'notchWork migration failed. Try again.', '当前宿主不支持 notchWork 迁移。': 'notchWork migration is unavailable in this environment.',
  '限量编号刷新失败，保留上一次状态': 'The limited number could not be refreshed; the previous value was retained',
  '活动状态刷新失败，保留上一次状态': 'The activity status could not be refreshed; the previous value was retained',
  '无法复制登录链接。': 'The sign-in link could not be copied.', '身份卡片尚未准备完成。': 'The profile card is not ready yet.',
  '当前环境不支持复制图片。': 'Image copying is unavailable in this environment.', '[Onboarding] 身份卡片复制失败': '[Setup] Profile card copy failed',
  '[Onboarding] 身份卡片下载失败': '[Setup] Profile card download failed', '无法读取身份卡图片。': 'The profile card image could not be read.',
  '身份卡图片格式无效。': 'Invalid profile card image format.', 'Quick Note 图片无法读取。': 'The quick note image could not be read.',
  'Quick Note 图片不存在。': 'The quick note image does not exist.', 'Quick Note Onboarding 文案片段缺失：': 'Quick note setup text is missing: ',
  'Quick Note Onboarding 内置图片加载失败。': 'The built-in quick note setup image could not be loaded.',
  'Quick Note Onboarding 内置图片格式无效。': 'Invalid built-in quick note setup image format.',
}));

// These strings match existing content or implement Chinese text processing; they are not UI copy.
const contentMatchers = new Set(['genNumberDict','processToneSandhiLiao','processReduplicationChar','getProcessFuncs','middlewareToneSandhi','matchesComposerSiteCommand','getAlibabaCloudTokenPlanUrl','workspaceFileSaveErrorCode','workspaceFileReadErrorCode','isWorkspaceFileNotFoundError','workspaceReviewDiffUnsafeCSS']);
const properties = node => new Map(node?.type === 'ObjectExpression' ? node.properties.filter(p => p.type === 'Property' && !p.computed).map(p => [p.key.name ?? p.key.value, p.value]) : []);
const han = /\p{Script=Han}/u;
const referencePreviewEnglish = {
  description:'Copy the message or select a complete tag, paste it, then edit and send to verify reference consistency.',
  available:'Simulate available capabilities',message:'Sent message',edit:'Edit this message',editor:'Capability reference input',
  placeholder:'Paste a complete reference or type @name…',send:'Send preview',select:'Select sample capabilities',clear:'New input',
  authorization:'This preview does not call a model. Displaying a tag does not grant execution permission.',source:'Original input text',
};

export function patchEnglishRenderer(source) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const catalog = new Map(), candidates = [], catalogEdits = [];
  function pair(chinese, english) {
    if (chinese?.type === 'Literal' && english?.type === 'Literal' && typeof chinese.value === 'string' && typeof english.value === 'string' && han.test(chinese.value) && !han.test(english.value)) {
      if (!catalog.has(chinese.value)) catalog.set(chinese.value, new Set());
      catalog.get(chinese.value).add(english.value);
    } else {
      const en = properties(english);
      for (const [key,value] of properties(chinese)) if (en.has(key)) pair(value,en.get(key));
    }
  }
  function visit(node, scope = '', owner = '', depth = 0, parent) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Property' && (node.key.name ?? node.key.value) === 'zh' && properties(parent).has('en')) return;
    if (node.type === 'VariableDeclarator') {
      if (node.init?.type === 'ClassExpression') owner = node.id.name;
      if (depth === 0 && node.id.name) scope = node.id.name;
    }
    if (node.type === 'ClassDeclaration') owner = node.id?.name ?? owner;
    if (node.type === 'MethodDefinition') scope = (owner ? owner + '.' : '') + (node.key.name ?? node.key.value);
    else if (/Function/.test(node.type)) { depth++; if (node.id?.name) scope = node.id.name; }
    if (node.type === 'ObjectExpression') {
      const props = properties(node);
      if (props.has('zh') && props.has('en')) {
        pair(props.get('zh'),props.get('en'));
        if (scope === 'shellResources') {
          const label = properties(properties(props.get('en')).get('common')).get('language');
          if (label?.value === '中文') catalogEdits.push({start:label.start,end:label.end,value:'"Chinese"'});
          const navigation = properties(props.get('en')).get('nav');
          if (navigation?.type === 'ObjectExpression' && !properties(navigation).has('chat')) catalogEdits.push({start:navigation.end-1,end:navigation.end-1,value:(navigation.properties.length?',':'')+'chat:"Chat"'});
        }
        if (['newChatResources','chatSessionResources'].includes(scope)) {
          let target = props.get('en');
          for (const key of scope === 'newChatResources' ? ['composer'] : ['chatSession','composer']) target = properties(target).get(key);
          if (target?.type !== 'ObjectExpression') throw new Error('English composer catalog structure changed.');
          if (!properties(target).has('referencePreview')) catalogEdits.push({start:target.end-1,end:target.end-1,value:(target.properties.length?',':'')+'referencePreview:'+JSON.stringify(referencePreviewEnglish)});
        }
      }
    }
    const text = node.type === 'Literal' && typeof node.value === 'string' ? node.value : node.type === 'TemplateElement' ? node.value.cooked : null;
    const propertyKey = ['Property','PropertyDefinition','MethodDefinition'].includes(parent?.type) && parent.key === node || parent?.type === 'MemberExpression' && parent.property === node;
    if (depth && text && han.test(text) && !contentMatchers.has(scope) && text !== 'Siqi Liu （刘思齐）' && !propertyKey) candidates.push({node,text,scope});
    for (const [key,value] of Object.entries(node)) {
      if (['start','end','type','regex'].includes(key) || key === 'value' && ['Literal','TemplateElement'].includes(node.type)) continue;
      if (Array.isArray(value)) for (const child of value) visit(child,scope,owner,depth,node);
      else if (value && typeof value === 'object') visit(value,scope,owner,depth,node);
    }
  }
  visit(tree);
  const edits = [...catalogEdits,...candidates.map(({node,text,scope}) => {
    const known = catalog.get(text), english = known?.size === 1 ? [...known][0] : translations.get(rebrandWorkbenchText(text));
    if (english === undefined) throw new Error(`Untranslated renderer text in ${scope}: ${text.slice(0,100)}`);
    const value = node.type === 'Literal' ? JSON.stringify(english) : english.replace(/[\\`]/g,'\\$&').replace(/\$\{/g,'\\${');
    return {start:node.start,end:node.end,value};
  })];
  for (const edit of edits.sort((a,b) => b.start-a.start)) source = source.slice(0,edit.start)+edit.value+source.slice(edit.end);
  return source;
}
