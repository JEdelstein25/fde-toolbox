import { toFilePathOrURI, toURIString, URI } from '@sourcegraph/amp-uri'
import { Observable } from '@sourcegraph/observable'
import picomatch from 'picomatch/posix'

import {
	type BitbucketAPIResponse,
	fetchFromBitbucketAPI,
} from '../../../external-services/bitbucket/fetch-from-bitbucket-api'
import { BITBUCKET_SEARCH_GLOB_TOOL_NAME } from '../../names'
import type { ToolRegistration, ToolRun } from '../../tool-service'

export type BitbucketGlobToolArgs = {
	project: string
	repository: string
	filePattern: string
	limit?: number
	offset?: number
}

export type BitbucketGlobToolDef = {
	name: typeof BITBUCKET_SEARCH_GLOB_TOOL_NAME
	args: BitbucketGlobToolArgs
	result: string[]
	error: { message: string }
}

interface BitbucketFileItem {
	path: {
		components: string[]
		toString: string
	}
	type: 'FILE' | 'DIRECTORY'
}

interface BitbucketBrowseResponse {
	children: {
		values: BitbucketFileItem[]
		size: number
		isLastPage: boolean
		start: number
		limit: number
		nextPageStart?: number
	}
}

/**
 * Bitbucket Glob tool implementation
 */
export const bitbucketGlobTool: NonNullable<ToolRegistration<BitbucketGlobToolDef>['fn']> = (
	{ args },
	{ configService },
): Observable<ToolRun<BitbucketGlobToolDef>> => {
	const { project, repository, filePattern, limit = 100, offset = 0 } = args

	return new Observable<ToolRun<BitbucketGlobToolDef>>((observer) => {
		const abortController = new AbortController()

		observer.next({
			status: 'in-progress' as const,
			progress: [`Finding files matching "${filePattern}" in ${project}/${repository}...`],
		})

		const fetchAllFiles = async (
			config: Awaited<ReturnType<typeof configService.getLatest>>,
		): Promise<string[]> => {
			const allFiles: string[] = []

			// Recursively fetch files from directories
			const fetchDirectory = async (path: string = ''): Promise<void> => {
				let start = 0
				const limit = 1000
				let isLastPage = false

				while (!isLastPage) {
					// Bitbucket Server API path for browsing repository files
					const apiPath = `rest/api/1.0/projects/${project}/repos/${repository}/browse${path ? `/${path}` : ''}?limit=${limit}&start=${start}`

					const response: BitbucketAPIResponse<BitbucketBrowseResponse> =
						await fetchFromBitbucketAPI<BitbucketBrowseResponse>(
							apiPath,
							{ signal: abortController.signal },
							config,
						)

					if (!response.ok || !response.data) {
						// Some directories may not be accessible or may not exist
						// Skip them and continue with other directories
						return
					}

					const items = response.data.children.values

					// Process each item
					for (const item of items) {
						// Build path from components
						const itemPath = item.path.components.join('/')

						if (item.type === 'FILE') {
							allFiles.push(itemPath)
						} else if (item.type === 'DIRECTORY') {
							// Recursively fetch subdirectory
							await fetchDirectory(itemPath)
						}
					}

					isLastPage = response.data.children.isLastPage
					if (!isLastPage && response.data.children.nextPageStart) {
						start = response.data.children.nextPageStart
					}
				}
			}

			await fetchDirectory()
			return allFiles
		}

		configService
			.getLatest(abortController.signal)
			.then((config) => fetchAllFiles(config))
			.then((filePaths) => {
				// Apply glob pattern matching
				const isMatch = picomatch(filePattern)
				const matchedFiles = filePaths.filter((p) => isMatch(p))

				// Apply pagination
				const paginatedFiles = limit
					? matchedFiles.slice(offset, offset + limit)
					: matchedFiles.slice(offset)

				// Convert to file URIs
				const files = paginatedFiles.map((path) => {
					const uri = URI.from({
						scheme: 'file',
						path: `/${project}/${repository}/${path}`,
					})
					return toFilePathOrURI(toURIString(uri))
				})

				observer.next({
					status: 'done' as const,
					result: files,
				})
				observer.complete()
			})
			.catch((error: Error) => {
				observer.next({
					status: 'error' as const,
					error: { message: `Error matching files: ${error.message || String(error)}` },
				})
				observer.complete()
			})

		return () => abortController.abort()
	})
}

const description = `Find files matching a glob pattern in a Bitbucket repository.

This tool fetches the file tree from a Bitbucket repository and matches files against
a glob pattern. The file manifest is fetched from Bitbucket's API without downloading
the entire repository.

WHEN TO USE THIS TOOL:
- When you need to find specific file types in a Bitbucket repository
- When you want to find files in specific directories or following specific patterns
- When you need to explore the repository structure quickly

PARAMETERS:
- project: The Bitbucket project ID (required)
- repository: The repository slug (required)
- filePattern: Glob pattern to match files (e.g., "**/*.ts", "src/**/*.test.js")
- limit: Maximum number of results to return (optional, default: 100)
- offset: Number of results to skip for pagination (optional)

NOTE: Searches the repository's default branch automatically.

The tool returns a list of file paths that match the specified pattern.

PATTERN EXAMPLES:
- \`**/*.js\` - All JavaScript files in any directory
- \`src/**/*.ts\` - All TypeScript files under the src directory
- \`*.json\` - All JSON files in the root directory
- \`**/*test*\` - All files with "test" in their name
- \`**/*.{js,ts}\` - All JavaScript and TypeScript files
- \`src/[a-z]*/*.ts\` - TypeScript files in src subdirectories starting with lowercase letters

<examples>
<example>
	<user>Find all TypeScript test files in project "myproject" repository "myrepo"</user>
	<response>Calls the glob tool with project: "myproject", repository: "myrepo", filePattern: "**/*.test.ts"</response>
</example>
<example>
	<user>List all configuration files in the root of "myproject/myrepo"</user>
	<response>Calls the glob tool with project: "myproject", repository: "myrepo", filePattern: "*.{json,yaml,yml,toml}"</response>
</example>
<example>
	<user>Find React components in "myproject/myrepo"</user>
	<response>Calls the glob tool with project: "myproject", repository: "myrepo", filePattern: "**/*.tsx"</response>
</example>
</examples>
`

export const bitbucketGlobToolReg: ToolRegistration<BitbucketGlobToolDef> = {
	spec: {
		name: BITBUCKET_SEARCH_GLOB_TOOL_NAME,
		description,
		inputSchema: {
			type: 'object',
			properties: {
				project: {
					type: 'string',
					description: 'The Bitbucket project ID',
				},
				repository: {
					type: 'string',
					description: 'The repository slug',
				},
				filePattern: {
					type: 'string',
					description:
						'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.test.js")',
				},
				limit: {
					type: 'number',
					description: 'Maximum number of results to return (default: 100)',
				},
				offset: {
					type: 'number',
					description: 'Number of results to skip for pagination',
				},
			},
			required: ['project', 'repository', 'filePattern'],
		},
		source: 'builtin',
	},
	fn: typeof process !== 'undefined' ? bitbucketGlobTool : null,
}
