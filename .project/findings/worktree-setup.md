# Worktree setup

Setup broke in fish: trust ran, env copy worked, bare npx failed with exit 127.
Repo pins Node 24.15.0 and pnpm 11.8.0 in mise.toml. No npx needed.

Fix in t3.json: trust local mise.toml, run each tool with mise exec.
Use && so failed trust or env copy blocks install. No interactive PATH hook needed.
Do not change global fish config or trust every worktree directory.

Recovery target: /home/tnfssc/.t3/worktrees/zevium/t3-2533c64d.
Code fix lives in /home/tnfssc/.t3/worktrees/zevium/t3-24e0054d.
Recovery installs deps only; no tracked edits in target worktree.
Env copy was already done by user. Recovery outside T3 context skips copy.

Checks: env-copy + bootstrap tests pass (4/4). Bare-PATH fish --no-config
resolves Node v24.15.0 and pnpm 11.8.0 through mise exec. Recovery install
finished exit 0 with frozen lockfile; already up to date.

Values unchanged: values.md absent. Small setup fix, not repeated product
lesson. Keep tool PATH detail here rather than invent broad values.
No commit or push asked.
