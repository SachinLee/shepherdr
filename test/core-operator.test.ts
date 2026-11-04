import { expect, test } from 'bun:test'
import { mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CoreSource } from '../server/core/source.ts'
import { operatorRequest, startOperator } from '../server/core/operator.ts'

// The POSIX half. Windows has no private socket with a 0600 mode; its operator is a named pipe with a protected DACL,
// verified in test/core-windows-operator.test.ts.
test.skipIf(process.platform === 'win32')('private operator socket writes via the server vault and refuses insecure socket permissions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-op-'))
  const source = new CoreSource({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' })
  const operator = await startOperator(source, randomUUID())
  try {
    expect(await operatorRequest(home, operator.path, ['secret', 'set', 'DEMO'], 'operator-fixture')).toEqual({ code: 0, out: 'Saved DEMO for Everywhere.\n' })
    expect(source.secrets.vault.has('all', 'DEMO')).toBe(true)
    expect((await operatorRequest(home, operator.path, ['secret', 'rm', 'DEMO'])).code).toBe(0)
    expect(source.secrets.vault.has('all', 'DEMO')).toBe(false)
    chmodSync(operator.path, 0o666)
    await expect(operatorRequest(home, operator.path, ['secret', 'rm', 'DEMO'])).rejects.toThrow('private')
    chmodSync(operator.path, 0o600)
    expect((await operatorRequest(home, operator.path, ['secret', 'set', 'BAD', 'command-word-value'])).code).toBe(1)
  } finally { operator.close(); source.stop(); source.mailbox.close(); source.store.close(); rmSync(home, { recursive: true, force: true }) }
})
