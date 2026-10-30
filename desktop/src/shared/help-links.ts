export const helpLinks = {
  account: 'https://openrouter.ai/',
  keys: 'https://openrouter.ai/keys',
  models: 'https://openrouter.ai/models',
  credits: 'https://openrouter.ai/settings/credits',
  quickstart: 'https://openrouter.ai/docs/quickstart',
  limits: 'https://openrouter.ai/docs/api-reference/limits'
} as const
export type HelpLink = keyof typeof helpLinks
