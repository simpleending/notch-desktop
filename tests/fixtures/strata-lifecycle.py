"""Exercise installed Strata Control with a tiny engine, not model weights.

Engine protocol/tokenizer fixture follows Strata v0.2.2 tests/terminal/test_runtime.py.
The supervisor, HTTP server, readiness, owner transport and Windows jobs are real.
"""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
import urllib.request

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
from strata_control import profiles, runtime
from tools.strata_tokenizer import BYTE_TO_UNICODE

tokenizer = root / "tokenizer"
tokenizer.mkdir()
tokens = [BYTE_TO_UNICODE[i] for i in range(256)] + ["ab", "<|im_start|>", "<|im_end|>", "<|endoftext|>"]
(tokenizer / "vocab.json").write_text(json.dumps({token: i for i, token in enumerate(tokens)}))
(tokenizer / "merges.txt").write_text("a b")
(tokenizer / "token_type.json").write_text(json.dumps([0] * 257 + [3, 3, 3]))

for name in ("alpha", "beta"):
    folder = root / name
    folder.mkdir()
    engine = folder / "engine.py"
    engine.write_text("""import sys,json,os,ctypes
from pathlib import Path
Path('engine.pid').write_text(str(os.getpid()))
Path('console.json').write_text(json.dumps({'pid':os.getpid(),'console':ctypes.windll.kernel32.GetConsoleWindow()}))
with Path('engines.jsonl').open('a') as history:
    history.write(json.dumps({'pid':os.getpid(),'console':ctypes.windll.kernel32.GetConsoleWindow()})+'\\n')
if Path('fail-start').exists():
    print('INTENTIONAL_TEST_ENGINE_START_FAILURE',file=sys.stderr,flush=True)
    sys.exit(17)
print('READY 8192 stop',flush=True)
try:
    for line in sys.stdin:
        if line.strip()=='QUIT': break
        if line.startswith(('GEN ','BGEN ')):
            print('T 97',flush=True)
            print('DONE 1 1 1.0 1.0 length 0 0 0',flush=True)
finally:
    Path('engine.exited').write_text(str(os.getpid()))
""", encoding="utf-8")
    wrapper = folder / "engine.cmd"
    wrapper.write_bytes(f'@echo off\r\n"{sys.executable}" "{engine}" %*\r\n'.encode())
    config = folder / "run.json"
    config.write_text(json.dumps({"exe":str(wrapper), "tokenizer":str(tokenizer), "args":[], "cwd":str(folder), "model_name":"strata-test-"+name,"host":"127.0.0.1","port":0,"api_key":"none"}))
    profiles.create(name, str(config))

active = None
events = []

def state():
    rows = {name:runtime.status(name) for name in ("alpha","beta")}
    ready = [(name,row) for name,row in rows.items() if row.get("state")=="ready"]
    if len(ready)>1: raise AssertionError("Two Strata profiles are loaded at once")
    if ready:
        name,row = ready[0]
        with urllib.request.urlopen(row["api_url"]+"/v1/models",timeout=5) as response:
            model = json.load(response)["data"][0]
        return {"running":True,"selected":{"id":name},"modelId":model["id"],"contextWindow":model.get("meta",{}).get("n_ctx"),"instanceId":row["instance_id"],"apiUrl":row["api_url"],"states":rows}
    return {"running":False,"selected":{"id":active},"states":rows}

def stop_all():
    for name in ("alpha","beta"):
        current = runtime.status(name)
        if current.get("state") != "stopped":
            result = runtime.stop(name,timeout=30,expected_instance_id=current.get("instance_id"))
            if not result.get("ok") or result.get("state")!="stopped": raise AssertionError(result)
            events.append({"action":"stop","model":name,"at":time.monotonic()})
    return state()

def command(request):
    global active
    op=request["op"]
    if op=="status": return state()
    if op=="start":
        name=request["model"]
        assert name in ("alpha","beta")
        assert not state()["running"], "Previous model was not ejected before launch"
        assert not any(engine["alive"] for engine in command({"op":"evidence"})["engines"]), "Previous engine process survived eject"
        active=name
        events.append({"action":"start","model":name,"at":time.monotonic()})
        result=runtime.start(name,wait=40,shutdown_timeout=1,die_with_pid=request["ownerPid"])
        if not result.get("ok") or result.get("state")!="ready":
            stop_all()
            raise RuntimeError("Strata test engine failed to load: "+str(result.get("error")))
        current=state()
        assert current["modelId"]=="strata-test-"+name
        assert current["contextWindow"]==8192
        return current
    if op=="stop": return stop_all()
    if op=="fail":
        marker=root/request["model"]/"fail-start"
        if request["enabled"]: marker.touch()
        else: marker.unlink(missing_ok=True)
        return {"ok":True}
    if op=="stale-stop":
        before=state();assert before["running"]
        result=runtime.stop(before["selected"]["id"],timeout=10,expected_instance_id="0"*32)
        assert not result["ok"]
        assert state()["instanceId"]==before["instanceId"]
        return {"rejected":True,"instanceUnchanged":True}
    if op=="evidence":
        evidence={"events":events,"engines":[]}
        import psutil
        for name in ("alpha","beta"):
            file=root/name/"engines.jsonl"
            if file.exists():
                for line in file.read_text().splitlines():
                    engine=json.loads(line)
                    pid=engine["pid"]
                    try: alive=str(root/name/"engine.py").lower() in [arg.lower() for arg in psutil.Process(pid).cmdline()]
                    except psutil.NoSuchProcess: alive=False
                    evidence["engines"].append({"model":name,**engine,"alive":alive})
        return evidence
    raise ValueError("Unsupported fixture operation")

print(json.dumps({"ready":True,"console":ctypes.windll.kernel32.GetConsoleWindow()}),flush=True)
try:
    for line in sys.stdin:
        request=json.loads(line)
        try: print(json.dumps({"id":request["id"],"value":command(request)}),flush=True)
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"id":request["id"],"error":str(error)}),flush=True)
finally:
    stop_all()
