import StoreExecute from './execute.js'
import {executeStoreOperation} from '../../services/store/execute/index.js'
import {writeOrOutputStoreExecuteResult} from '../../services/store/execute/result.js'
import {GraphQLOperationError} from '../../services/store/execute/admin-transport.js'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {AbortError} from '@shopify/cli-kit/node/error'

vi.mock('../../services/store/execute/index.js')
vi.mock('../../services/store/execute/result.js')
vi.mock('../../services/store/attribution.js')

describe('store execute command', () => {
  const originalExitCode = process.exitCode

  beforeEach(() => {
    vi.mocked(executeStoreOperation).mockResolvedValue({data: {shop: {name: 'Test shop'}}})
  })

  afterEach(() => {
    process.exitCode = originalExitCode
  })

  test('passes the inline query through to the service and writes the result', async () => {
    await StoreExecute.run(['--store', 'shop.myshopify.com', '--query', 'query { shop { name } }'])

    expect(executeStoreOperation).toHaveBeenCalledWith({
      store: 'shop.myshopify.com',
      query: 'query { shop { name } }',
      queryFile: undefined,
      variables: undefined,
      variableFile: undefined,
      version: undefined,
      allowMutations: false,
    })
    expect(writeOrOutputStoreExecuteResult).toHaveBeenCalledWith({data: {shop: {name: 'Test shop'}}}, undefined, 'text')
  })

  test('passes the query file through to the service', async () => {
    await StoreExecute.run(['--store', 'shop.myshopify.com', '--query-file', './operation.graphql'])

    expect(executeStoreOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        store: 'shop.myshopify.com',
        query: undefined,
        queryFile: expect.stringMatching(/operation\.graphql$/),
      }),
    )
  })

  test('writes json output when --json is provided', async () => {
    await StoreExecute.run(['--store', 'shop.myshopify.com', '--query', 'query { shop { name } }', '--json'])

    expect(writeOrOutputStoreExecuteResult).toHaveBeenCalledWith({data: {shop: {name: 'Test shop'}}}, undefined, 'json')
  })

  test('writes the GraphQL errors as json and keeps exit code 1 when --json is provided', async () => {
    const response = {errors: [{message: 'Field does not exist'}], extensions: {cost: {actualQueryCost: 0}}}
    vi.mocked(executeStoreOperation).mockRejectedValue(new GraphQLOperationError(response))

    await StoreExecute.run(['--store', 'shop.myshopify.com', '--query', 'query { nope }', '--json'])

    expect(writeOrOutputStoreExecuteResult).toHaveBeenCalledWith(response, undefined, 'json')
    expect(process.exitCode).toBe(1)
  })

  test('writes the GraphQL errors to the output file when --json and --output-file are provided', async () => {
    const response = {errors: [{message: 'Field does not exist'}]}
    vi.mocked(executeStoreOperation).mockRejectedValue(new GraphQLOperationError(response))

    await StoreExecute.run([
      '--store',
      'shop.myshopify.com',
      '--query',
      'query { nope }',
      '--json',
      '--output-file',
      './errors.json',
    ])

    expect(writeOrOutputStoreExecuteResult).toHaveBeenCalledWith(
      response,
      expect.stringMatching(/errors\.json$/),
      'json',
    )
    expect(process.exitCode).toBe(1)
  })

  test('leaves the GraphQL error to the global handler when --json is not provided', async () => {
    vi.mocked(executeStoreOperation).mockRejectedValue(
      new GraphQLOperationError({errors: [{message: 'Field does not exist'}]}),
    )
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    await expect(StoreExecute.run(['--store', 'shop.myshopify.com', '--query', 'query { nope }'])).rejects.toThrow(
      'process.exit',
    )

    // Nothing is written, so the banner stays the only output, exactly as before.
    expect(writeOrOutputStoreExecuteResult).not.toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(1)

    mockExit.mockRestore()
  })

  test('leaves non-GraphQL failures to the global handler even when --json is provided', async () => {
    vi.mocked(executeStoreOperation).mockRejectedValue(
      new AbortError('The store shop.myshopify.com is currently unavailable.'),
    )
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    await expect(
      StoreExecute.run(['--store', 'shop.myshopify.com', '--query', 'query { shop { name } }', '--json']),
    ).rejects.toThrow('process.exit')

    expect(writeOrOutputStoreExecuteResult).not.toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(1)

    mockExit.mockRestore()
  })

  test('defines the expected flags', () => {
    expect(StoreExecute.flags.store).toBeDefined()
    expect(StoreExecute.flags.query).toBeDefined()
    expect(StoreExecute.flags['query-file']).toBeDefined()
    expect(StoreExecute.flags.variables).toBeDefined()
    expect(StoreExecute.flags['variable-file']).toBeDefined()
    expect(StoreExecute.flags['allow-mutations']).toBeDefined()
    expect(StoreExecute.flags.json).toBeDefined()
  })

  test('requires --query or --query-file', async () => {
    await expect(StoreExecute.run(['--store', 'shop.myshopify.com'])).rejects.toThrow()

    expect(executeStoreOperation).not.toHaveBeenCalled()
    expect(writeOrOutputStoreExecuteResult).not.toHaveBeenCalled()
  })
})
