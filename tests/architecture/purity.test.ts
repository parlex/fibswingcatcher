import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FORBIDDEN = ['viem', 'better-sqlite3', 'grammy', 'node:fs', 'node:net', 'pino']
const PURE_DIRS = ['src/bars', 'src/strategy']

function filesIn(dir: string): string[] {
  let out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out = out.concat(filesIn(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('renhet i strategilaget', () => {
  for (const dir of PURE_DIRS) {
    it(`${dir} importerer ingen IO`, () => {
      for (const file of filesIn(dir)) {
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
