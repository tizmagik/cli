import {prepareStoreExecuteRequest} from './request.js'
import {
  ABORTED_FETCH_MESSAGE_FRAGMENTS,
  fetchPublicApiVersions,
  GraphQLOperationError,
  runAdminStoreGraphQLOperation,
} from './admin-transport.js'
import {STORE_AUTH_APP_CLIENT_ID} from '../auth/config.js'
import {clearStoredStoreAppSession} from '@shopify/cli-kit/node/store-auth-session'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {adminUrl} from '@shopify/cli-kit/node/api/admin'
import {graphqlRequest, type GraphQLResponse} from '@shopify/cli-kit/node/api/graphql'
import {AbortError, BugError} from '@shopify/cli-kit/node/error'
import {renderSingleTask} from '@shopify/cli-kit/node/ui'
import {mockAndCaptureOutput} from '@shopify/cli-kit/node/testing/output'

vi.mock('@shopify/cli-kit/node/store-auth-session')
vi.mock('@shopify/cli-kit/node/api/graphql')
vi.mock('@shopify/cli-kit/node/ui')
vi.mock('@shopify/cli-kit/node/api/admin', async () => {
  const actual = await vi.importActual<typeof import('@shopify/cli-kit/node/api/admin')>(
    '@shopify/cli-kit/node/api/admin',
  )
  return {
    ...actual,
    adminUrl: vi.fn(),
  }
})

// Structural fake of graphql-request's `ClientError` — the trap matches on shape, not on
// the imported class, so we don't pull `graphql-request` into `@shopify/store`.
function makeClientErrorLike(status: number, message = 'GraphQL Error'): Error {
  const error = new Error(message) as Error & {response: {status: number; errors: {message: string}[]}}
  error.response = {status, errors: [{message}]}
  return error
}

function asGraphQLResponse(response: {extensions?: unknown}): GraphQLResponse<unknown> {
  return response as unknown as GraphQLResponse<unknown>
}

