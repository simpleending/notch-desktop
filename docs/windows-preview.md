# notch for Windows

Download the `.exe` installer from the official [GitHub releases](https://github.com/simpleending/notch-desktop/releases). Install it for your Windows account, then open **notch** from your Start menu or desktop. Older preview builds use the name **notch preview**.

The Windows release supports Windows 10/11 on x64 PCs. It includes its own application runtime; Node.js is not required to open the desktop. Local model downloads require an internet connection and enough disk space and memory. An installed Ollama model or an OpenRouter API key can also get you started.

The installer is unsigned. Windows or your browser may describe a new unsigned download as unrecognized or potentially unsafe. Download only from this repository's Releases page and compare its SHA-256 with `SHA256SUMS.txt` if you want to verify the file. GitHub hosting does not remove Windows reputation checks. Managed PCs may prevent installation under their organization's policy.

Review file changes, then use the turn's undo control to restore that turn and later tracked changes. Checkpoints survive restarting notch. A preview never changes files, and conflicting manual edits block restoration. Undo covers built-in file edits and returned OpenRouter task changes, including terminal-created files. Local terminal commands and external tools still need version control. An unverified write interrupted during a crash is blocked for inspection. Old preview checkpoints were not persisted and cannot be recovered retrospectively.

Writable OpenRouter chats use automatic Git worktrees and return safe changes when finished. Install Git and choose a specific project folder; notch refuses to snapshot a folder containing its own task storage. Non-Git projects get a private Git database without changing the original folder. Shared plugins, MCP tools and command hooks are unavailable for cloud tasks. Conflicts and unfinished files remain separate and can be resumed. This is not an operating-system sandbox for arbitrary code.

Bundled plugins are checked against SHA-256 manifests at startup. This detects changed bundled files; it does not establish that arbitrary third-party plugins are safe. OpenRouter uses your own key and bills usage through your provider. Paid cloud inference, macOS/Linux builds and Apple MLX inference are not part of the Windows release verification.

Uninstall through Windows Settings → Apps. Uninstalling keeps your conversations, settings and downloaded models. Reinstalling the application does not require downloading models again.
