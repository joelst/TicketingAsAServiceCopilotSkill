# Ticketing As A Service Copilot Skill

Standalone repository for the [Ticketing As A Service](https://www.teamswork.app/products/microsoft-teams-ticketing/ticketingapi) Copilot skill package.

## Contents
- `.copilot/skills/ticketing-api/SKILL.md`
- `.copilot/skills/ticketing-api/tool-schema.json`
- `.copilot/skills/ticketing-api/starter/dispatcher.js`
- `.copilot/skills/ticketing-api/evals/cases.json`

## Package and use in GitHub Copilot

This repository is already laid out in the expected GitHub Copilot skill structure:
- `.copilot/skills/ticketing-api/SKILL.md` (behavior/instructions)
- `.copilot/skills/ticketing-api/tool-schema.json` (tool contract)
- `.copilot/skills/ticketing-api/starter/*` (runtime adapter/dispatcher/test helpers)

To package and use it:
1. Keep the `.copilot/skills/ticketing-api` folder in your project root.
2. Open the project in VS Code with GitHub Copilot Chat enabled.
3. Ensure required environment variables are set for runtime scripts:
   - `ticketingAPIKey` or `TICKETING_API_KEY`
4. Run local checks before publishing:
   - CI workflow in `.github/workflows/ci.yml`
   - local scripts listed below in this README

Distribution options:
- As source: commit the `.copilot/skills/ticketing-api` folder directly to your repository.
- As artifact: zip the folder and unpack it into another repo at `.copilot/skills/ticketing-api`.

## Claude interoperability

The `.copilot/skills/...` folder format is GitHub Copilot specific, but most assets here are provider-agnostic:
- Reusable across assistants:
  - `tool-schema.json` (tool definitions)
  - `starter/adapter.js` and `starter/dispatcher.js` (runtime/tool routing)
  - eval prompts in `evals/cases.json`
- Copilot-specific:
  - `SKILL.md` placement and discovery via `.copilot/skills/...`

Using with Claude generally means reusing the same tool schema/adapter logic, then wiring those tools and instructions into your Claude runtime or agent framework using its own configuration format.

## Runtime assumptions
- Region defaults: `us` (`https://teamswork.azure-api.net/ticketing/v1`)
- Typical timezone default: `-5`
- Node.js runtime: Node 18+ with ESM support. CI validates on Node 18 and Node 22.
- API key is provided via environment variable:
  - `ticketingAPIKey` (preferred in current scripts)
  - `TICKETING_API_KEY` (fallback)

## Reliability and safety test coverage
- Automated adapter tests run in CI and cover:
  - retry/backoff behavior for 429/5xx responses,
  - max-retry termination behavior,
  - transient network-failure retries,
  - API-key/token query-value redaction in error messages.
- Dispatcher write-safety behavior is covered by `dispatcher-dryrun.mjs` and CI syntax checks.

## Quick checks
```powershell
# Read-only smoke check
.\.copilot\skills\ticketing-api\starter\smoke-test.ps1 -Region us -Timezone -5 -Limit 3

# Dispatcher dry-run (no write)
node .\.copilot\skills\ticketing-api\starter\dispatcher-dryrun.mjs
```

## Live utility runs
```powershell
# Practical tool live run
node .\.copilot\skills\ticketing-api\starter\dispatcher-practical-tools-run.mjs

# Validation action live run
node .\.copilot\skills\ticketing-api\starter\dispatcher-validation-run.mjs
```
