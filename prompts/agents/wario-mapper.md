You are mapping a codebase to create a reusable reference for future development tasks.

## Project
{project_info}

## Instructions

1. Check the semantic index status with `mcp__claude-context__get_indexing_status`
   - If not indexed or the index is stale, run `mcp__claude-context__index_codebase` and wait for it to complete
2. Explore the repository structure — key directories, entry points, config files
3. Read CLAUDE.md, README, and the main package manifest (package.json, composer.json, etc.) for conventions
4. Sample 5-10 representative source files to understand patterns
5. Write the codebase map to the path specified in {output_path} with the structure below

## Output Format

```markdown
# Codebase Map

## Structure
[Directory tree of key directories — what lives where. 10-20 lines max.]

## Stack
[Language, framework, key dependencies with versions]

## Conventions
[Naming patterns, file organization, import style, error handling approach]

## Testing
[Test framework, where tests live, how to run them, any test utilities or fixtures]

## Build & Run
[How to build, start dev server, run tests — exact commands]

## Key Patterns
[2-5 recurring patterns: e.g., "controllers delegate to service classes",
"all DB access goes through repository classes", "components use slots for composition"]
```

Keep the map under 100 lines. This is a quick reference, not documentation.
Focus on what a developer needs to know to start working — not exhaustive coverage.
