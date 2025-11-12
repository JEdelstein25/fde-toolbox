import { Observable } from '@sourcegraph/observable'

import logger from '../../../common/logger'
import { fetchFromBitbucketAPI } from '../../../external-services/bitbucket/fetch-from-bitbucket-api'
import type { ToolRegistration, ToolRun } from '../../tool-service'

type CodeSearchToolArgs = {
	query: string
	project?: string
	repository?: string
	fileGlob?: string
	limit?: number
}

type CodeHit = {
	repository: {
		slug: string
		id: number
		name: string
		description?: string
		project: {
			key: string
			id: number
			name: string
		}
	}
	file: string
	hitContexts: Array<
		Array<{
			line: number
			text: string
		}>
	>
	pathMatches: unknown[]
	hitCount: number
}

type CodeSearchResponse = {
	scope: {
		type: string
	}
	code: {
		category: string
		count: number
		nextStart: number
		start: number
		values: CodeHit[]
		isLastPage: boolean
	}
	query: {
		substituted: boolean
	}
}

type CodeSearchToolDef = {
	name: 'code_search'
	args: CodeSearchToolArgs
	progress: string[]
	result: {
		files: CodeHit[]
		totalCount: number
	}
	error: { message: string }
}

/**
 * Code search implementation using Bitbucket's REST search API
 */
const bitbucketCodeSearchTool: NonNullable<ToolRegistration<CodeSearchToolDef>['fn']> = (
	{ args },
	{ configService },
): Observable<ToolRun<CodeSearchToolDef>> => {
	const { query, project, repository, fileGlob, limit = 25 } = args

	return new Observable<ToolRun<CodeSearchToolDef>>((observer) => {
		const abortController = new AbortController()

		const executeSearch = async (): Promise<void> => {
			try {
				logger.info('Starting Bitbucket code search', {
					query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
					project,
					repository,
					fileGlob,
					limit,
				})

				observer.next({
					status: 'in-progress' as const,
					progress: [`Searching for "${query}" in code...`],
				})

				const config = await configService.getLatest(abortController.signal)

				// Build entities object
				// Note: The code entity doesn't support filters like projectKey, repositorySlug, or path
				// Those filters need to be applied post-search or via query syntax
				const entities: Record<string, unknown> = {
					code: {},
				}

				// Build request body
				const requestBody = {
					query,
					entities,
					limits: {
						primary: limit,
					},
				}

				// Make POST request to REST search endpoint
				const response = await fetchFromBitbucketAPI<CodeSearchResponse>(
					'rest/search/latest/search?avatarSize=64',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: requestBody,
						signal: abortController.signal,
					},
					config,
				)

				if (!response.ok) {
					logger.error('Bitbucket code search failed', {
						query,
						status: response.status,
						statusText: response.statusText,
						errorBody: response.text?.substring(0, 500),
					})
					throw new Error(
						`Bitbucket code search failed: ${response.status} ${response.statusText}${response.text ? ` - ${response.text.substring(0, 100)}` : ''}`,
					)
				}

				if (!response.data) {
					logger.error('Bitbucket code search returned no data', { query })
					throw new Error('No data returned from Bitbucket code search')
				}

				if (!response.data.code) {
					logger.warn('Bitbucket code search returned no code results', {
						query,
						responseKeys: Object.keys(response.data),
					})
					observer.next({
						status: 'done' as const,
						result: {
							files: [],
							totalCount: 0,
						},
					})
					observer.complete()
					return
				}

				const { values: files, count: totalCount } = response.data.code

				// Apply client-side filters
				let filteredFiles = files

				if (project) {
					filteredFiles = filteredFiles.filter(
						(file) => file.repository.project.key === project,
					)
				}

				if (repository) {
					filteredFiles = filteredFiles.filter(
						(file) => file.repository.slug === repository,
					)
				}

				if (fileGlob) {
					// Convert glob pattern to regex
					// Simple implementation: ** matches anything, * matches anything except /
					const globRegex = new RegExp(
						'^' +
							fileGlob
								.replace(/\./g, '\\.')
								.replace(/\*\*/g, '.*')
								.replace(/\*/g, '[^/]*') +
							'$',
					)
					filteredFiles = filteredFiles.filter((file) => globRegex.test(file.file))
				}

				logger.info('Bitbucket code search completed', {
					totalCount,
					filesReturned: filteredFiles.length,
				})

				observer.next({
					status: 'done' as const,
					result: {
						files: filteredFiles,
						totalCount: filteredFiles.length,
					},
				})
				observer.complete()
			} catch (error) {
				logger.error('Bitbucket code search error', {
					query,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				})
				observer.next({
					status: 'error' as const,
					error: {
						message: `Error searching Bitbucket code: ${error instanceof Error ? error.message : String(error)}`,
					},
				})
				observer.complete()
			}
		}

		executeSearch()

		return () => abortController.abort()
	})
}

