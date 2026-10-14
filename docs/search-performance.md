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

## Rust integration decision

Persistent Rust content search is worth pursuing, but this change retains ripgrep for the agent. The candidate excluded 37 source files under `vs/workbench/contrib/void/browser/react/src2/`. That directory is ignored by the checkout's `.gitignore` files; the checkout has no Git repository metadata, and default ripgrep and fff applied those ignores differently. Matching results for two queries do not establish equivalent file coverage.

Before switching agent tools, preserve the intended ignored-file and explicit-path behavior, validate workspace boundaries and symlinks, and handle pagination, regex errors, context and cancellation. fff's current API can fall back to literal matching for invalid regexes, parses constraints from query text, and defaults to a 10 MiB per-file search limit. Those semantics need explicit handling. Existing filename search is unchanged.

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
