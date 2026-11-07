import type { ModelMessage } from 'ai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { toolResultValue } from '../messages.js';
import type { ToolResult } from '../tools/types.js';
import { sourceLink, webUrl } from '../web/content.js';

const WEB_CALL_LIMITS = { web_search: 4, web_fetch: 4 };
type WebTool = keyof typeof WEB_CALL_LIMITS;

export function isWebResearchTool(name: string): name is WebTool {
  return name === 'web_search' || name === 'web_fetch';
}

export function isVerificationCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|verify|lint|typecheck|validate|smoke|build)[\w:-]*\b|\b(?:vitest|jest|pytest|tsc|eslint|curl|Invoke-WebRequest|Invoke-RestMethod)\b|\b(?:cargo|go|dotnet)\s+test\b|\bnode\s+--check\b|\bnode\s+(?:-e|--eval)\s+.*\b(?:assert|fetch|statusCode)\b|\b[^\s"']*(?:verify|check|test|spec|smoke|qa)[^\s"']*\.(?:[cm]?js|[cm]?ts|py)\b/i.test(command);
}

export function masksFailure(command: string): boolean {
  let quote='';
  for(let i=0;i<command.length;i++){
    const char=command[i];
    if(char==='\\'||char==='^'){i++;continue;}
    if(quote){if(char===quote)quote='';continue;}
    if(char==='"'||char==="'"){quote=char;continue;}
    if(char==='|'&&command[i+1]==='|')return true;
  }
  return false;
}

function canonical(value: unknown): unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
}

/** Per-turn receipts survive compaction; only an actual successful rerun clears a failed check. */
export class ExecutionGuard {
  private pending: Promise<unknown> = Promise.resolve();
  private batch = new Map<string, ToolResult>();
  private webRequests = new Set<string>();
  private webCalls = { web_search: 0, web_fetch: 0 };
  private webResearchClosed = false;
  private sources = new Map<string, { title: string; excerpt: string; fetched: boolean }>();
  private failures = new Map<string, number>();
  private failedSinceChange = new Map<string, number>();
  private ownership = new AsyncLocalStorage<boolean>();
  readonly checks = new Map<string, { command: string; passed: boolean }>();
  private unrunChecks = new Set<string>();
  stopped?: string;

  constructor(messages: ModelMessage[] = []) {
    const calls=new Map<string,Record<string,unknown>>();
    for(const message of messages)if(Array.isArray(message.content))for(const part of message.content){
      if(part.type==='tool-call'&&part.toolName==='shell')calls.set(part.toolCallId,part.input as Record<string,unknown>);
      if(part.type==='tool-result'){
        const args=calls.get(part.toolCallId),result=toolResultValue(part) as (ToolResult&{notchChecks?:Array<{command:string;passed:boolean}>;notchUnrunChecks?:string[]})|undefined;
        if(args&&result&&typeof result.content==='string')this.recordCheck(args,result);
        if(part.toolName==='code_exec'&&Array.isArray(result?.notchChecks))for(const check of result.notchChecks)this.checks.set(check.command,check);
        if(part.toolName==='code_exec'&&Array.isArray(result?.notchUnrunChecks)){this.unrunChecks.clear();for(const command of result.notchUnrunChecks)this.unrunChecks.add(command);}
      }
    }
  }

