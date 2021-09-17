import { RemotesConfig, VitePluginFederationOptions } from 'types'
import { walk } from 'estree-walker'
import MagicString from 'magic-string'
import { AcornNode } from 'rollup'
import { PluginHooks } from '../types/pluginHooks'
import { parseOptions } from './utils'
import {
  InputOptions,
  MinimalPluginContext,
  TransformPluginContext
} from 'rollup'

export let devProvidedRemotes

export function devRemotesPlugin(
  options: VitePluginFederationOptions
): PluginHooks {
  console.log(`The current operating mode is ${options.mode}`)
  devProvidedRemotes = parseOptions(
    options.remotes ? options.remotes : {},
    (item) => ({
      external: Array.isArray(item) ? item : [item],
      shareScope: options.shareScope || 'default'
    }),
    (item) => ({
      external: Array.isArray(item.external) ? item.external : [item.external],
      shareScope: item.shareScope || options.shareScope || 'default'
    })
  )

  const remotes: { id: string; config: RemotesConfig }[] = []
  for (const item of devProvidedRemotes) {
    remotes.push({ id: item[0], config: item[1] })
  }

  return {
    name: 'originjs:devRemotes',
    virtualFile: {
      __federation__: `
            const remotesMap = {
              ${remotes
                .map(
                  (remote) =>
                    `${JSON.stringify(
                      remote.id
                    )}: () => import(${JSON.stringify(
                      remote.config.external[0]
                    )})`
                )
                .join(',\n  ')}
            };
            const processModule = (mod) => {
              if (mod && mod.__useDefault) {
                return mod.default;
              }
              return mod;
            }
 
            const initMap = {};
            export default {
              ensure: async (remoteId) => {
                const remote = await remotesMap[remoteId]();
                if (!initMap[remoteId]) {
                  // remote.init(shareScope);
                  initMap[remoteId] = true;
                }
                return remote;
              }
            };`
    },
    options(this: MinimalPluginContext, options: InputOptions) {
      console.log(this)
      console.log(options)
      // TODO need to include remotes in the optimizeDeps.exclude
      return options
    },
    transform(
      this: TransformPluginContext,
      code: string,
      id: string,
      ssr?: boolean | undefined
    ) {
      if (remotes.length === 0 || id.includes('node_modules')) {
        return null
      }
      if (!/import/.test(code)) {
        return null
      }

      let ast: AcornNode | null = null
      try {
        ast = this.parse(code)
      } catch (err) {
        console.error(err)
      }
      if (!ast) {
        return null
      }

      const magicString = new MagicString(code)
      let requiresRuntime = false
      walk(ast, {
        enter(node: any) {
          if (node.type === 'ImportExpression') {
            if (node.source && node.source.value) {
              const moduleId = node.source.value
              const remote = remotes.find((r) => moduleId.startsWith(r.id))

              if (remote) {
                requiresRuntime = true
                const modName = `.${moduleId.slice(remote.id.length)}`

                magicString.overwrite(
                  node.start,
                  node.end,
                  `__federation__.ensure(${JSON.stringify(
                    remote.id
                  )}).then((remote) => remote.get(${JSON.stringify(modName)}))`
                )
              }
            }
          }
        }
      })

      if (requiresRuntime) {
        magicString.prepend(`import __federation__ from '__federation__';\n\n`)
      }

      return {
        code: magicString.toString(),
        map: null
      }
    }
  }
}
