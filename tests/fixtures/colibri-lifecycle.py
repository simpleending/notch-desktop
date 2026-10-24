"""Real Colibri 2.0 launcher/gateway/jobs, with tiny engines and no weights."""
import ctypes
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
import traceback

root = Path(sys.argv[1]).resolve()

if len(sys.argv) > 2 and sys.argv[2] == "serve":
    import openai_server
    from family_registry import family_by_id
    name, port = sys.argv[3], int(sys.argv[4])
    folder = root / name
    pidfile = Path(tempfile.gettempdir()) / f"coli-serve-{port}.pid"
    pidfile.write_text(f"{os.getpid()} {folder}\n")
    try:
        openai_server.serve(str(folder), host="127.0.0.1", port=port,
                            model_id=name, engine=str(folder / "engine.cmd"),
                            family=family_by_id("qwen36"))
    finally:
        pidfile.unlink(missing_ok=True)
    sys.exit(0)

import setup_flow

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
configs = {}
for name in ("alpha", "beta"):
    folder = root / name
    folder.mkdir()
    engine = folder / "engine.py"
    engine.write_text("""import ctypes,json,os,sys
from pathlib import Path
folder=Path(__file__).parent
with (folder.parent/'engines.jsonl').open('a') as log:
    log.write(json.dumps({'model':folder.name,'pid':os.getpid(),'console':ctypes.windll.kernel32.GetConsoleWindow()})+'\\n')
if (folder/'fail-start').exists():
    sys.stdout.buffer.write(b'LOAD_FAIL intentional test failure\\n')
    sys.stdout.buffer.flush()
    sys.exit(17)
sys.stdout.buffer.write(b'\\x01\\x01READY\\x01\\x01\\nSTAT 0 0 0 0 0\\n')
sys.stdout.buffer.flush()
for line in sys.stdin.buffer:
    if line.strip()==b'QUIT': break
""", encoding="utf-8")
    (folder / "engine.cmd").write_bytes(f'@echo off\r\n"{sys.executable}" "{engine}" %*\r\n'.encode())
    configs[name] = {"status":"ready", "launcher":str(Path(__file__).resolve()),
                     "args":[str(root), "serve", name, str(port)], "env":{},
                     "model_dir":str(folder), "model":{"id":name, "name":name},
                     "backend":"cpu", "host":"127.0.0.1", "port":port,
                     "urls":setup_flow.urls("127.0.0.1", port)}
active = "alpha"
events = []

def state():
    current = setup_flow.server_status(configs[active])
    return {"running":current["state"]=="ready", "modelId":current.get("model_id"),
            "selected":{"id":active}, "contextWindow":8192, "state":current["state"]}

def evidence():
    import psutil
    engines = []
    file = root / "engines.jsonl"
    for line in file.read_text().splitlines() if file.exists() else []:
        row = json.loads(line)
        try:
            row["alive"] = str(root / row["model"] / "engine.py").lower() in [arg.lower() for arg in psutil.Process(row["pid"]).cmdline()]
        except psutil.NoSuchProcess:
            row["alive"] = False
        engines.append(row)
    return {"events":events, "engines":engines}

def stop():
    if setup_flow.server_status(configs[active])["state"] != "stopped":
        setup_flow.stop_server(configs[active], out=lambda _:None)
        events.append({"action":"stop", "model":active})
    deadline = time.monotonic()+15
    while any(row["alive"] for row in evidence()["engines"]):
        if time.monotonic()>deadline: raise RuntimeError("Engine survived official Colibri stop")
        time.sleep(.1)
    return state()

def command(request):
    global active
    op = request["op"]
    if op == "status": return state()
    if op == "stop": return stop()
    if op == "start":
        assert not state()["running"]
        assert all(not row["alive"] for row in evidence()["engines"])
        active = request["model"]
        assert active in configs
        setup_flow.save_config(configs[active])
        events.append({"action":"start", "model":active})
        try:
            result = setup_flow.start_server(configs[active], background=True, open_browser=False, out=lambda _:None, wait=20)
            assert result["state"] == "ready", result
            assert state()["modelId"] == active
            return state()
        except Exception as error:
            stop()
            raise RuntimeError("Colibri test engine failed to load: "+str(error)) from error
    if op == "fail":
        marker = root / request["model"] / "fail-start"
        if request["enabled"]: marker.touch()
        else: marker.unlink(missing_ok=True)
        return {"ok":True}
    if op == "evidence": return evidence()
    raise ValueError("Unknown fixture operation")

print(json.dumps({"ready":True, "console":ctypes.windll.kernel32.GetConsoleWindow()}), flush=True)
try:
    for line in sys.stdin:
        request = json.loads(line)
        try: print(json.dumps({"id":request["id"], "value":command(request)}), flush=True)
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"id":request["id"], "error":str(error)}), flush=True)
finally:
    stop()
