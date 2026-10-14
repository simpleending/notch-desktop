# Search performance

The desktop agent and MCP grep tool now invoke ripgrep asynchronously, without a shell. A no-match exit returns immediately instead of triggering a second JavaScript scan. Only a missing executable selects the existing fallback; invalid regexes, process errors, output overflow and timeouts return errors. Cancellation reaches the child process and fallback reads. The 15-second timeout and 5 MiB output bound remain.

The shared source is `vendor/notch-cli/src/tools/grep.ts`; the rebuilt desktop harness is included under `vendor/notch-core`. Seven focused tests cover responsiveness, literal arguments and Unicode paths, context/glob handling, no-match behavior, errors, fallback, cancellation, argument validation and execution through the desktop tool loop. Strict typecheck, core build and all 56 tests passed.

## Measurements

Measured on Windows with Node 24.14.0 on October 14, 2026. Each case used two warmups and nine serial warm-filesystem-cache samples. Every query result was checked against asynchronous ripgrep. The fff candidate used the installed `@ff-labs/fff-node` 0.11.0 in a separate Node process with content indexing and memory-map warmup enabled; query latency includes worker IPC.

The larger workspace was the sibling IDE source tree: ripgrep listed 5,456 files; fff indexed 5,419. The hit query was `class PieceTreeBase` (one matching line); the miss used a unique absent marker. These are focused query measurements, not a complete IDE or cold-disk benchmark.

| Median query time | Previous grep | Fixed grep | fff candidate |
| --- | ---: | ---: | ---: |
| Hit | 335.16 ms | 325.65 ms | 64.65 ms |
| No match | 3,802.52 ms | 325.93 ms | 5.36 ms |

The largest observed parent event-loop delay across these samples fell from 375.25 ms to 20.74 ms with the fixed grep. It is measured with a 5 ms heartbeat, not editor frame timing. The candidate's startup, scan and content warmup took 512.66 ms; sampled worker RSS reached 71.13 MiB. That is neither peak memory nor an incremental-memory comparison with ripgrep's subprocess.

A separate 1,000-file generated fixture also produced identical query results: the first run's no-match medians were 951.37 ms before, 312.89 ms after and 94.28 ms for fff. Timing varies by workspace and OS scheduling; these numbers are not universal speedup promises.

## Integrated Rust search

Desktop agent grep and glob now use the existing shared fff utility process. The 37-file discrepancy under `vs/workbench/contrib/void/browser/react/src2/` is resolved by honoring `.gitignore` even without Git metadata: the compatibility path explicitly uses ripgrep's `--no-require-git`. The worker compares native membership with canonical ripgrep membership before selecting fff; mismatches use the compatibility path rather than returning incomplete results.

fff 0.11.0 differs from ripgrep for multiline-capable regexes, query constraints, known binary extensions, UTF-16/BOM text and files over 10 MiB. Consequently, indexed grep handles literal single-line patterns over validated UTF-8 source files; full regexes, whitespace patterns, grep glob overrides, explicit files and incompatible corpora use the packaged Rust ripgrep executable. This is deliberate compatibility routing, not a claim that every search uses fff. Glob adopts the workspace's `.gitignore` policy, including folders without Git metadata, and validates native matches against the installed glob matcher.

The adapter preserves whole pagination pages, reconstructs full matched/context lines because fff display text truncates at 512 bytes, and validates physical result paths. Unicode and CRLF fixtures are covered. Host mutation hooks invalidate indexes before and after actions; file/ignore watchers trigger rescans. Cancellation rejects pending tool results and removes queued work. Native indexing and compatibility processes run outside the UI thread. Cache memory is capped at 64 MiB per content index, with at most two indexes; process overhead is additional.

`tests/native-search.test.mjs` covers more than one result page, long lines, Unicode/CRLF context, no-Git ignore rules, explicit ignored targets, glob compatibility, raw regex/encoding fallback, immediate edits, ignore changes, cancellation and outside-root rejection. `scripts/verify-search.mjs` checks the installed binary/notices and drives actual composer tool execution with a deterministic provider stream. Existing `verify:agent` separately checks real local inference. The initial candidate measurements above predate the production compatibility checks and must not be presented as final packaged latency.

Windows x64 preview.2 was installed from its NSIS package and verified on 2026-10-14. Strict typecheck, core build and all 73 tests passed. Installed setup, dark/light workbench, all 19 settings sections and search checks passed. Search verification used an empty PATH, confirmed fff pagination and bundled ripgrep routing, and checked fresh content, ignore edits and cancellation. Native enumeration reads the complete index independently of the resetting scan counter; its ignore-rescan regression passed ten consecutive runs. A separate real local-model run passed write/shell approvals, an independent generated-file test, restart/resume, cancelled writes and native compaction. Installed catalog checks covered Hugging Face search/pagination, public OpenRouter browsing, stale queries and popup bounds in both themes. These checks do not establish cross-platform behavior or production readiness.

## Reproduce

From the desktop repository:

```powershell
npm run typecheck
npm run build:core
npm test
node scripts/benchmark-search.mjs
node scripts/benchmark-search.mjs ..\notch-desktop\src 'class PieceTreeBase'
```

The first benchmark generates and removes a 1,000-file fixture. The second reads an existing workspace. The previous grep implementation comes from the committed `HEAD`; the report records its exact revision. The measurements above used `1edc081b0924675f795dff948a8e9875c214a2c1`. After committing the fix, `HEAD` will represent a different baseline.

The script restricts workspace paths and hit patterns to shell-safe inputs because it executes the old shell-based implementation for comparison. The production fix supports spaces and Unicode. Machine-specific JSON reports, including per-sample timings and file-coverage differences, are saved under ignored `analysis/`.

API references: [Node child processes](https://nodejs.org/api/child_process.html), [ripgrep](https://github.com/BurntSushi/ripgrep), [fff](https://github.com/dmtrKovalenko/fff).
