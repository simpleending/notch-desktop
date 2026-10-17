import type { ModelMessage } from 'ai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { toolResultValue } from '../messages.js';
import type { ToolResult } from '../tools/types.js';

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
