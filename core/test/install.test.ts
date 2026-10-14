import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")
let tmp: string
let repo: string
let prefix: string
let fakeBin: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fdbk-install-"))
  repo = join(realpathSync(tmp), "my repo")
  prefix = join(tmp, "prefix")
  fakeBin = join(tmp, "fakebin")
  mkdirSync(repo)
  mkdirSync(fakeBin)
  cpSync(join(root, "install.sh"), join(repo, "install.sh"))
  cpSync(join(root, "man"), join(repo, "man"), { recursive: true })
  writeFileSync(
    join(fakeBin, "bun"),
    `#!/bin/sh\nif [ "$*" = "run compile" ]; then mkdir -p dist && printf '#!/bin/sh\\n' > dist/fdbk && chmod +x dist/fdbk; fi\n`,
  )
  chmodSync(join(fakeBin, "bun"), 0o755)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function install(...args: string[]) {
  const r = spawnSync("sh", [join(repo, "install.sh"), ...args], {
    cwd: tmp,
    env: { PATH: `${fakeBin}:/usr/bin:/bin`, HOME: tmp, PREFIX: prefix },
    encoding: "utf8",
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

const links = () => ({
  [join(prefix, "bin/fdbk")]: join(repo, "dist/fdbk"),
  [join(prefix, "bin/git-feedback")]: join(repo, "dist/fdbk"),
  [join(prefix, "share/man/man1/fdbk.1")]: join(repo, "man/man1/fdbk.1"),
  [join(prefix, "share/man/man1/git-feedback.1")]: join(repo, "man/man1/git-feedback.1"),
})

test("builds and links the binary and man pages, and can run again", () => {
  const first = install()
  expect(first.code, first.out).toBe(0)
  expect(existsSync(join(repo, "dist/fdbk"))).toBe(true)
  for (const [link, target] of Object.entries(links())) expect(readlinkSync(link)).toBe(target)

  const second = install()
  expect(second.code, second.out).toBe(0)
  for (const [link, target] of Object.entries(links())) expect(readlinkSync(link)).toBe(target)
})

test("refuses to replace a file that isn't a symlink", () => {
  mkdirSync(join(prefix, "bin"), { recursive: true })
  writeFileSync(join(prefix, "bin/fdbk"), "mine")
  const r = install()
  expect(r.code).not.toBe(0)
  expect(r.out).toContain(join(prefix, "bin/fdbk"))
  expect(lstatSync(join(prefix, "bin/fdbk")).isSymbolicLink()).toBe(false)
})

test("refuses to replace a symlink to somewhere else", () => {
  mkdirSync(join(prefix, "bin"), { recursive: true })
  symlinkSync(join(tmp, "elsewhere/fdbk"), join(prefix, "bin/fdbk"))
  const r = install()
  expect(r.code).not.toBe(0)
  expect(r.out).toContain(join(prefix, "bin/fdbk"))
  expect(readlinkSync(join(prefix, "bin/fdbk"))).toBe(join(tmp, "elsewhere/fdbk"))
})

test("fails clearly without bun", () => {
  rmSync(join(fakeBin, "bun"))
  const r = install()
  expect(r.code).not.toBe(0)
  expect(r.out).toContain("bun")
})

test("--uninstall removes only links into this checkout", () => {
  expect(install().code).toBe(0)
  const r = install("--uninstall")
  expect(r.code, r.out).toBe(0)
  for (const link of Object.keys(links())) expect(lstatExists(link)).toBe(false)

  expect(install("--uninstall").code).toBe(0)
})

test("--uninstall leaves files it didn't create", () => {
  mkdirSync(join(prefix, "bin"), { recursive: true })
  writeFileSync(join(prefix, "bin/fdbk"), "mine")
  symlinkSync(join(tmp, "elsewhere/fdbk"), join(prefix, "bin/git-feedback"))
  expect(install("--uninstall").code).toBe(0)
  expect(existsSync(join(prefix, "bin/fdbk"))).toBe(true)
  expect(readlinkSync(join(prefix, "bin/git-feedback"))).toBe(join(tmp, "elsewhere/fdbk"))
})

test("rejects unknown arguments", () => {
  const r = install("--bogus")
  expect(r.code).not.toBe(0)
  expect(r.out).toContain("Usage")
})

function lstatExists(p: string) {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}
