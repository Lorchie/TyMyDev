/** Failures seen often enough to tell the tester what to do about them. First match wins. */
const HINTS: { pattern: RegExp; hint: (match: RegExpMatchArray) => string }[] = [
  {
    pattern: /Torch not compiled with CUDA enabled/,
    hint: () =>
      'PyTorch was installed without GPU support. The manifest should install torch from the ' +
      'PyTorch index of the GPU before the other requirements — or start the application in ' +
      'CPU mode, if it has one.'
  },
  {
    pattern: /no kernel image is available for execution on the device|is not compatible with the current PyTorch installation/,
    hint: () =>
      'This build of PyTorch does not support this GPU. TryMyDev picks the build from the NVIDIA driver: ' +
      'updating the driver (580 or later) and starting again installs a matching one — or start ' +
      'the application in CPU mode, if it has one.'
  },
  {
    pattern: /No CUDA GPUs are available|Found no NVIDIA driver|CUDA driver version is insufficient/,
    hint: () =>
      'No usable NVIDIA GPU or driver was found. Update the NVIDIA driver, or start the ' +
      'application in CPU mode if it has one.'
  },
  {
    pattern: /EADDRINUSE|address already in use|Only one usage of each socket address/i,
    hint: () =>
      'The port is already taken, often by another copy of the application. Stop it, or let ' +
      'the manifest use {port} so that every run gets a free one.'
  },
  {
    pattern: /gyp ERR!|MSBuild|Microsoft Visual C\+\+ [\d.]+ or greater is required|xcrun: error/,
    hint: () =>
      'A dependency compiles native code, which needs build tools TryMyDev does not provide — ' +
      'Visual Studio Build Tools on Windows, Xcode on macOS.'
  },
  {
    pattern: /ENAMETOOLONG|path too long|The filename or extension is too long/i,
    hint: () =>
      'A path is longer than Windows allows by default (260 characters). Enabling long paths ' +
      'in Windows (LongPathsEnabled) removes the limit.'
  },
  {
    pattern: /ENOSPC|No space left on device|not enough space on the disk/i,
    hint: () => 'The disk is full. Storage shows what TryMyDev can remove.'
  },
  {
    pattern: /EBUSY|resource busy or locked|being used by another process/i,
    hint: () =>
      'A file is held by another program — often a copy of the application still running. ' +
      'Close it and try again.'
  },
  {
    pattern: /blocked by group policy|blocked by your system administrator|Smart App Control|spawn \S+ (EACCES|UNKNOWN)/i,
    hint: () =>
      'Windows refused to start a program TryMyDev downloaded. A company policy (AppLocker, Smart App ' +
      'Control) or an antivirus does that for programs in AppData: an administrator can allow the ' +
      'TryMyDev data folder.'
  },
  {
    pattern: /invalid load key, 'v'|version https:\/\/git-lfs\.github\.com\/spec/,
    hint: () =>
      'A file stored with Git LFS arrived as a pointer: GitHub archives do not include LFS content. ' +
      'The developer has to publish those files another way, such as a download at install time.'
  },
  {
    pattern: /exit code 9009|is not recognized as an internal or external command|spawn \S+ ENOENT/,
    hint: () =>
      'A program the manifest runs is not on this computer. TryMyDev provides node, npm, npx, python, ' +
      'pip and uv; anything else — git, cmake, a compiler — must be installed by the tester.'
  },
  {
    pattern: /ModuleNotFoundError: No module named '([^']+)'/,
    hint: (m) => `The Python module "${m[1]}" is missing: the requirements the manifest installs do not include it.`
  },
  {
    pattern: /Cannot find module '([^']+)'/,
    hint: (m) => `The Node module "${m[1]}" is missing: the install or build steps did not produce it.`
  },
  {
    pattern:
      /unable to get local issuer certificate|self[- ]signed certificate in certificate chain|UNABLE_TO_VERIFY_LEAF_SIGNATURE|invalid peer certificate|CERTIFICATE_VERIFY_FAILED|ERR_CERT_AUTHORITY_INVALID/i,
    hint: () =>
      'A download was refused over a certificate the tools do not know — usually a company network ' +
      'inspecting encrypted traffic. npm already trusts the certificates of the system; for uv, set ' +
      'UV_SYSTEM_CERTS=true in your environment and restart TryMyDev.'
  },
  {
    pattern: /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|getaddrinfo|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|connection was dropped/,
    hint: () => 'A download failed on the network. Check the connection — or a proxy — and try again.'
  }
]

export function hintFor(text: string): string | undefined {
  for (const { pattern, hint } of HINTS) {
    const match = text.match(pattern)
    if (match) return hint(match)
  }
  return undefined
}

/** The tail an error pop-up shows: long lines cut, so the part that matters stays readable. */
export function tidyTail(tail: string, width = 300): string {
  return tail
    .split('\n')
    .map((line) => (line.length > width ? `${line.slice(0, width)} …` : line))
    .join('\n')
}
