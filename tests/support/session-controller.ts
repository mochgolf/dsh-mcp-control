import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type {
  AdmittedPromptContentPart,
  AttachmentAdmissionPart,
  ImageAttachmentLimits,
} from '@deepseek-ai/dsh-attachment'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { vi } from 'vitest'
import { TestSessionQuery } from './session-query.ts'

/** Dependencies and policy supplied by the MCP endpoint test harness. */
export interface TestSessionControllerDefaults {
  readonly defaultModelSelection: () => ModelSelection
  readonly cwd: string
}

const installed = new WeakMap<Context, SessionController>()

const TEST_IMAGE_LIMITS: ImageAttachmentLimits = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png'] as const),
})

/** Build or return the production Session Controller used by the endpoint tests. */
export function createSessionTestController(
  ctx: Context,
  defaults: TestSessionControllerDefaults,
): SessionController {
  const found = installed.get(ctx)
  if (found !== undefined) return found

  if (ctx.get('typert') === undefined) {
    const dispose = (): void => {}
    ctx.provide('typert', {
      lookups: { configure: () => dispose },
      contexts: { configureHost: () => dispose },
    } as never)
  }
  if (ctx.get('agentDefaultModel') === undefined) {
    ctx.provide('agentDefaultModel', {
      currentSelection: defaults.defaultModelSelection,
      saveSelection: async () => {},
    } as never)
  }
  if (ctx.get('llm') === undefined) {
    ctx.provide('llm', {
      listProviders: () => {
        const selection = defaults.defaultModelSelection()
        return [{ id: selection.provider, name: selection.provider }]
      },
    } as never)
  }
  if (ctx.get('attachments') === undefined) {
    ctx.provide('attachments', {
      imageLimits: TEST_IMAGE_LIMITS,
      admitPromptContent: async (
        content: readonly AttachmentAdmissionPart[],
      ): Promise<AdmittedPromptContentPart[]> => {
        const admitted: AdmittedPromptContentPart[] = []
        for (const part of content) {
          if (part.type === 'image') throw new Error('test did not configure image persistence')
          admitted.push(part)
        }
        return admitted
      },
    } as never)
  }
  if (ctx.get('fileUploads') === undefined) {
    ctx.provide('fileUploads', {
      registerAgentResolver: () => () => {},
      resolve: () => undefined,
      bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
      retirePrompt: () => {},
    } as never)
  }
  if (ctx.get('sessionProjections') === undefined) new SessionProjectionRegistry(ctx)
  if (ctx.get('sessionQuery') === undefined) new TestSessionQuery(ctx)

  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(defaults.cwd)
  let controller: SessionController
  try {
    controller = new SessionController(ctx, {})
  } finally {
    cwd.mockRestore()
  }
  installed.set(ctx, controller)
  return controller
}
