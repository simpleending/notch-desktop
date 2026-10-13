# notch-cli agent v2 compatibility layer

`agent-v2` is the migration boundary for a future native `pi-agent-core`
runtime. It is intentionally safe today: `runAgentV2()` delegates to the
production `../agent/loop.ts` implementation and returns a v2-shaped response.

This keeps callers source-compatible while `@mariozechner/pi-agent-core`
parity work happens behind the boundary. When the native runtime is ready, this
directory should keep the same public `AgentV2Config` / `AgentV2Response`
contract and swap only the internals.
