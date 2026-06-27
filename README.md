# codex-token-burner

A small Bun CLI whose job is exactly what it says: burn down your Codex usage window by launching unattended Codex runs until the 5-hour allowance is almost gone.

It still includes status commands for reading local Codex rate limits, but those are supporting machinery. The main `run` command is a token burner: check the local Codex usage window, pick a prompt, launch `codex exec`, log the run, then repeat until the configured remaining-usage threshold is reached.

Under the hood it uses Codex's local app-server protocol: launch `codex app-server`, send JSON-RPC `account/rateLimits/read`, and compute remaining as `100 - usedPercent`.

## Requirements

- Bun
- Codex CLI installed and logged in

## Usage

```bash
bun src/index.ts
bun src/index.ts run
bun src/index.ts run --dry-run
bun src/index.ts status
bun src/index.ts status five-hour
bun src/index.ts status weekly
bun src/index.ts raw
```

The default command is `run`.

`run` checks the 5-hour Codex usage window. If more than 5% remains, it reads a prompt from `data/project-prompts.json`, creates a metadata/log directory under `runs/`, and launches:

```bash
codex --search exec --skip-git-repo-check -a never -s danger-full-access
```

The prompt is sent with `/goal` as the first line. Codex is instructed to build the app in a unique project directory under `/tmp`. After Codex exits or appears frozen, the burner checks usage again and repeats until the 5-hour remaining percentage is at or below the threshold.

`status five-hour` and `status weekly` print only the remaining percentage as a number, suitable for use in other scripts.

Aliases:

- `five-hour`, `fivehour`, `5h`, `primary`
- `weekly`, `week`, `7d`, `secondary`

## Burner Controls

- `CODEX_MIN_FIVE_HOUR_REMAINING`: stop threshold, default `5`
- `CODEX_RUN_IDLE_TIMEOUT_MINUTES`: kill a silent Codex run, default `20`
- `CODEX_RUN_MAX_RUNTIME_MINUTES`: kill a long Codex run, default `90`
- `CODEX_RUN_MAX_CYCLES`: optional cap for testing, default unlimited
- `CODEX_RUN_DRY_RUN=1`: select a prompt and create a run directory without launching Codex
- `CODEX_RUN_ROOT`: run directory root, default `./runs`
- `CODEX_RUN_CODEX_WORKDIR`: Codex working directory, default `/tmp`
- `CODEX_RUN_MODEL`: optional Codex model override
- `CODEX_RUN_RETRY_DELAY_SECONDS`: delay between cycles, default `5`

## Project Prompts

`data/project-prompts.json` contains one headless-ready prompt. It tells Codex to search today's news, choose an interesting story, and build a related app in `/tmp`.

## Notes

This depends on Codex's local app-server protocol, which is not a public stable API. If Codex changes `account/rateLimits/read`, this tool may need updating.

Use this only when you intentionally want unattended Codex usage burn. It is not a productivity wrapper, scheduler, benchmark harness, or budget saver.