const description = `
Search for code across Bitbucket repositories using keyword search.

This tool uses Bitbucket's indexed code search to find matching files with context.
It supports filtering by project, repository, and file patterns.

WHEN TO USE THIS TOOL:
- When you need to find code patterns across repositories
- When you want to see where specific functions, variables, or text appear in code
- When you need code search results with line numbers and surrounding context
- When you want to filter searches to specific projects or repositories

FEATURES:
- Fast indexed search across all accessible code
- Returns file paths with matching code snippets
- Shows line numbers and surrounding context for each match
- Filter by project key
- Filter by repository slug
- Filter by file glob patterns
- HTML entities in results are decoded automatically

PARAMETERS:
- query: The search query string - keywords to find in code (required)
- project: Filter to specific project key (optional)
- repository: Filter to specific repository slug (optional)
- fileGlob: Filter to files matching glob pattern, e.g., "*.go", "src/**/*.ts" (optional)
- limit: Maximum number of file results to return (default: 25, max: 100)

RESULT STRUCTURE:
Returns:
- files: Array of file matches, each containing:
  - file: File path
  - repository: Repository info (slug, name, project key)
  - hitContexts: Arrays of code chunks showing matches with line numbers
  - hitCount: Number of matches in this file
- totalCount: Total number of matching files found

Each hitContext contains an array of line objects with:
- line: Line number
- text: Line content (may contain HTML-encoded entities like &#x2F; for /)

<examples>
<example>
	<user>Search for "handleAuth" function across all repositories</user>
	<response>Calls the code search tool with query: "handleAuth", limit: 25</response>
</example>
<example>
	<user>Find all uses of "JSON-RPC" in the Sourcegraph project</user>
	<response>Calls the code search tool with query: "JSON-RPC", project: "SOURCEGRAPH"</response>
</example>
<example>
	<user>Search for "import React" in TypeScript files in the web repository</user>
	<response>Calls the code search tool with query: "import React", repository: "web", fileGlob: "**/*.tsx"</response>
</example>
<example>
	<user>Find TODO comments in Go files</user>
	<response>Calls the code search tool with query: "TODO", fileGlob: "**/*.go"</response>
</example>
</examples>
`

export const bitbucketCodeSearchToolReg: ToolRegistration<CodeSearchToolDef> = {
	spec: {
		name: 'code_search',
		description,
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'Search query - keywords to find in code',
				},
				project: {
					type: 'string',
					description: 'Filter to specific project key (e.g., "SOURCEGRAPH")',
				},
				repository: {
					type: 'string',
					description: 'Filter to specific repository slug (e.g., "jsonrpc2")',
				},
				fileGlob: {
					type: 'string',
					description:
						'Filter to files matching glob pattern (e.g., "**/*.go", "src/**/*.ts")',
				},
				limit: {
					type: 'number',
					description: 'Maximum number of file results to return (default: 25)',
					minimum: 1,
					maximum: 100,
				},
			},
			required: ['query'],
		},
		source: 'builtin',
	},
	fn: bitbucketCodeSearchTool,
}
