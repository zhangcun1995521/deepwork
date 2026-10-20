/**
 * The environment a language server is started with.
 *
 * A language server is the one third-party binary this repository launches on behalf of a model, so
 * what reaches it is a boundary and not a convenience. These tests are here because the scrub was
 * copied from the host's subprocess policy and lost half of it: the credential half survived, the
 * harness-identity half did not, and nothing noticed — a copy with no test drifts exactly this way.
 *
 * @module @zhangcun123/lsp/connection.test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { launchEnvironment } from './connection.ts'

test('a language server is not handed credentials or the harness identity', () => {
  const environment = launchEnvironment(
    {},
    {
      PATH: '/usr/bin',
      HOME: '/home/dev',
      LANG: 'en_GB.UTF-8',
      // The credential half, which the first version already scrubbed.
      DEEPSEEK_API_KEY: 'sk-do-not-leak',
      GITHUB_TOKEN: 'ghp-nope',
      DB_PASSWORD: 'hunter2',
      // The harness-identity half, which it did not: deployment facts (home, domain root, mode) are
      // not a third-party binary's business, and a harness that leaks them has one boundary less
      // than it claims. Lowercase too, because Windows environment names are case-insensitive.
      DSH_HOME: '/home/dev/.dsh',
      DSH_PERMISSION_MODE: 'workspace-write',
      dsh_ontology_root: '/srv/domain',
    },
  )

  assert.deepEqual(Object.keys(environment).sort(), ['HOME', 'LANG', 'PATH'])
})

test('an explicit override still reaches the server', () => {
  // Scrubbing before the merge is the point: a deployment that means to pass one of these names in
  // can, and it does not reopen the ambient environment to do it.
  const environment = launchEnvironment({ DSH_MODE: 'explicit' }, { PATH: '/usr/bin', DSH_HOME: '/x' })
  assert.equal(environment.PATH, '/usr/bin')
  assert.equal(environment.DSH_MODE, 'explicit')
  assert.equal(environment.DSH_HOME, undefined)
})
