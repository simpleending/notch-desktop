# Hidden Ollama console host

The Windows GUI-subsystem helper hosts the official Ollama executable in a ConPTY session. Ollama's GPU-discovery children inherit that session, preventing Windows Terminal or console windows from opening. It does not modify Ollama, its GPU libraries, model files or environment options.

Notch copies the verified bundled helper to a content-addressed file under its managed Ollama runtime. A short-lived launcher creates the persistent host with an explicit Windows handle list containing only its log file. Electron's pipes, sockets and program handles cannot keep app exit or updates waiting. The host drains console output on a separate thread and remains alive with the daemon after the IDE exits. It holds no installed application files open, so updates can replace the IDE without killing CLI inference. When Ollama exits, it closes the pseudoconsole and its remaining children and returns the server exit code. Launch failures are logged; the caller verifies daemon health before reporting readiness.

On first use, the IDE checks the owner of its private port 11436. Only the exact managed `vX.Y.Z/ollama.exe serve` is eligible for transition. It waits for the shared local-inference lease, rechecks the process identity and creation time, then restarts through the hidden host and restores previously resident models and their contexts. External Ollama installations are left alone. Startup never downloads a runtime or model. A missing or blocked bundled host produces an error instead of reverting to a flashing launcher.

Build using `npm run build:core`. Rust/MSVC are build requirements only. Cargo.lock pins the dependencies; `CONSOLE-THIRD-PARTY-NOTICES.txt` includes their license texts. Windows 10 1809 or later supports ConPTY; the desktop's Electron runtime requires newer Windows 10/11. Windows x64 is tested; ARM64 is buildable but untested.

`npm run verify:hidden-console` checks failure handling, nested processes, output draining, parent exit and an already-downloaded model's load/eject/remount without generation. Set `OLLAMA_MODELS` to the existing store. `node scripts/verify-hidden-console-electron.mjs <Notch.exe> <bundled-console-helper.exe>` checks normal Electron exit while the daemon stays alive, with redirected and discarded output. Both checks observe all new visible console windows, including shared Windows Terminal windows, and never download models.

API and lifecycle reference: [Microsoft pseudoconsole session guide](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session).
