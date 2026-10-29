import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
for (const path of ['index.js', 'client.js', 'cordis.patch.yml', 'LICENSE', 'README.md', 'README.zh-CN.md', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'docs/verification.md']) {
  await access(new URL(path, root))
}
assert.equal(pkg.name, 'dsh-composer-autocomplete')
assert.ok(pkg.dsh.bundle.patch)
const patch = await readFile(new URL(pkg.dsh.bundle.patch, root), 'utf8')
assert.ok(patch.includes('name: ' + pkg.name))
let definition
vm.runInNewContext(await readFile(new URL('client.js', root), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { definition = value } } },
})
assert.equal(definition.id, pkg.name)
assert.equal(typeof definition.factory, 'function')
const host = await import(new URL('index.js', root))
assert.equal(typeof host.apply, 'function')
console.log('Package entry points, client loader, bundle patch and required files verified.')
