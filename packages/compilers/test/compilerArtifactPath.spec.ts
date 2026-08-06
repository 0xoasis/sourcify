import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertSafeCompilerVersion,
  asyncExec,
  resolveCompilerArtifactPath,
} from '../src/lib/common';
import { getSolcExecutable, getSolcJs } from '../src/lib/solidityCompiler';

describe('assertSafeCompilerVersion / resolveCompilerArtifactPath', () => {
  const repo = path.join('/tmp', 'compilers-artifact-repo');

  const accepted = [
    'latest',
    '0.8.28+commit.7893614a',
    'v0.3.10+commit.91361694',
    '0.4.1rc1',
    '26.0.0-alpha.12',
    '0.8.17-nightly.2022.8.9+commit.6b60524c',
    '0.8.17-ci.2022.8.9+commit.6b60524c',
  ];

  for (const version of accepted) {
    it(`accepts ${version}`, () => {
      expect(() => assertSafeCompilerVersion(version)).to.not.throw();
      const fileName = `solc-linux-amd64-v${version}`;
      // fileName for latest is not used this way; only check path helper with a simple name
      if (version === 'latest') {
        const resolved = resolveCompilerArtifactPath(
          repo,
          'soljson-latest.js',
          version,
        );
        expect(resolved).to.equal(path.resolve(repo, 'soljson-latest.js'));
      } else {
        const resolved = resolveCompilerArtifactPath(repo, fileName, version);
        expect(resolved).to.equal(path.resolve(repo, fileName));
      }
    });
  }

  it('rejects path traversal versions', () => {
    expect(() =>
      resolveCompilerArtifactPath(
        repo,
        'solc-linux-amd64-v0.8.28/../../../tmp/pwn',
        '0.8.28/../../../tmp/pwn',
      ),
    ).to.throw(/Invalid compiler version/);
  });

  it('rejects shell metacharacters in versions', () => {
    for (const version of [
      '0.8.28+commit.abc;echo PWNED',
      '0.8.28+commit.abc$(id)',
      '0.8.28+commit.abc|id',
      '0.8.28+commit.abc`id`',
      '0.8.28+commit.abc && id',
    ]) {
      expect(() => assertSafeCompilerVersion(version), version).to.throw(
        /Invalid compiler version/,
      );
    }
  });
});

describe('getSolcExecutable / getSolcJs path safety', () => {
  const compilersPath = path.join('/tmp', 'compilers-solc-repo-path-safety');
  const solJsonPath = path.join('/tmp', 'compilers-soljson-repo-path-safety');

  it('getSolcExecutable rejects escaping versions before fetch/write', async () => {
    try {
      await getSolcExecutable(
        compilersPath,
        'linux-amd64',
        '0.8.28/../../../tmp/pwn',
      );
      expect.fail('Expected invalid version to be rejected');
    } catch (e: any) {
      expect(e.message).to.match(/Invalid compiler version/);
    }
  });

  it('getSolcJs rejects escaping versions before fetch/write', async () => {
    try {
      await getSolcJs(solJsonPath, '0.8.28/../../../tmp/pwn');
      expect.fail('Expected invalid version to be rejected');
    } catch (e: any) {
      expect(e.message).to.match(/Invalid compiler version/);
    }
  });

  it('getSolcExecutable rejects shell-metacharacter versions', async () => {
    try {
      await getSolcExecutable(
        compilersPath,
        'linux-amd64',
        '0.8.28+commit.abc;echo PWNED',
      );
      expect.fail('Expected invalid version to be rejected');
    } catch (e: any) {
      expect(e.message).to.match(/Invalid compiler version/);
    }
  });
});

describe('asyncExec shell safety', () => {
  it('does not invoke a shell (semicolon is not command separator)', async () => {
    const marker = path.join(
      os.tmpdir(),
      `sourcify-asyncExec-inject-${process.pid}`,
    );
    try {
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
      // If shell were used, `;echo ...` would create marker. spawn must not.
      const evilPath = `/tmp/does-not-exist-${process.pid};echo INJECTED>${marker}`;
      try {
        await asyncExec(evilPath, ['--standard-json'], '{}', 1024 * 1024);
        expect.fail('Expected spawn of non-existent path to fail');
      } catch (e: any) {
        expect(
          e.code === 'ENOENT' || /ENOENT|not found|errors/i.test(e.message),
        ).to.equal(true);
      }
      expect(fs.existsSync(marker)).to.equal(false);
    } finally {
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
    }
  });
});
