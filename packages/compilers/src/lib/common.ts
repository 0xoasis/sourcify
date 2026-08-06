import path from 'path';
import { spawn } from 'child_process';
import { logDebug, logError, logSilly } from '../logger';
import type { OutputError } from '@ethereum-sourcify/compilers-types';

/**
 * Fetches a resource with an exponential timeout.
 * 1) Send req, wait backoff * 2^0 ms, abort if doesn't resolve
 * 2) Send req, wait backoff * 2^1 ms, abort if doesn't resolve
 * 3) Send req, wait backoff * 2^2 ms, abort if doesn't resolve...
 * ...
 * ...
 */
export async function fetchWithBackoff(
  resource: string,
  backoff: number = 10000,
  retries: number = 4,
) {
  let timeout = backoff;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      logSilly('Start fetchWithBackoff', { resource, timeout, attempt });
      const controller = new AbortController();
      const id = setTimeout(() => {
        logDebug('Aborting request', { resource, timeout, attempt });
        controller.abort();
      }, timeout);
      const response = await fetch(resource, {
        signal: controller.signal,
      });
      logSilly('Success fetchWithBackoff', { resource, timeout, attempt });
      clearTimeout(id);
      return response;
    } catch (error) {
      if (attempt === retries) {
        logError('Failed fetchWithBackoff', {
          resource,
          attempt,
          retries,
          timeout,
          error,
        });
        throw new Error(`Failed fetching ${resource}: ${error}`);
      } else {
        timeout *= 2; // exponential backoff
        logDebug('Retrying fetchWithBackoff', {
          resource,
          attempt,
          timeout,
          error,
        });
        continue;
      }
    }
  }
  throw new Error(`Failed fetching ${resource}`);
}

/**
 * Build a compiler artifact path under repoPath from a version-derived fileName.
 * Rejects path separators, traversal, and shell-metacharacter versions that could
 * escape the compiler cache dir or break spawn/execFile callers.
 *
 * OpenAPI CompilerVersion is intentionally loose (`^v?\d+\.\d+\.\d+.*$`); this is
 * the authoritative filesystem safety check.
 */
export function resolveCompilerArtifactPath(
  repoPath: string,
  fileName: string,
  version: string,
): string {
  assertSafeCompilerVersion(version);

  // fileName is built by us from platform + version; still verify it is a single segment.
  if (
    fileName.includes('\0') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..') ||
    path.basename(fileName) !== fileName
  ) {
    throw new Error(
      `Invalid compiler artifact name: ${JSON.stringify(fileName)}`,
    );
  }

  const resolvedRepo = path.resolve(repoPath);
  const resolvedPath = path.resolve(resolvedRepo, fileName);
  const repoPrefix = resolvedRepo.endsWith(path.sep)
    ? resolvedRepo
    : `${resolvedRepo}${path.sep}`;
  if (resolvedPath !== resolvedRepo && !resolvedPath.startsWith(repoPrefix)) {
    throw new Error(`Invalid compiler version: ${JSON.stringify(version)}`);
  }
  return resolvedPath;
}

/**
 * Allow only compiler version strings that are safe as a single path segment and
 * safe to embed near process arguments. `latest` is used by solc-js.
 */
export function assertSafeCompilerVersion(version: string): void {
  // Keep this aligned with real Solidity/Vyper/Fe tags we download, e.g.
  // 0.8.28+commit.7893614a, v0.3.10+commit.x, 0.4.1rc1, 26.0.0-alpha.12,
  // 0.8.17-nightly.2022.8.9+commit.6b60524c
  const SAFE_COMPILER_VERSION = /^(?:latest|v?\d+\.\d+\.\d+[0-9A-Za-z.+_-]*)$/;

  if (
    !version ||
    version.includes('\0') ||
    version.includes('..') ||
    version.includes('/') ||
    version.includes('\\') ||
    path.basename(version) !== version ||
    !SAFE_COMPILER_VERSION.test(version)
  ) {
    throw new Error(`Invalid compiler version: ${JSON.stringify(version)}`);
  }
}

export type AsyncExecOptions = {
  /** Optional working directory for the compiler subprocess. */
  cwd?: string;
};

/**
 * Run a compiler binary with argv (never a shell). `args` are passed directly to
 * spawn with shell disabled so the executable path cannot inject shell syntax.
 */
export function asyncExec(
  file: string,
  args: string[],
  inputStringified: string,
  maxBuffer: number,
  options: AsyncExecOptions = {},
): Promise<string> {
  // Input is untrusted JSON for the compiler stdin; validate before spawning.
  JSON.parse(inputStringified);

  // Resolve so a relative compiler path cannot be redirected by cwd sandboxing.
  const absoluteFile = path.resolve(file);

  return new Promise((resolve, reject) => {
    const child = spawn(absoluteFile, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;
    let stderrLen = 0;
    let killedForSize = false;

    const onChunk = (chunk: Buffer, which: 'stdout' | 'stderr') => {
      const s = chunk.toString();
      if (which === 'stdout') {
        stdoutLen += chunk.length;
        stdout += s;
      } else {
        stderrLen += chunk.length;
        stderr += s;
      }
      if (!killedForSize && stdoutLen + stderrLen > maxBuffer) {
        killedForSize = true;
        child.kill('SIGKILL');
      }
    };

    child.stdout?.on('data', (c) => onChunk(c, 'stdout'));
    child.stderr?.on('data', (c) => onChunk(c, 'stderr'));

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (killedForSize) {
        const err: NodeJS.ErrnoException = new Error(
          'Compilation output size too large',
        );
        err.code = 'ENOBUFS';
        reject(err);
        return;
      }
      if (signal) {
        reject(new Error(`Compiler process killed by signal ${signal}`));
        return;
      }
      if (code !== 0 && code !== null) {
        // Prefer stderr; fall back to stdout for compilers that print errors there.
        const detail = stderr || stdout;
        reject(
          new Error(
            `Compiler process returned with errors:\n ${detail || `exit ${code}`}`,
          ),
        );
        return;
      }
      if (stderr) {
        // Vyper compilers <0.4.0 outputs warnings to stderr
        if (stderr.startsWith('Warning:')) {
          resolve(stdout);
          return;
        }
        reject(new Error(`Compiler process returned with errors:\n ${stderr}`));
        return;
      }
      resolve(stdout);
    });

    if (!child.stdin) {
      reject(new Error('No stdin on child process'));
      return;
    }
    child.stdin.write(inputStringified);
    child.stdin.end();
  });
}

export class CompilerError extends Error {
  constructor(
    message: string,
    public errors: OutputError[],
  ) {
    super(message);
  }
}
