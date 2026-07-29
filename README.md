# NDE Stack

Mapping pipelines that project heritage collections into the NDE application
profiles, built on [LDElements](https://github.com/ldelements/lde).

This is an [Nx](https://nx.dev) monorepo using pnpm workspaces:

- **`packages/*`** – libraries published to npm under the `@ndes` scope.

## Layout

| Project                         | Path                               | Notes                                                        |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `@ndes/linked-art-to-schema-ap` | `packages/linked-art-to-schema-ap` | projects Linked Art (CIDOC-CRM) into the SCHEMA-AP-NDE pivot |

## Develop

```sh
pnpm install                                   # install dependencies (also sets up husky hooks)
pnpm exec nx test linked-art-to-schema-ap      # run one project’s tests
pnpm exec nx run-many -t test                  # or: pnpm test — run every project’s tests
```

Common per-project targets: `build`, `test`, `typecheck`, `lint`.

## Validate

Before committing, run the full checks across all projects (this is what CI
runs):

```sh
pnpm exec nx run-many -t lint typecheck test build
```

## Add a package

```sh
pnpm exec nx g @nx/js:lib packages/<name> --importPath=@ndes/<name>
```

Name mapping packages `<source>-to-<target>`, for example
`linked-art-to-schema-ap`.

## Release

Packages are versioned and published to npm on every push to `main` by
`.github/workflows/release.yml`, using
[Nx release](https://nx.dev/features/manage-releases) with conventional commits.
Each package is versioned independently; a breaking change must be marked with
`!` or a `BREAKING CHANGE:` footer.

To preview a release locally:

```sh
pnpm exec nx release --dry-run
```

## Maintenance

- Nx itself is upgraded by the nightly `.github/workflows/nx-migrate.yml`
  workflow, which runs `nx migrate latest` and opens a pull request.
- Other dependencies are updated by Dependabot; its pull requests are
  auto-merged once CI passes.