describe('runAdminStoreGraphQLOperation', () => {
  const store = 'shop.myshopify.com'
  const context = {
    adminSession: {token: 'token', storeFqdn: store},
    version: '2025-10',
    session: {
      store,
      clientId: STORE_AUTH_APP_CLIENT_ID,
      userId: '42',
      accessToken: 'token',
      scopes: ['read_products', 'write_orders'],
      acquiredAt: '2026-03-27T00:00:00.000Z',
    },
  }

  beforeEach(() => {
    // Echo the inputs back into the URL so tests can verify the right store/version were
    // passed in (a constant return value would mask `adminUrl(wrongStore, wrongVersion)`).
    vi.mocked(adminUrl).mockImplementation((store, version) => `https://${store}/admin/api/${version}/graphql.json`)
    vi.mocked(renderSingleTask).mockImplementation(async ({task}) => task(() => {}))
  })

  afterEach(() => {
    mockAndCaptureOutput().clear()
  })

  test('executes the GraphQL request successfully', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({data: {shop: {name: 'Test shop'}}})
    const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})

    const result = await runAdminStoreGraphQLOperation({context, request})

    expect(result).toEqual({data: {shop: {name: 'Test shop'}}})
    expect(adminUrl).toHaveBeenCalledWith(store, '2025-10', context.adminSession)
    expect(graphqlRequest).toHaveBeenCalledWith({
      query: 'query { shop { name } }',
      api: 'Admin',
      url: `https://${store}/admin/api/2025-10/graphql.json`,
      token: 'token',
      variables: undefined,
      responseOptions: {handleErrors: false, onResponse: expect.any(Function)},
    })
  })

  test('keeps the response extensions on the success path without changing the result', async () => {
    const extensions = {cost: {actualQueryCost: 12, throttleStatus: {currentlyAvailable: 988, restoreRate: 50}}}
    vi.mocked(graphqlRequest).mockImplementation(async (options) => {
      options.responseOptions?.onResponse?.(asGraphQLResponse({extensions}))
      return {shop: {name: 'Test shop'}}
    })
    const output = mockAndCaptureOutput()
    const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})

    const result = await runAdminStoreGraphQLOperation({context, request})

    // The result a caller sees, and therefore what `--json` prints on success, is untouched.
    expect(result).toEqual({shop: {name: 'Test shop'}})
    expect(output.debug()).toContain('"actualQueryCost":12')
    expect(output.debug()).toContain('"restoreRate":50')
  })

  test('does not log anything when the response carries no extensions', async () => {
    vi.mocked(graphqlRequest).mockImplementation(async (options) => {
      options.responseOptions?.onResponse?.(asGraphQLResponse({}))
      return {shop: {name: 'Test shop'}}
    })
    const output = mockAndCaptureOutput()
    const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})

    await runAdminStoreGraphQLOperation({context, request})

    expect(output.debug()).not.toContain('extensions')
  })

  test('clears stored auth and throws a re-auth error on 401 using the real session scopes', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue({response: {status: 401}})
    const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})

    await expect(runAdminStoreGraphQLOperation({context, request})).rejects.toMatchObject({
      message: `Stored app authentication for ${store} is no longer valid.`,
      nextSteps: [
        [
          'Run',
          {command: `shopify store auth --store ${store} --scopes read_products,write_orders`},
          'to re-authenticate',
        ],
      ],
    })
    expect(clearStoredStoreAppSession).toHaveBeenCalledWith(store, '42')
  })

  test('also clears stored auth on a 401 ClientError-shaped rejection', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(makeClientErrorLike(401, 'Unauthorized'))
    const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})

    await expect(runAdminStoreGraphQLOperation({context, request})).rejects.toMatchObject({
      message: `Stored app authentication for ${store} is no longer valid.`,
    })
    expect(clearStoredStoreAppSession).toHaveBeenCalledWith(store, '42')
  })

  test('also treats a 404 as a stored-auth-no-longer-valid signal', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(makeClientErrorLike(404, 'Not Found'))
    const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})

    await expect(runAdminStoreGraphQLOperation({context, request})).rejects.toMatchObject({
      message: `Stored app authentication for ${store} is no longer valid.`,
    })
    expect(clearStoredStoreAppSession).toHaveBeenCalledWith(store, '42')
  })

  test('clears a likely claimed preview session and does not re-list scopes when it 401s', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue({response: {status: 401}})
    const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})
    const previewContext = {
      ...context,
      session: {
        ...context.session,
        userId: 'preview:placeholder-uuid',
        kind: 'preview' as const,
        scopes: ['read_products', 'write_products', 'read_themes'],
      },
    }

    await expect(runAdminStoreGraphQLOperation({context: previewContext, request})).rejects.toMatchObject({
      message: `The preview store ${store} has likely been claimed, so its stored authentication is no longer valid.`,
      nextSteps: [
        [
          'Run',
          {command: `shopify store auth --store ${store} --scopes <comma-separated-scopes>`},
          'to re-authenticate',
        ],
      ],
    })
    expect(clearStoredStoreAppSession).toHaveBeenCalledWith(store, 'preview:placeholder-uuid')
  })

  test('throws a GraphQL operation error when errors are returned', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue({response: {errors: [{message: 'Field does not exist'}]}})
    const request = await prepareStoreExecuteRequest({query: 'query { nope }'})

    await expect(runAdminStoreGraphQLOperation({context, request})).rejects.toThrow('GraphQL operation failed.')
  })

  test('keeps the GraphQL errors and extensions as data on the thrown error', async () => {
    const errors = [{message: 'Field does not exist'}]
    const extensions = {cost: {actualQueryCost: 0, throttleStatus: {currentlyAvailable: 1000, restoreRate: 50}}}
    vi.mocked(graphqlRequest).mockRejectedValue({response: {errors, extensions}})
    const request = await prepareStoreExecuteRequest({query: 'query { nope }'})

    let captured: GraphQLOperationError | undefined
    await runAdminStoreGraphQLOperation({context, request}).catch((error) => {
      captured = error as GraphQLOperationError
    })

    expect(captured).toBeInstanceOf(GraphQLOperationError)
    expect(captured?.response).toEqual({errors, extensions})
  })

  test('leaves `extensions` off the thrown error when the response has none', async () => {
    const errors = [{message: 'Field does not exist'}]
    vi.mocked(graphqlRequest).mockRejectedValue({response: {errors}})
    const request = await prepareStoreExecuteRequest({query: 'query { nope }'})

    let captured: GraphQLOperationError | undefined
    await runAdminStoreGraphQLOperation({context, request}).catch((error) => {
      captured = error as GraphQLOperationError
    })

    // `JSON.stringify` drops the undefined key, so a caller sees `{"errors": [...]}` alone.
    expect(JSON.parse(JSON.stringify(captured?.response))).toEqual({errors})
  })

  test('maps a 402 ClientError to a store-unavailable AbortError even when the response also carries `errors`', async () => {
    // Branch-ordering regression check: a 402 response that also carries GraphQL `errors`
    // must surface as the store-unavailable AbortError, not the generic "GraphQL operation
    // failed" branch.
    vi.mocked(graphqlRequest).mockRejectedValue(makeClientErrorLike(402, 'Unavailable Shop'))
    const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})

    let captured: AbortError | undefined
    await runAdminStoreGraphQLOperation({context, request}).catch((error) => {
      captured = error as AbortError
    })

    expect(captured).toBeInstanceOf(AbortError)
    expect(captured).not.toBeInstanceOf(GraphQLOperationError)
    expect(captured?.message).toBe(`The store ${store} is currently unavailable.`)
    expect(captured?.message).not.toContain('GraphQL operation failed.')
  })

  test('rethrows non-GraphQL errors', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(new Error('boom'))
    const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})

    await expect(runAdminStoreGraphQLOperation({context, request})).rejects.toThrow('boom')
  })

  // A user cancellation or CLI-side fetch timeout during the execute phase must surface as
  // a user-facing AbortError, not be mistaken for an auth failure or wrapped as a bug.
  // Driven off the production constant so adding a new abort-message fragment auto-extends
  // coverage here.
  test.each(ABORTED_FETCH_MESSAGE_FRAGMENTS)(
    'maps user-aborted fetches with message %j to an AbortError, not a CLI bug',
    async (fragment) => {
      vi.mocked(graphqlRequest).mockRejectedValue(new Error(fragment))
      const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})

      let captured: AbortError | undefined
      await runAdminStoreGraphQLOperation({context, request}).catch((error) => {
        captured = error as AbortError
      })

      expect(captured).toBeInstanceOf(AbortError)
      expect(captured).not.toBeInstanceOf(BugError)
      expect(captured?.message).toBe(`Request to ${store} was aborted before it completed.`)
      expect(clearStoredStoreAppSession).not.toHaveBeenCalled()
    },
  )

  test('maps user-aborted fetches (name=AbortError) to an AbortError, not a CLI bug', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    vi.mocked(graphqlRequest).mockRejectedValue(abort)
    const request = await prepareStoreExecuteRequest({query: 'query { shop { name } }'})

    let captured: AbortError | undefined
    await runAdminStoreGraphQLOperation({context, request}).catch((error) => {
      captured = error as AbortError
    })

    expect(captured).toBeInstanceOf(AbortError)
    expect(captured).not.toBeInstanceOf(BugError)
    expect(clearStoredStoreAppSession).not.toHaveBeenCalled()
  })
})

