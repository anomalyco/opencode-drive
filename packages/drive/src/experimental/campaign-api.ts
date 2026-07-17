import type { DriveContext } from "./drive.js"

export interface CampaignGenerateContext {
  readonly index: number
  readonly seed: number
  readonly artifacts: string
}

export interface CampaignPrepareContext<Flow> extends CampaignGenerateContext {
  readonly flow: Flow
}

export interface CampaignRunContext<Flow> extends CampaignPrepareContext<Flow>, DriveContext {}

export interface CampaignInstanceOptions {
  readonly state?: string
  readonly env?: Readonly<Record<string, string>>
  readonly command?: ReadonlyArray<string>
}

export interface CampaignDefinition<Flow = unknown, Result = unknown> {
  readonly count?: number
  readonly generate: (context: CampaignGenerateContext) => Flow | Promise<Flow>
  readonly prepare?: (context: CampaignPrepareContext<Flow>) => CampaignInstanceOptions | Promise<CampaignInstanceOptions>
  readonly run: (context: CampaignRunContext<Flow>) => Result | Promise<Result>
}

export interface DefinedCampaign<Flow = unknown, Result = unknown> extends CampaignDefinition<Flow, Result> {
  readonly kind: "opencode-drive/campaign"
}

export function defineCampaign<Flow, Result>(campaign: CampaignDefinition<Flow, Result>): DefinedCampaign<Flow, Result> {
  return { kind: "opencode-drive/campaign", ...campaign }
}
