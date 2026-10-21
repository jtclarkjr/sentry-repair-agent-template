import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { createGitHubClient } from '../../../lib/github/client'
import { repositories } from '../../../lib/registry'
import { quote } from '../../../lib/repair/candidate'
export default defineTool({
  description:
    'Prepare a clean repository snapshot at the authorized base commit. Run this once before investigating.',
  inputSchema: z.object({
    repositoryId: z.string(),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/)
  }),
  async execute({ repositoryId, baseSha }, ctx) {
    const repo = repositories.find((repo) => repo.id === repositoryId)
    if (!repo || ctx.session.auth.current?.attributes.repositoryId !== repo.id)
      throw new Error('Repository scope mismatch')
    const sandbox = await ctx.getSandbox()
    const existing = await sandbox.run({
      command: 'test ! -d /workspace/repo/.git'
    })
    if (existing.exitCode !== 0)
      return { baseSha, path: '/workspace/repo', status: 'already-prepared' }
    const source = await createGitHubClient().source(repo, baseSha)
    await sandbox.writeTextFile({
      path: 'source.tar.gz.b64',
      content: source.archive.toString('base64')
    })
    const result = await sandbox.run({
      command: `mkdir -p repo && base64 -d source.tar.gz.b64 | tar -xz -C repo --strip-components=1 && rm source.tar.gz.b64 && git -C repo init -q && git -C repo add . && git -C repo -c user.name=Agent -c user.email=agent@localhost commit -qm ${quote(baseSha)}`
    })
    if (result.exitCode !== 0)
      throw new Error('Could not initialize source snapshot')
    return {
      baseSha,
      path: '/workspace/repo',
      setupCommands: repo.setupCommands,
      checkCommands: repo.checkCommands
    }
  }
})