describe('GraphQLOperationError', () => {
  const errors = [{message: 'Field does not exist on type QueryRoot'}]

  test('renders exactly like the plain AbortError it replaces', () => {
    const structured = new GraphQLOperationError({errors, extensions: {cost: {actualQueryCost: 0}}})
    // These are the fields the error banner reads, so matching all of them means the
    // rendered output is unchanged for anyone not passing --json.
    const previous = new AbortError('GraphQL operation failed.', JSON.stringify({errors}, null, 2))

    expect(structured.message).toBe(previous.message)
    expect(structured.tryMessage).toBe(previous.tryMessage)
    expect(structured.nextSteps).toEqual(previous.nextSteps)
    expect(structured.customSections).toEqual(previous.customSections)
    expect(structured.formattedMessage).toEqual(previous.formattedMessage)
    expect(structured.type).toBe(previous.type)
  })

  test('is an AbortError, so the global handler still treats it as a user-facing failure', () => {
    expect(new GraphQLOperationError({errors})).toBeInstanceOf(AbortError)
    expect(new GraphQLOperationError({errors})).not.toBeInstanceOf(BugError)
  })
})

describe('fetchPublicApiVersions', () => {
  const store = 'shop.myshopify.com'
  const session = {
    store,
    clientId: STORE_AUTH_APP_CLIENT_ID,
    userId: '42',
    accessToken: 'token',
    refreshToken: 'refresh-token',
    scopes: ['read_products', 'write_orders'],
    acquiredAt: '2026-03-27T00:00:00.000Z',
  }
  const adminSession = {token: 'token', storeFqdn: store}

  beforeEach(() => {
    vi.mocked(adminUrl).mockImplementation((shop, version) => `https://${shop}/admin/api/${version}/graphql.json`)
  })

  test('issues the publicApiVersions query against the unstable Admin endpoint', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({
      publicApiVersions: [
        {handle: '2025-10', supported: true},
        {handle: '2025-07', supported: true},
      ],
    })

    const result = await fetchPublicApiVersions({adminSession, session})

    expect(result).toEqual([
      {handle: '2025-10', supported: true},
      {handle: '2025-07', supported: true},
    ])
    expect(adminUrl).toHaveBeenCalledWith(store, 'unstable', adminSession)
    expect(graphqlRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        api: 'Admin',
        token: 'token',
        url: `https://${store}/admin/api/unstable/graphql.json`,
        responseOptions: {handleErrors: false},
      }),
    )
  })

  test('clears stored auth and prompts re-auth when the version request returns 401', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(makeClientErrorLike(401, 'Unauthorized'))

    await expect(fetchPublicApiVersions({adminSession, session})).rejects.toMatchObject({
      message: `Stored app authentication for ${store} is no longer valid.`,
      nextSteps: [
        [
          'Run',
          {command: `shopify store auth --store ${store} --scopes read_products,write_orders`},
          'to re-authenticate',
        ],
      ],
    })
    expect(clearStoredStoreAppSession).toHaveBeenCalledWith(store, '42')
  })

  test('also handles 404 as a stored-auth-no-longer-valid signal', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(makeClientErrorLike(404, 'Not Found'))

    await expect(fetchPublicApiVersions({adminSession, session})).rejects.toMatchObject({
      message: `Stored app authentication for ${store} is no longer valid.`,
    })
    expect(clearStoredStoreAppSession).toHaveBeenCalledWith(store, '42')
  })

  test('clears a likely claimed preview session and does not re-list scopes when it 401s', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(makeClientErrorLike(401, 'Unauthorized'))
    const previewSession = {
      ...session,
      userId: 'preview:placeholder-uuid',
      kind: 'preview' as const,
      scopes: ['read_products', 'write_products', 'read_themes'],
    }

    await expect(fetchPublicApiVersions({adminSession, session: previewSession})).rejects.toMatchObject({
      message: `The preview store ${store} has likely been claimed, so its stored authentication is no longer valid.`,
      nextSteps: [
        [
          'Run',
          {command: `shopify store auth --store ${store} --scopes <comma-separated-scopes>`},
          'to re-authenticate',
        ],
      ],
    })
    expect(clearStoredStoreAppSession).toHaveBeenCalledWith(store, 'preview:placeholder-uuid')
  })

  test('maps 402 Unavailable Shop to an AbortError without clearing stored auth', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(makeClientErrorLike(402, 'Unavailable Shop'))

    let captured: AbortError | undefined
    await fetchPublicApiVersions({adminSession, session}).catch((error) => {
      captured = error as AbortError
    })

    expect(captured).toBeInstanceOf(AbortError)
    expect(captured).not.toBeInstanceOf(BugError)
    expect(captured?.message).toBe(`The store ${store} is currently unavailable.`)
    expect(String((captured as unknown as {tryMessage?: string})?.tryMessage ?? '')).toContain(
      'Check the store in the Shopify admin',
    )
    expect(clearStoredStoreAppSession).not.toHaveBeenCalled()
  })

  test.each(ABORTED_FETCH_MESSAGE_FRAGMENTS)(
    'maps user-aborted fetches with message %j to an AbortError without clearing stored auth',
    async (fragment) => {
      vi.mocked(graphqlRequest).mockRejectedValue(new Error(fragment))

      let captured: AbortError | undefined
      await fetchPublicApiVersions({adminSession, session}).catch((error) => {
        captured = error as AbortError
      })

      expect(captured).toBeInstanceOf(AbortError)
      expect(captured).not.toBeInstanceOf(BugError)
      expect(captured?.message).toBe(`Request to ${store} was aborted before it completed.`)
      expect(clearStoredStoreAppSession).not.toHaveBeenCalled()
    },
  )

  test('maps user-aborted fetches (name=AbortError) to an AbortError without clearing stored auth', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    vi.mocked(graphqlRequest).mockRejectedValue(abort)

    let captured: AbortError | undefined
    await fetchPublicApiVersions({adminSession, session}).catch((error) => {
      captured = error as AbortError
    })

    expect(captured).toBeInstanceOf(AbortError)
    expect(captured).not.toBeInstanceOf(BugError)
    expect(clearStoredStoreAppSession).not.toHaveBeenCalled()
  })

  test('rethrows unrelated errors', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(new Error('upstream exploded'))

    await expect(fetchPublicApiVersions({adminSession, session})).rejects.toThrow('upstream exploded')
    expect(clearStoredStoreAppSession).not.toHaveBeenCalled()
  })
})
