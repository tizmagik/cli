import {
  classifyAdminApiError,
  isGraphQLClientErrorLike,
  throwIfStoredStoreAuthIsInvalid,
  ABORTED_FETCH_MESSAGE_FRAGMENTS,
} from '../admin-errors.js'
import {adminUrl} from '@shopify/cli-kit/node/api/admin'
import {graphqlRequest} from '@shopify/cli-kit/node/api/graphql'
import {AbortError} from '@shopify/cli-kit/node/error'
import {outputContent, outputDebug} from '@shopify/cli-kit/node/output'
import {renderSingleTask} from '@shopify/cli-kit/node/ui'
import type {AdminSession} from '@shopify/cli-kit/node/session'
import type {PreparedStoreExecuteRequest} from './request.js'
import type {AdminStoreGraphQLContext} from './admin-context.js'
import type {StoredStoreAppSession} from '@shopify/cli-kit/node/store-auth-session'

export {ABORTED_FETCH_MESSAGE_FRAGMENTS}

/**
 * Thrown when the Admin API answers with GraphQL `errors`. The structured response is kept
 * on the error so a caller that asked for machine-readable output can read `errors` and
 * `extensions` as data, instead of only seeing the pre-rendered message string.
 *
 * The arguments handed to `super()` are the ones the plain `AbortError` used before, so the
 * rendered banner is byte-for-byte what it was.
 */
export class GraphQLOperationError extends AbortError {
  constructor(readonly response: {errors?: unknown; extensions?: unknown}) {
    super('GraphQL operation failed.', JSON.stringify({errors: response.errors}, null, 2))
  }
}

interface ApiVersion {
  handle: string
  supported: boolean
}

interface PublicApiVersionsResponse {
  publicApiVersions: ApiVersion[]
}

const PUBLIC_API_VERSIONS_QUERY = `
  query StoreExecutePublicApiVersions {
    publicApiVersions {
      handle
      supported
    }
  }
`

/**
 * Runs the version-discovery GraphQL query against the Admin API. Errors are classified
 * the same way as the execute-phase request: 401/404 trigger a stored-auth re-auth flow,
 * 402 / fetch-aborts surface as user-facing `AbortError`s.
 */
export async function fetchPublicApiVersions(input: {
  adminSession: AdminSession
  session: StoredStoreAppSession
}): Promise<ApiVersion[]> {
  try {
    const response = await graphqlRequest<PublicApiVersionsResponse>({
      query: PUBLIC_API_VERSIONS_QUERY,
      api: 'Admin',
      url: adminUrl(input.adminSession.storeFqdn, 'unstable', input.adminSession),
      token: input.adminSession.token,
      responseOptions: {handleErrors: false},
    })
    return response.publicApiVersions
  } catch (error) {
    throwIfStoredStoreAuthIsInvalid(error, input.session)

    const classified = classifyAdminApiError(error, input.adminSession.storeFqdn)
    if (classified) throw classified

    throw error
  }
}

/**
 * `graphqlRequest` resolves with the response `data` alone, so the response `extensions`
 * (Admin API query cost and throttle status) are gone by the time the caller sees the
 * result. The `onResponse` hook is the only place they are still reachable on the success
 * path, so record them in the debug log. What the command prints is left alone: it is a
 * fixed shape that callers already parse.
 */
function recordResponseExtensions(extensions: unknown): void {
  if (extensions === undefined || extensions === null) return
  outputDebug(outputContent`Admin API response extensions: ${JSON.stringify(extensions)}`)
}

export async function runAdminStoreGraphQLOperation(input: {
  context: AdminStoreGraphQLContext
  request: PreparedStoreExecuteRequest
}): Promise<unknown> {
  try {
    return await renderSingleTask({
      title: outputContent`Executing GraphQL operation`,
      task: async () => {
        return graphqlRequest({
          query: input.request.query,
          api: 'Admin',
          url: adminUrl(input.context.adminSession.storeFqdn, input.context.version, input.context.adminSession),
          token: input.context.adminSession.token,
          variables: input.request.parsedVariables,
          responseOptions: {
            handleErrors: false,
            onResponse: (response) => recordResponseExtensions(response.extensions),
          },
        })
      },
      renderOptions: {stdout: process.stderr},
    })
  } catch (error) {
    throwIfStoredStoreAuthIsInvalid(error, input.context.session)

    // Status-specific classification (e.g. 402 store-unavailable) must run before the
    // generic GraphQL-errors branch, otherwise a 402 response that also carries
    // `errors: [...]` would be misreported as "GraphQL operation failed".
    const classified = classifyAdminApiError(error, input.context.adminSession.storeFqdn)
    if (classified) throw classified

    if (isGraphQLClientErrorLike(error) && error.response.errors) {
      throw new GraphQLOperationError({errors: error.response.errors, extensions: error.response.extensions})
    }

    throw error
  }
}
