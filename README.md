# TryMyDev

Hand this to your testers. They paste the address of a branch, a fork or a pull request, and
TryMyDev fetches the sources, builds them and starts the application — no Node, no Git, no
Python, no build tools on their machine.

```
https://github.com/owner/project/tree/feat/my-branch
https://github.com/someone/project/pull/42
owner/project@my-branch
```

Nothing has to be set up on your side either: no CI, no installer, no release per branch, and
it works on forks and on contributions from people outside your team.

## What a run does

1. **Resolve** — one conditional call to the GitHub API gives the branch's latest commit.
2. **Cache** — if that commit is already built, the application starts immediately: no
   download, no install, no build.
3. Otherwise: sources → manifest → runtimes → install → build → start.

Applications started in their own window keep running when TryMyDev closes, and show as
running again when it reopens. Branches are checked for new commits every quarter of an hour,
and a desktop shortcut can open one directly (Windows).

## The manifest

A manifest says how the project runs. TryMyDev looks for it in this order:

1. **`trymydev.json` committed in the repository**, read at the commit being tested — so a
   branch that changes its own build is tested exactly as it is.
2. **A manifest you hand to your testers**, pasted when they add the application. Nothing has
   to change in the repository, which is what makes this work on any project.
3. **A profile shipped with TryMyDev**, for a few well-known projects and their forks.
4. **Detection**, for ordinary npm and Python projects.

```json
{
  "name": "My App",
  "repo": "owner/project",
  "runtime": { "node": "22", "python": "3.13" },
  "install": [
    { "run": "npm install" },
    { "run": "pip install torch --extra-index-url https://download.pytorch.org/whl/cu130", "when": { "gpu": "nvidia" } },
    { "run": "pip install -r requirements.txt" }
  ],
  "build": [{ "run": "npm run build" }],
  "start": [
    { "mode": "web", "run": "python main.py --port {port}", "port": 8188, "when": { "gpu": "nvidia" } },
    { "mode": "web", "run": "python main.py --cpu --port {port}", "port": 8188 }
  ],
  "share": [{ "path": "models" }],
  "isolate": [{ "env": "MYAPP_HOME", "dir": "home" }],
  "cacheKeys": { "node": ["package-lock.json"], "python": ["requirements.txt"] }
}
```

| Field | What it does |
| --- | --- |
| `start.mode` | `electron` (own user-data dir), `web` (served, opened in a window), `command` |
| `start` as a list | Variants; the first whose `when` matches the machine is used |
| `when` | Runs a step, or picks a start, only on some machines: `platform` (`windows`, `macos`, `linux`) and `gpu` (`nvidia`, `amd`, `none`), one value or a list |
| `share` | Directories that belong to the application, not to one branch — models, caches |
| `isolate` | Variables redirected per branch, so two branches never write to the same place |
| `seed` | Files and links placed in the branch data folder before it starts — `{ "path", "json" }`, written once unless `"always": true`, or `{ "path", "link" }`. Strings may use `{data}`, `{shared}`, `{short}`, `{venv}`, `{documents}` and `{sha256:<file>}` — `{short}` is a folder near the top of the home directory, for Python trees too deep for the 260-character limit of Windows |
| `cacheKeys` | Files whose hash decides when an environment must be rebuilt |
| `{port}` | Replaced with a free port, so two branches run side by side |
| `runtime` | A Node version or range (`22`, `>=20`) and a Python version (`3.13`); latest release of that line |

Commands are split on spaces, honouring quotes, and run without a shell: no pipes, no `&&`,
no variable expansion — `.cmd` and `.bat` files included, whose arguments are escaped. Paths
in `share`, `isolate`, `seed` and `cwd` must stay inside the project or the data folder, and a
seed link must start with one of its folders.

## Safety

A manifest is a list of commands that run on the tester's computer, and the person running
them is usually not the person who wrote them.

- **Nothing runs unseen.** Before a manifest runs, TryMyDev shows the repository, every command
  that will run on this machine, every link and variable it sets up, and every download — and
  asks. It asks again whenever the manifest changes. Approving trusts that repository: its
  other branches and future commits run without asking while the commands stay the same.
- **An approval is for one repository's code.** Approving a project does not approve a fork or
  a pull request from someone else with the same manifest: that code asks again, with a warning
  that it does not come from the project itself.
- **Credentials stay with the tester.** Environment variables named like a token, a key, a
  secret or a password, and addresses carrying a password, are not passed to applications.
  `TRYMYDEV_PASS_ENV=HF_TOKEN,OTHER` passes the ones you choose. This keeps secrets from leaking
  by accident; it is no sandbox — approved code can read your files.
- **Only the TryMyDev page talks to TryMyDev.** Another file opened in its window — one dropped
  on it — is refused, and so are its calls.
- **Web applications are contained.** Their windows are sandboxed, keep their own cookies per
  branch, cannot use the camera, microphone or location, and send any other site to the
  browser. Only web addresses ever leave TryMyDev.
- **Runtimes are verified** — the default Node and uv against digests shipped in TryMyDev,
  others against their published checksums — and not run when that check is impossible.
