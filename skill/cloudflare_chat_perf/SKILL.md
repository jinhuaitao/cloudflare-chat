# Cloudflare Chat Performance

## When to use this skill

- Use this skill when the user asks you to work on the cloudflare-chat repository, improve its latency, reduce its token cost, change its Agent loop, change its memory or knowledge base, change its Telegram or WeChat channel, or prepare a release.

- Use this skill when the user names the repository URL https://github.com/jinhuaitao/cloudflare-chat or asks about Cloudflare Workers performance for this project.

- Do not use this skill for unrelated Cloudflare projects. Use general Workers guidance for those projects and keep this skill scoped to this repository.

## Map the project before you change it

- Read the repository README first and note the current version, the three channels, the twelve expert personas, the three layer memory model, the nineteen agent tools, and the R2 knowledge base.

- Read `R2-PERFORMANCE.md` in the repository before you change any storage code and note its measured operation counts and its stated limits.

- Read `_worker.js` first for routing and note that it only dispatches requests while business logic lives under `src/`.

- Map the hot path as web or Telegram or WeChat request, Agent loop in `src/agent/loop.js`, memory load in `src/memory/`, knowledge base registry in `src/kb/registry.js`, and storage in `src/store/r2.js`.

- Check `wrangler.toml` for the R2 binding, the cron trigger, the compatibility date, and whether Smart Placement is enabled.

## Protect the performance invariants

- Keep the system prompt prefix byte stable inside one Agent round and put progress hints in a trailing user message instead of rewriting the system message.

- Keep tool definitions small and reuse cached tool sets by permission and persona instead of rebuilding them every round.

- Route every R2 read and write through `src/store/r2.js` and keep its single flight merging, retry, and conditional write behavior intact.

- Use conditional writes for the memory object and the knowledge base registry and retry a conflict by rereading and recomputing instead of overwriting blindly.

- Treat a failed R2 read as a failure and never treat it as empty data that can overwrite existing memory or trigger a registry rebuild.

- Keep memory writes off the reply path by using `waitUntil` when a context is available and keep a short timeout for the write path.

- Keep tool timeouts tied to the remaining round budget and skip a queued tool call when less than two seconds remain.

- Keep the web channel read only for the knowledge base and keep write tools available only on Telegram and WeChat unless the user explicitly changes that rule.

## Diagnose before you optimize

- Ask which latency the user means and measure that latency first, such as time to first token, total round time, R2 operation count, or page load time.

- Read `R2-PERFORMANCE.md` and distinguish offline memory bucket counts from online latency, because fewer operations do not prove a fixed percentage speedup online.

- Check whether the upstream model dominates the round and count Agent steps, tool calls, and context size before you blame R2.

- Check the R2 bucket region, the Smart Placement setting, and the cron polling budget before you blame code for a slow round.

- Use the repository bench script for R2 call orchestration and use `npm run verify` for consistency and regression tests before you claim an improvement.

## Make the change

- Change one bottleneck at a time and keep the change small enough to test in isolation.

- Prefer parallel reads for independent memory, registry, and persona loads and keep dependent reads serial only when the next read needs the first result.

- Prefer range reads for document frontmatter and prefer full reads only when the caller needs the full text.

- Prefer early return for web fetching when the live text is already sufficient and cancel the slow snapshot request in that case.

- Split a large handler only when the split keeps the shared Agent, memory, and history behavior identical across Telegram and WeChat.

- Keep the frontend as a single served page unless the user asks for a build step, and document any new build, minification, or caching change in the README.

## Verify the change

- Run `npm run verify` before you present a performance change as ready.

- Run the repository test suite and the performance tests and report the exact pass count and any failures.

- Run the R2 bench script and report operation counts and busy time, not only wall clock time.

- Check that the version in `package.json`, `src/constants.js`, and the README title still match when you change a version.

- Check that the README test count still matches the measured test count when you add or remove tests.

## Deploy and observe

- Deploy with `wrangler deploy` only after verification passes and after the user approves the deployment.

- Confirm the R2 bucket region is apac for users in Asia and confirm whether Smart Placement fits the dominant channel, because a web heavy deployment and a bot heavy deployment have different tradeoffs.

- Observe with `wrangler tail` and the agent debug stats and report R2 gets, puts, lists, retries, and conditional write conflicts.

- Treat a missing CI workflow as a gap and tell the user when the README claims a CI check that is not present in the repository.

## Available connectors

- Use `muse.connector_search` to find other connectors and `muse.skill_search` to find related skills.

- If nothing here fits, look on the web for a maintained API or MCP server and set it up with [Custom Connectors and MCPs](/opt/muse/skills/custom-connector-setup/SKILL.md), or build a custom connector.

## Websites

- [cloudflare-chat](https://github.com/jinhuaitao/cloudflare-chat) for the repository README, the R2 performance report, the source layout, and the release notes. Read the README and `R2-PERFORMANCE.md` there before you change storage or Agent code.

- [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/) for Workers limits, Smart Placement, cron triggers, R2 bindings, and observability. Carry the repository version and the current `wrangler.toml` settings into any check there.

## Alternatives for better results

- Ask the user for the dominant channel and the dominant model before you tune, because a web heavy deployment, a Telegram heavy deployment, and a WeChat heavy deployment need different tradeoffs.

- Offer a smaller scoped change first, such as a prompt prefix fix or a registry cache fix, when the user asks for a broad speedup and has not named a measured bottleneck.

- Offer to add a real latency measurement, such as per step timing in the agent debug stats, when the current evidence only shows operation counts.
