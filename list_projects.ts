import { Observable } from '@sourcegraph/observable'

import { fetchFromBitbucketAPI } from '../../../external-services/bitbucket/fetch-from-bitbucket-api'
import { BITBUCKET_SEARCH_LIST_PROJECTS_TOOL_NAME } from '../../names'
import type { ToolRegistration, ToolRun } from '../../tool-service'

type ListProjectsToolArgs = {
	pattern?: string
	limit?: number
	offset?: number
}

type ProjectResult = {
	key: string
	name: string
	description: string | null
	isPublic: boolean
	type: string
}

type ListProjectsToolDef = {
	name: typeof BITBUCKET_SEARCH_LIST_PROJECTS_TOOL_NAME
	args: ListProjectsToolArgs
	progress: string[]
	result: {
		projects: ProjectResult[]
		totalCount: number
	}
	error: { message: string }
}

interface BitbucketProject {
	key: string
	id: number
	name: string
	description?: string
	public: boolean
	type: string
	links: {
		self: Array<{ href: string }>
	}
}

interface BitbucketPaginatedResponse<T> {
	values: T[]
	size: number
	isLastPage: boolean
	start?: number
	limit?: number
	nextPageStart?: number
}

/**
 * List projects tool implementation for Bitbucket
 */
const bitbucketListProjectsTool: NonNullable<ToolRegistration<ListProjectsToolDef>['fn']> = (
	{ args },
	{ configService },
): Observable<ToolRun<ListProjectsToolDef>> => {
	const { pattern, limit = 30, offset = 0 } = args

	return new Observable<ToolRun<ListProjectsToolDef>>((observer) => {
		const abortController = new AbortController()

		// Validate that offset is divisible by limit for clean pagination
		if (offset % limit !== 0) {
			observer.next({
				status: 'error' as const,
				error: {
					message: `offset (${offset}) must be divisible by limit (${limit}) for pagination. Try offset values like 0, ${limit}, ${limit * 2}, etc.`,
				},
			})
			observer.complete()
			return
		}

		const executeSearch = async (): Promise<void> => {
			try {
				const config = await configService.getLatest(abortController.signal)

				observer.next({
					status: 'in-progress' as const,
					progress: [`Fetching projects${pattern ? ` matching "${pattern}"` : ''}...`],
				})

				// Build the API path - Bitbucket Server API
				// Note: We fetch all projects and filter client-side to support description search
				const apiPath = `rest/api/1.0/projects?limit=${limit}&start=${offset}`

				const response = await fetchFromBitbucketAPI<
					BitbucketPaginatedResponse<BitbucketProject>
				>(apiPath, { signal: abortController.signal }, config)

				if (!response.ok || !response.data) {
					observer.next({
						status: 'error' as const,
						error: {
							message: `Failed to fetch projects: ${response.status} ${response.statusText || 'Unknown error'}`,
						},
					})
					observer.complete()
					return
				}

				let projects = response.data.values

				// Apply pattern filter client-side to search both name and description
				if (pattern) {
					try {
						const regex = new RegExp(pattern, 'i')
						projects = projects.filter(
							(project) =>
								regex.test(project.name) ||
								regex.test(project.key) ||
								(project.description && regex.test(project.description)),
						)
					} catch {
						// If regex is invalid, fall back to case-insensitive substring match
						const lowerPattern = pattern.toLowerCase()
						projects = projects.filter(
							(project) =>
								project.name.toLowerCase().includes(lowerPattern) ||
								project.key.toLowerCase().includes(lowerPattern) ||
								(project.description &&
									project.description.toLowerCase().includes(lowerPattern)),
						)
					}
				}

				// Transform to our result format
				const results: ProjectResult[] = projects.map((project) => ({
					key: project.key,
					name: project.name,
					description: project.description || null,
					isPublic: project.public,
					type: project.type,
				}))

				const result = {
					projects: results,
					totalCount: response.data.size || results.length,
				}

				observer.next({
					status: 'done' as const,
					result,
				})
				observer.complete()
			} catch (error) {
				observer.next({
					status: 'error' as const,
					error: {
						message: `Error fetching projects: ${error instanceof Error ? error.message : String(error)}`,
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
List projects from Bitbucket.

WHEN TO USE THIS TOOL:
- When you need to find projects in Bitbucket
- When you need project metadata (key, name, description)
- When you want to list all projects the user has access to
- Before listing repositories to understand the project structure

FEATURES:
- List all projects accessible to the user
- Search by regex pattern across project names, keys, and descriptions
- Returns project metadata including descriptions
- Pagination support

PARAMETERS:
- pattern: Optional regex pattern to match in project names, keys, or descriptions (case-insensitive, falls back to substring match if invalid regex)
- limit: Maximum number of projects to return (default: 30, max: 100)
- offset: Number of results to skip for pagination (must be divisible by limit)

RESULT STRUCTURE:
The tool returns:
- projects: Array of project objects with key, name, description, and visibility
- totalCount: Total number of projects found

Each project includes:
- key: The unique project key (e.g., "PROJ")
- name: The display name of the project
- description: The project description (may be null)
- isPublic: Whether the project is public
- type: The project type (typically "NORMAL")

<examples>
<example>
	<user>List all Bitbucket projects</user>
	<response>Calls the list_projects tool without any parameters</response>
</example>
<example>
	<user>Find projects with "platform" in the name</user>
	<response>Calls the list_projects tool with pattern: "platform"</response>
</example>
<example>
	<user>Show me the next page of projects</user>
	<response>Calls the list_projects tool with offset: 30 (assuming default limit)</response>
</example>
</examples>
`

export const bitbucketListProjectsToolReg: ToolRegistration<ListProjectsToolDef> = {
	spec: {
		name: BITBUCKET_SEARCH_LIST_PROJECTS_TOOL_NAME,
		description,
		inputSchema: {
			type: 'object',
			properties: {
				pattern: {
					type: 'string',
					description:
						'Optional regex pattern to match in project names, keys, or descriptions (case-insensitive)',
				},
				limit: {
					type: 'number',
					description: 'Maximum number of projects to return (default: 30, max: 100)',
					minimum: 1,
					maximum: 100,
				},
				offset: {
					type: 'number',
					description:
						'Number of results to skip for pagination (default: 0). Must be divisible by limit.',
					minimum: 0,
				},
			},
			required: [],
		},
		source: 'builtin',
	},
	fn: typeof process !== 'undefined' ? bitbucketListProjectsTool : null,
}
