import { z } from 'zod'
import { flowAssessmentSchema, rootCauseSchema } from '../incidents/model'

export const candidateSchema = z.object({
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  rootCause: rootCauseSchema,
  flows: z.array(flowAssessmentSchema).max(10),
  patch: z.string().max(250_000),
  regressionPatch: z.string().max(100_000),
  regressionPath: z.string().max(240),
  runner: z.enum(['bun', 'vitest', 'playwright']),
  expectedFailure: z.string().min(8).max(200),
  browserRequired: z.boolean(),
  browserCovered: z.boolean(),
  blocker: z.string().max(2000).nullable()
})
export type Candidate = z.infer<typeof candidateSchema>

export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export function safePath(path: string) {
  return (
    path.length <= 240 &&
    /^[a-zA-Z0-9_@()./+\[\] -]+$/.test(path) &&
    !path.startsWith('/') &&
    !path
      .split('/')
      .some(
        (part) => !part || part === '..' || part === '.' || part === '.git'
      ) &&
    !/(^|\/)(?:\.env[^/]*|\.github|\.storybook|\.npmrc|\.yarnrc[^/]*|\.gitmodules|\.gitignore|node_modules|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|package(?:-lock)?\.json|scripts|reports|AGENTS\.md|CLAUDE\.md)(?:\/|$)/.test(
      path
    ) &&
    !/(?:^|\/)(?:vitest|playwright|vite|tsconfig|next\.config|bunfig)[^/]*\.(?:[cm]?[jt]s|json|toml)$/.test(
      path
    )
  )
}

type PatchChange = { path: string; kind: 'add' | 'modify' | 'delete' }
function parsePatch(patch: string): PatchChange[] {
  if (!patch.startsWith('diff --git '))
    throw new Error('A complete git unified diff is required')
  const changes = patch
    .split(/(?=^diff --git )/m)
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n')
      const hunk = lines.findIndex((line) => line.startsWith('@@ '))
      if (hunk < 0) throw new Error('Each patch file requires a text hunk')
      const metadata = lines.slice(0, hunk)
      if (
        metadata.some((line) =>
          /^(?:GIT binary patch|Binary files |rename |copy |old mode |new mode )/.test(
            line
          )
        ) ||
        metadata.some((line) => {
          const mode = line.match(
            /^(?:(?:new file|deleted file) mode |index \S+ )(\d+)$/
          )?.[1]
          return mode !== undefined && mode !== '100644'
        })
      ) {
        throw new Error(
          'Binary, renamed, copied, or non-regular files require manual review'
        )
      }
      const before = metadata.filter((line) => line.startsWith('--- '))
      const after = metadata.filter((line) => line.startsWith('+++ '))
      if (before.length !== 1 || after.length !== 1)
        throw new Error('Each patch file requires exactly one old and new path')
      const oldPath =
        before[0] === '--- /dev/null'
          ? null
          : before[0].match(/^--- a\/(.+)$/)?.[1]
      const newPath =
        after[0] === '+++ /dev/null'
          ? null
          : after[0].match(/^\+\+\+ b\/(.+)$/)?.[1]
      if (
        oldPath === undefined ||
        newPath === undefined ||
        (!oldPath && !newPath) ||
        (oldPath && newPath && oldPath !== newPath)
      )
        throw new Error('Patch paths are invalid or renamed')
      const path = newPath ?? oldPath!
      if (
        !safePath(path) ||
        lines[0] !== `diff --git a/${oldPath ?? path} b/${newPath ?? path}`
      )
        throw new Error('Patch changes protected or inconsistent paths')
      const kind =
        oldPath === null ? 'add' : newPath === null ? 'delete' : 'modify'
      if (kind === 'add' && !metadata.includes('new file mode 100644'))
        throw new Error('New files must be regular text files')
      return { path, kind } as PatchChange
    })
  if (
    !changes.length ||
    new Set(changes.map((change) => change.path)).size !== changes.length
  )
    throw new Error('Repeated or missing patch paths')
  return changes
}

export function patchPaths(candidate: Candidate): string[] {
  return [
    ...parsePatch(candidate.patch),
    ...parsePatch(candidate.regressionPatch)
  ].map((change) => change.path)
}

export function validateCandidate(candidate: Candidate) {
  if (candidate.blocker) throw new Error(candidate.blocker)
  if (!candidate.patch.trim() || !candidate.regressionPatch.trim())
    throw new Error('A fix and a separate regression test are required')
  if (
    !safePath(candidate.regressionPath) ||
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(candidate.regressionPath)
  )
    throw new Error('Regression must be a new test file in an allowed path')
  if (
    candidate.browserRequired &&
    (!candidate.browserCovered || candidate.runner !== 'playwright')
  )
    throw new Error(
      'Affected browser flow requires an actual Playwright regression'
    )
  const repair = parsePatch(candidate.patch)
  const regression = parsePatch(candidate.regressionPatch)
  if (
    regression.length !== 1 ||
    regression[0].path !== candidate.regressionPath ||
    regression[0].kind !== 'add'
  )
    throw new Error('Regression patch must only add its named test')
  if (
    repair.some((change) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(change.path))
  )
    throw new Error('Repair patch cannot modify or delete tests')
  if (repair.some((change) => change.path === candidate.regressionPath))
    throw new Error('Repair and regression paths must be disjoint')
  if (repair.length + regression.length > 30)
    throw new Error('Repair changes too many files')
}

export function regressionCommand(candidate: Candidate) {
  const path = quote(candidate.regressionPath)
  if (candidate.runner === 'bun') return `bun test ${path}`
  if (candidate.runner === 'vitest') return `bun x vitest run ${path}`
  return `bun x playwright test ${path} --workers=1`
}
