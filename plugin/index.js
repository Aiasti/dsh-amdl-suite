import { Config } from './lib/config-schema.js'
import { registerMatchTool } from './tools/match.js'
import { registerSetupTool } from './tools/setup.js'

export const inject = ['tools', 'jobs']

export { Config }

export function apply(ctx, config) {
  registerSetupTool(ctx, config)
  registerMatchTool(ctx, config)
}