  beginStep(): void { this.batch.clear(); }
  get webCallCount(): number { return this.webRequests.size; }
  get hasFetchedSource(): boolean { return [...this.sources.values()].some(source => source.fetched); }
  closeWebResearch(): void { this.webResearchClosed = true; }
  webToolAvailable(name: string): boolean {
    return !isWebResearchTool(name) || (!this.webResearchClosed && this.webCalls[name] < WEB_CALL_LIMITS[name]);
  }
  private preferredSources() {
    return [...this.sources].sort(([, a], [, b]) => Number(b.fetched) - Number(a.fetched))
      .slice(0, 4);
  }
  get webSourceLinks(): string[] {
    return this.preferredSources().map(([url, source]) => sourceLink(source.title, url));
  }
  webEvidence(maxChars: number): string {
    const sources = this.preferredSources();
    const excerptLength = Math.max(0, Math.floor(maxChars / Math.max(1, sources.length)) - 700);
    return sources.map(([url, source]) => {
      const link = sourceLink(source.title, url);
      return excerptLength && source.excerpt ? link + '\n' + source.excerpt.slice(0, excerptLength) : link;
    }).join('\n\n').slice(0, maxChars);
  }
  private recordWebSources(name: WebTool, result: ToolResult): ToolResult {
    const { webSources, ...visible } = result;
    if (!result.isError && Array.isArray(webSources)) {
      for (const source of webSources) {
        if (typeof source?.url !== 'string' || source.url.length > 512 || typeof source.title !== 'string') continue;
        try {
          const url = webUrl(source.url);
          const previous = this.sources.get(url);
          if (!previous || name === 'web_fetch') {
            const title = source.title.replace(/[<>]/g, ' ').slice(0, 160);
            const excerpt = typeof source.excerpt === 'string' ? source.excerpt.slice(0, 2000) : '';
            this.sources.set(url, {
              title: name === 'web_fetch' && title === new URL(url).hostname ? previous?.title ?? title : title,
              excerpt: excerpt || previous?.excerpt || '',
              fetched: name === 'web_fetch',
            });
          }
        } catch { /* An invalid link cannot become a citation. */ }
      }
    }
    return visible;
  }
  get failedChecks(): string[] { return [...this.checks.values()].filter(check=>!check.passed).map(check=>check.command).concat([...this.unrunChecks]); }
  private recordCheck(args: Record<string,unknown>, result: ToolResult): void {
    const command=typeof args.command==='string'?args.command.trim():'';
    if(!isVerificationCommand(command))return;
    if(result.notExecuted||/^\[DRY RUN\]/.test(result.content)||masksFailure(command)){this.checks.delete(command);this.unrunChecks.add(command);return;}
    if(!args.background||result.isError){this.checks.set(command,{command,passed:!result.isError});if(!result.isError)this.unrunChecks.clear();}
  }

  run(name: string, args: Record<string,unknown>, execute: () => Promise<ToolResult>): Promise<ToolResult> {
    const executeGuarded=async()=>{
      if(this.stopped)return {content:this.stopped,isError:true};
      const input=name==='shell'?{command:String(args.command??'').trim(),background:!!args.background}:args;
      const key=name+':'+JSON.stringify(canonical(input));
      if (isWebResearchTool(name)) {
        if (this.webRequests.has(key)) return { content: 'Duplicate web request skipped. Use the evidence already returned for this request.', notExecuted: true };
        if (!this.webToolAvailable(name)) return { content: 'The web research limit for this tool is reached. Use the evidence already collected.', notExecuted: true };
        this.webRequests.add(key);
        this.webCalls[name]++;
        return this.recordWebSources(name, await this.ownership.run(true, execute));
      }
      const duplicate=this.batch.get(key);
      if(duplicate)return {...duplicate,content:'Duplicate call skipped; previous result:\n'+duplicate.content};
      if((this.failures.get(key)??0)>=2||(this.failedSinceChange.get(name)??0)>=5){
        this.stopped='Stopped retrying: '+name+' repeatedly failed without a successful change. Inspect the error and change the approach before continuing.';
        return {content:this.stopped,isError:true};
      }
      const record=(result: ToolResult)=>{
        this.batch.set(key,result);
        if(name==='shell')this.recordCheck(args,result);
        if(name==='code_exec' && result.notExecuted && typeof args.code==='string' && isVerificationCommand(args.code))this.unrunChecks.add(args.code.trim());
        if(result.isError){this.failures.set(key,(this.failures.get(key)??0)+1);this.failedSinceChange.set(name,(this.failedSinceChange.get(name)??0)+1);}
        else if(name==='read'){
          // A fresh read resolves the file-version precondition for guarded edits.
          for(const failed of this.failures.keys())if(/^(?:write|edit|apply_patch):/.test(failed))this.failures.delete(failed);
          for(const tool of ['write','edit','apply_patch'])this.failedSinceChange.delete(tool);
        }
        else if(name==='shell'){
          if(this.failures.delete(key))this.failedSinceChange.delete(name);
        }
        else if((['write','edit','apply_patch','notebook'].includes(name) && result.changed!==false && args.action!=='read') || (name==='git' && ['checkout','pull','stash'].includes(String(args.operation)))){
          this.failures.clear();this.failedSinceChange.clear();
        }
        return name==='code_exec'&&(this.checks.size||this.unrunChecks.size)?{...result,notchChecks:[...this.checks.values()],notchUnrunChecks:[...this.unrunChecks]}:result;
      };
      try{return record(await this.ownership.run(true,execute));}
      catch(error){record({content:error instanceof Error?error.message:String(error),isError:true});throw error;}
    };
    // Nested code-cell tools already belong to the outer operation; waiting on
    // that same queue would deadlock. Their results still use the same receipts.
    if(this.ownership.getStore())return executeGuarded();
    const operation=this.pending.then(executeGuarded);
    this.pending=operation.catch(()=>{});
    return operation;
  }

  failureReport(): string {
    return 'Checks have not passed. No successful rerun was recorded for:\n'+this.failedChecks.map(command=>'- '+command).join('\n');
  }
}
