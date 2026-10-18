# Windows hardware probe

A read-only Rust executable replacing PowerShell startup and runtime C# compilation for Windows memory discovery. No server, elevated permissions, network, model loading, or persistent writes are involved.

It queries the same sources as the PowerShell fallback:

- `Win32_PhysicalMemory.Capacity`: sum of installed RAM, for display only.
- `IDXGIFactory1::EnumAdapters1` / `GetDesc1`: largest dedicated video-memory capacity among non-software adapters, using 64-bit values.
- `Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory.DedicatedUsage`: maximum usage across adapter counters.

It emits one versioned JSON record. Missing counters, WMI/DXGI errors and arithmetic overflow produce a nonzero exit. The TypeScript caller validates safe nonnegative integers, clamps free VRAM at zero, and falls back to the original PowerShell query on missing, blocked, timed-out or malformed native output. If both fail, discovery retains conservative RAM-only sizing.

Actual available RAM remains `min(os.freemem(), process.availableMemory())`, read for each discovery call. Installed RAM never becomes available RAM. The five-second browsing cache is bypassed by `windowsMemory(true)` / `detectLocalHardware(true)` during safety checks. Model/context overhead, headroom, and Colibri's exact checkpoint planning are unchanged.

## Build and verify

Windows source builds require Rust and the MSVC C++ build tools. End users receive the helper in the package and do not need Rust. Run the normal CLI build, or the IDE's `build:core`. Both run `scripts/build-hardware.mjs`, building with `--locked` and the static CRT and copying the executable and dependency licenses beside the JS bundle. Cargo.lock pins the Rust dependencies. Windows x64 is tested; an ARM64 host can build its corresponding helper, but that target has not been tested. Platforms without a matching bundled executable retain their existing path.

```
cargo test --locked --manifest-path native/windows-hardware/Cargo.toml
npm run build:publish
node scripts/benchmark-windows-hardware.mjs report.json
```

The desktop additionally runs `node scripts/verify-hardware.mjs`, which verifies an npm tarball, the built IDE core, and an Electron ASAR with its unpacked executable. The desktop release packager refuses to omit the helper or its licenses from either the core or embedded CLI.

Source references: [WMI Rust API](https://docs.rs/wmi/0.18.4/wmi/), [Microsoft Rust DXGI bindings](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Graphics/Dxgi/fn.CreateDXGIFactory1.html), [Win32_PhysicalMemory](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-physicalmemory).