- **The packaged launcher is locked**: it cannot be used as a Node interpreter, and only loads
  its own integrity-checked archive.

Running a branch still runs its code with your account — review who publishes what you test.

## Caches

| Cache | Key | Effect |
| --- | --- | --- |
| Build | commit | Nothing to do when the branch has not moved |
| `node_modules` | lockfile, Node version, install commands | Branches — and applications — sharing them share one install |
| Python environment | requirements, Python version, install commands | Complete venv per set; `uv` hardlinks the wheels, so a branch that changes one dependency costs almost nothing |
| Node runtime | version | Downloaded once, used by every application |
| Python and uv | version | Installed once by uv, used by every application |
| Downloads | — | uv, pip, npm and Electron caches, kept inside TryMyDev's own folder |
| `share` directories | application | Models and other heavy data live once per application |

Runtimes and content-addressed caches are global. Anything with a meaning inside one
application stays under that application. **Storage** shows what is used and removes what
nothing references any more — download caches included, when nothing is installing.

## Settings

A **GitHub token** is optional. Without one, GitHub allows 60 requests an hour and no private
repository; with one, 5,000 and the repositories it can read. Use a fine-grained token with
read-only access to contents and nothing more. It is checked with GitHub before it is kept, and
stored encrypted by the operating system — never where the system offers no real encryption.
That encryption is tied to your account, which the applications you approve run under too.

## Every tester's machine is different

What a tester set up for their own work does not change how a branch installs:

- `NODE_OPTIONS`, `NODE_ENV`, npm's `ignore-scripts` and `omit`, `PYTHONPATH`, `PYTHONHOME`,
  `PIP_USER`, uv's Python settings and activated virtual or conda environments are left out.
  A manifest that needs one sets it in `env`. Mirrors and registries (`ELECTRON_MIRROR`,
  `npm_config_registry`, `PIP_INDEX_URL`) are kept.
- Python runs in UTF-8 and unbuffered, without the tester's `pip install --user` packages.
- Downloads use the proxy, PAC file and certificates of the system; npm, pip and uv receive
  that proxy unless `HTTPS_PROXY` is already set. On a network that inspects encrypted traffic,
  set `UV_SYSTEM_CERTS=true` for uv.
- The PyTorch build follows the NVIDIA driver and GPU: CUDA 13 on a 580 driver from Turing on,
  CUDA 12.6 for older GPUs or drivers, CUDA 12.8 for Blackwell on a driver older than 580.
- On Windows, data goes to `%LOCALAPPDATA%\TryMyDev` — never Roaming, which a company network
  copies at each logon. A profile created in Roaming by an earlier version stays there.
- Downloads that stall are dropped and cancellable; files an antivirus holds are retried; a
  server gets as long as it needs to start, as long as it prints or serves something within
  five minutes; ports are checked on IPv4 and IPv6.
- GitHub archives include neither submodules nor Git LFS content; the approval says so.

## When something fails

The error pop-up carries the end of the log, and — for failures seen before, such as a
PyTorch without GPU support, a port already taken or a missing build toolchain — what to do
about it. Failures outside any branch go to TryMyDev's own log, `logs/main.log`. An unreadable
`registry.json` is reported and left untouched: nothing is deleted until it is repaired.

## What it cannot do

Honest limits, independent of the language:

- **Native compilation** — a project needing a C/C++ toolchain, node-gyp or Rust requires
  that toolchain on the tester's machine. Prebuilt binaries are fine; compiling is not.
- **External services** — Postgres, Redis, docker-compose.
- **Secrets** — an application needing API keys does not start from a URL alone.
- **pnpm, yarn and bun** are not provided: their `node_modules` rely on links that moving the
  tree into the shared store would break. A manifest can still drive them if they are
  installed.

## Development

```bash
npm install
npm run dev
npm run typecheck
npm test               # unit tests; TRYMYDEV_NETWORK_TESTS=1 adds the download test
npm run test:e2e       # builds, then drives the real window
npm run package        # Windows; package:mac and package:linux for the others
```

Open one branch directly:

```bash
trymydev --start=owner/project@my-branch
```

## File layout

```
<TryMyDev userData>/
  registry.json                    applications, branches and approvals
  settings.json                    GitHub token, encrypted
  logs/main.log                    TryMyDev's own log
  apps/<app>/branches/<ref-hash>/  checkout, data, logs, state
  apps/<app>/shared/               shared directories of that application
  store/node/<version>             Node runtimes
  store/pythons/                   Python runtimes, managed by uv
  store/uv/<version>               uv
  store/cache/<tool>               uv, pip, npm and Electron download caches
  store/node-deps/<hash>/node_modules
  store/venvs/<hash>               Python environments
  store/shims/<runtime>            node / npm / npx wrappers, one set per runtime
```

`<TryMyDev userData>` is `%LOCALAPPDATA%\TryMyDev` on Windows (`%APPDATA%\TryMyDev` for a profile
created by an earlier version), `~/Library/Application Support/TryMyDev` on macOS and
`~/.config/TryMyDev` on Linux.

MIT.
