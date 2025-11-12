import { Observable } from '@sourcegraph/observable'

import logger from '../../../common/logger'
import { fetchFromBitbucketAPI } from '../../../external-services/bitbucket/fetch-from-bitbucket-api'
import type { ToolRegistration, ToolRun } from '../../tool-service'

type SearchRepositoriesToolArgs = {
	query: string
	limit?: number
}

type Repository = {
	id: number
	name: string
	slug: string
	description?: string
	public: boolean
	archived: boolean
	project: {
		key: string
		id: number
		name: string
		description?: string
		public: boolean
		type: string
	}
	scmId: string
	state: string
	statusMessage: string
	forkable: boolean
}

type SearchRepositoriesResponse = {
	scope: {
		type: string
	}
	repositories: {
		category: string
		count: number
		nextStart: number
		start: number
		values: Repository[]
		isLastPage: boolean
	}
	query: {
		substituted: boolean
	}
}

type SearchRepositoriesToolDef = {
	name: 'search_repositories'
	args: SearchRepositoriesToolArgs
	progress: string[]
	result: {
		repositories: Repository[]
		totalCount: number
	}
	error: { message: string }
}

/**
 * Search repositories implementation using Bitbucket's REST search API
 */
const bitbucketSearchRepositoriesTool: NonNullable<
	ToolRegistration<SearchRepositoriesToolDef>['fn']
> = ({ args }, { configService }): Observable<ToolRun<SearchRepositoriesToolDef>> => {
	const { query, limit = 30 } = args

	return new Observable<ToolRun<SearchRepositoriesToolDef>>((observer) => {
		const abortController = new AbortController()

		const executeSearch = async (): Promise<void> => {
			try {
				logger.info('Starting Bitbucket repository search', {
					query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
					limit,
				})

				observer.next({
					status: 'in-progress' as const,
					progress: [`Searching for repositories matching "${query}"...`],
				})

				const config = await configService.getLatest(abortController.signal)

				// Build request body
				const requestBody = {
					query,
					entities: {
						repositories: {},
					},
					limits: {
						primary: limit,
					},
				}

				// Make POST request to REST search endpoint
				const response = await fetchFromBitbucketAPI<SearchRepositoriesResponse>(
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
					logger.error('Bitbucket repository search failed', {
						query,
						status: response.status,
						statusText: response.statusText,
						errorBody: response.text?.substring(0, 500),
					})
					throw new Error(
						`Bitbucket repository search failed: ${response.status} ${response.statusText}${response.text ? ` - ${response.text.substring(0, 100)}` : ''}`,
					)
				}

				if (!response.data) {
					logger.error('Bitbucket repository search returned no data', { query })
					throw new Error('No data returned from Bitbucket repository search')
				}

				if (!response.data.repositories) {
					logger.warn('Bitbucket repository search returned no repositories', {
						query,
						responseKeys: Object.keys(response.data),
					})
					observer.next({
						status: 'done' as const,
						result: {
							repositories: [],
							totalCount: 0,
						},
					})
					observer.complete()
					return
				}

				const { values: repositories, count: totalCount } = response.data.repositories

				logger.info('Bitbucket repository search completed', {
					totalCount,
					repositoriesReturned: repositories.length,
				})

				observer.next({
					status: 'done' as const,
					result: {
						repositories,
						totalCount,
					},
				})
				observer.complete()
			} catch (error) {
				logger.error('Bitbucket repository search error', {
					query,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				})
				observer.next({
					status: 'error' as const,
					error: {
						message: `Error searching Bitbucket repositories: ${error instanceof Error ? error.message : String(error)}`,
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
Search for repositories across Bitbucket using keyword search.

This tool uses Bitbucket's indexed search to find repositories by name, slug, or description.
Returns detailed repository metadata including project information.

WHEN TO USE THIS TOOL:
- When you need to find repositories by name or keyword
- When you want to discover what repositories are available
- When you want to find repositories related to a specific topic
- When you need to see what projects repositories belong to

FEATURES:
- Fast indexed search across repository metadata (name, slug, description)
- Returns complete repository information including project details
- Includes repository state, visibility, and archive status
- Shows project membership for each repository

PARAMETERS:
- query: Search query - keywords to match in repository name, slug, or description (required)
  - Use broad terms like "api" or "service" to find many repos
  - Use specific names to find exact matches
  - Include project name in query to filter by project (e.g., "SOURCEGRAPH api")
- limit: Maximum number of results to return (default: 30, max: 100)

RESULT STRUCTURE:
Returns:
- repositories: Array of repository objects, each containing:
  - id: Repository ID
  - name: Repository name
  - slug: Repository slug (URL-safe identifier)
  - description: Repository description
  - public: Whether repository is public
  - archived: Whether repository is archived
  - project: Project information (key, name, description, etc.)
  - scmId: Source control type (e.g., "git")
  - state: Repository state (e.g., "AVAILABLE")
- totalCount: Total number of matching repositories found

<examples>
<example>
	<user>Find all repositories related to "auth"</user>
	<response>Calls the search repositories tool with query: "auth"</response>
</example>
<example>
	<user>Search for repositories in the SOURCEGRAPH project</user>
	<response>Calls the search repositories tool with query: "SOURCEGRAPH"</response>
</example>
<example>
	<user>Find API repositories in the SOURCEGRAPH project</user>
	<response>Calls the search repositories tool with query: "SOURCEGRAPH api"</response>
</example>
<example>
	<user>List all jsonrpc repositories</user>
	<response>Calls the search repositories tool with query: "jsonrpc"</response>
</example>
</examples>
`

export const bitbucketSearchRepositoriesToolReg: ToolRegistration<SearchRepositoriesToolDef> = {
	spec: {
		name: 'search_repositories',
		description,
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description:
						'Search query - keywords to match in repository name, slug, or description. Include project name to filter by project.',
				},
				limit: {
					type: 'number',
					description: 'Maximum number of results to return (default: 30)',
					minimum: 1,
					maximum: 100,
				},
			},
			required: ['query'],
		},
		source: 'builtin',
	},
	fn: bitbucketSearchRepositoriesTool,
}
