import { toFilePathOrURI, toURIString, URI } from '@sourcegraph/amp-uri'
import { Observable } from '@sourcegraph/observable'

import { fetchFromBitbucketAPI } from '../../../external-services/bitbucket/fetch-from-bitbucket-api'
import { BITBUCKET_SEARCH_READ_TOOL_NAME } from '../../names'
import type { ToolRegistration, ToolRun } from '../../tool-service'
import type { ReadToolDef } from '../filesystem/read'

export type BitbucketReadToolArgs = {
	project: string
	repository: string
	path: string
	read_range?: [number, number]
}

export type BitbucketReadToolDef = {
	name: typeof BITBUCKET_SEARCH_READ_TOOL_NAME
	args: BitbucketReadToolArgs
	result: ReadToolDef['result']
	error: { message: string }
}

/**
 * Bitbucket Read tool implementation
 */
export const bitbucketReadTool: NonNullable<ToolRegistration<BitbucketReadToolDef>['fn']> = (
	{ args },
	{ configService },
): Observable<ToolRun<BitbucketReadToolDef>> => {
	const { project, repository, path, read_range } = args

	return new Observable<ToolRun<BitbucketReadToolDef>>((observer) => {
		const abortController = new AbortController()

		observer.next({
			status: 'in-progress' as const,
			progress: [`Reading file "${path}" from ${project}/${repository}...`],
		})

		// Convert path to relative path within the repository
		let relativePath = path

		// Remove file:// prefix if present
		if (relativePath.startsWith('file://')) {
			relativePath = relativePath.slice(7)
		}

		// Remove project/repo prefix if present
		const prefix = `/${project}/${repository}/`
		if (relativePath.startsWith(prefix)) {
			relativePath = relativePath.slice(prefix.length)
		}

		// Remove leading slash
		if (relativePath.startsWith('/')) {
			relativePath = relativePath.slice(1)
		}

		// Use Bitbucket Server API to read file contents
		// The raw endpoint returns raw file content at a specific ref
		const bitbucketPath = `rest/api/1.0/projects/${project}/repos/${repository}/raw/${relativePath}?at=HEAD`

		configService
			.getLatest(abortController.signal)
			.then((config) =>
				fetchFromBitbucketAPI<string>(
					bitbucketPath,
					{ signal: abortController.signal },
					config,
				),
			)
			.then((response) => {
				if (!response.ok) {
					observer.next({
						status: 'error' as const,
						error: {
							message: `Failed to read file: ${response.status} ${response.statusText || 'Unknown error'}`,
						},
					})
					observer.complete()
					return
				}

				// Bitbucket returns raw file content as text
				const content = response.text || ''

				// Split content into lines and add line numbers
				const lines = content.split('\n')

				// Apply read_range if specified
				let startLine = 1
				let endLine = lines.length

				if (read_range) {
					startLine = Math.max(1, read_range[0])
					endLine = Math.min(lines.length, read_range[1])
				}

				// Create line-numbered content
				const numberedLines = lines
					.slice(startLine - 1, endLine)
					.map((line, idx) => `${startLine + idx}: ${line}`)
					.join('\n')

				// Create file URI
				const fileUri = toFilePathOrURI(
					toURIString(
						URI.from({
							scheme: 'file',
							path: `/${project}/${repository}/${relativePath}`,
						}),
					),
				)

				observer.next({
					status: 'done' as const,
					result: {
						absolutePath: fileUri,
						content: numberedLines,
						contentURL: undefined,
					},
				})
				observer.complete()
			})
			.catch((error: Error) => {
				observer.next({
					status: 'error' as const,
					error: { message: `Error reading file: ${error.message || String(error)}` },
				})
				observer.complete()
			})

		return () => abortController.abort()
	})
}

const description = `
Read file contents from a Bitbucket repository.

This tool fetches the raw content of a file from a Bitbucket repository using the Bitbucket Server API.
Files are returned with line numbers for easy reference.

WHEN TO USE THIS TOOL:
- When you need to read the contents of a specific file in a Bitbucket repository
- When you want to examine code or configuration files
- When you need to understand file contents with line number references

PARAMETERS:
- project: The Bitbucket project ID (required)
- repository: The repository slug (required)
- path: The file path within the repository (required)
- read_range: Optional [startLine, endLine] to read only a portion of the file

NOTE: Reads from the repository's default branch automatically.

The tool returns file contents with line numbers.

RESULT STRUCTURE:
The tool returns:
- type: 'file'
- absolutePath: The file URI
- content: File content with line numbers
- contentURL: undefined

<examples>
<example>
	<user>Read the README.md file from project "myproject" repository "myrepo"</user>
	<response>Calls the read tool with project: "myproject", repository: "myrepo", path: "README.md"</response>
</example>
<example>
	<user>Read lines 10-50 of src/main.ts</user>
	<response>Calls the read tool with project: "myproject", repository: "myrepo", path: "src/main.ts", read_range: [10, 50]</response>
</example>
<example>
	<user>Show me the package.json file</user>
	<response>Calls the read tool with project: "myproject", repository: "myrepo", path: "package.json"</response>
</example>
</examples>
`

export const bitbucketReadToolReg: ToolRegistration<BitbucketReadToolDef> = {
	spec: {
		name: BITBUCKET_SEARCH_READ_TOOL_NAME,
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
				path: {
					type: 'string',
					description: 'The file path within the repository',
				},
				read_range: {
					type: 'array',
					description:
						'Optional [startLine, endLine] to read only a portion of the file (1-indexed)',
					items: { type: 'number' },
					minItems: 2,
					maxItems: 2,
				},
			},
			required: ['project', 'repository', 'path'],
		},
		source: 'builtin',
	},
	fn: typeof process !== 'undefined' ? bitbucketReadTool : null,
}
