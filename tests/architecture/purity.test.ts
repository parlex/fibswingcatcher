import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FORBIDDEN = ['viem', 'better-sqlite3', 'grammy', 'node:fs', 'node:net', 'pino']
const PURE_DIRS = ['src/bars', 'src/strategy', 'src/alerts/format.ts']

function filesIn(path: string): string[] {
  const stat = statSync(path)
  if (stat.isFile() && path.endsWith('.ts')) {
    return [path]
  }
  if (!stat.isDirectory()) return []
  let out: string[] = []
  for (const e of readdirSync(path)) {
    const p = join(path, e)
    if (statSync(p).isDirectory()) out = out.concat(filesIn(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('renhet i strategilaget', () => {
  for (const path of PURE_DIRS) {
    it(`${path} importerer ingen IO`, () => {
      for (const file of filesIn(path)) {
        const src = readFileSync(file, 'utf8')
        for (const mod of FORBIDDEN) {
          expect(src, `${file} importerer ${mod}`).not.toMatch(
            new RegExp(`from\\s+['"]${mod}`),
          )
        }
      }
    })
  }
})
